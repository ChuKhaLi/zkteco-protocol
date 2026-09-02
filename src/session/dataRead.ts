import { CMD, MAX_CHUNK } from '../codec/commands.js'
import type { DecodedPacket } from '../codec/packet.js'
import { ZkAuthError, ZkProtocolError } from '../errors.js'
import type { Session } from './Session.js'

/**
 * Reads one transfer: an optional CMD_PREPARE_DATA announcement, a run of
 * CMD_DATA packets, then ACK_OK. Every CMD_DATA packet is consumed — the run
 * ends only at the first non-DATA packet — and the accumulated total is then
 * compared against `expected`, so a device that keeps sending CMD_DATA past
 * the point a shorter run would have looked complete is still caught.
 *
 * Shared by the legacy exchange (one transfer per read) and, since v0.5, by
 * the buffered exchange (one transfer per READ_BUFFER chunk), because that is
 * the shape the readable reference handles: zkteco-js's UDP chunk handler
 * ignores PREPARE_DATA, appends DATA, and completes on ACK_OK once the total
 * matches the size IT computed (zudp.js:335-350); its TCP handler is
 * command-agnostic and skips the first eight accumulated bytes, which is the
 * announcement arriving through the same accumulator (ztcp.js:389-395).
 * Nothing in the announcement is interpreted here either — `expected` comes
 * from the caller, who knows it from its own request.
 *
 * `first` is a packet the caller already consumed (an execute() reply); it is
 * treated as the first packet of the transfer.
 *
 * Refuses, as ZkProtocolError: an ACK_OK before `expected` bytes (where the
 * reference would sit until its timer fired, this says so at once), a total
 * past `expected` (the record parsers only reject a body that is too SHORT,
 * so an oversized one would lose its tail silently), and any other command.
 */
export async function readTransfer(
  session: Session,
  expected: number,
  first?: DecodedPacket,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  let pending: DecodedPacket | null = first ?? null
  const next = async (): Promise<DecodedPacket> => {
    if (pending) {
      const p = pending
      pending = null
      return p
    }
    return session.receiveMore()
  }

  const opening = await next()
  // No announcement: the packet belongs to the loop below.
  if (opening.command !== CMD.PREPARE_DATA) pending = opening

  // Strictly sequential: the session allows one exchange at a time. Consumes
  // every CMD_DATA packet in a row rather than stopping the instant the
  // running total reaches `expected` — a device with more to send is still
  // sending CMD_DATA, whether the excess lands within one oversized packet or
  // as a separate packet arriving right after a transfer that already looked
  // complete. Both must be caught here rather than mistaken for the close.
  let tail: DecodedPacket
  for (;;) {
    const packet = await next()
    if (packet.command !== CMD.DATA) {
      tail = packet
      break
    }
    chunks.push(packet.data)
    received += packet.data.length
  }

  if (received < expected) {
    throw new ZkProtocolError(
      `transfer ended after ${received} of ${expected} bytes with command ${tail.command}`,
    )
  }
  if (received > expected) {
    throw new ZkProtocolError(`transfer delivered ${received} bytes, expected ${expected}`)
  }
  if (tail.command !== CMD.ACK_OK) {
    throw new ZkProtocolError(`expected ACK_OK to close the transfer, got ${tail.command}`)
  }
  return Buffer.concat(chunks)
}

/**
 * Reads a bulk payload the legacy way, which older firmware understands.
 *
 * The device answers either ACK_DATA with the whole body inline, or
 * PREPARE_DATA announcing a size, then a run of CMD_DATA packets, then ACK_OK.
 * The returned stream begins with its own 4-byte little-endian totalSize
 * header — the record parsers expect that header and validate against it.
 *
 * The size in a legacy PREPARE_DATA is read at offset 0, as it always was; no
 * reference exists to compare against (spec §6.4).
 */
export async function readBulkLegacy(session: Session, command: number): Promise<Buffer> {
  const res = await session.execute(command)

  if (res.command === CMD.ACK_DATA) {
    await freeBuffer(session)
    return res.data
  }

  if (res.command !== CMD.PREPARE_DATA) {
    throw new ZkProtocolError(
      `expected ACK_DATA or PREPARE_DATA for command ${command}, got ${res.command}`,
      res.data,
    )
  }
  if (res.data.length < 4) {
    throw new ZkProtocolError('PREPARE_DATA did not carry a size', res.data)
  }

  const declared = res.data.readUInt32LE(0)
  const body = await readTransfer(session, declared)
  await freeBuffer(session)
  return body
}

/**
 * Releases the device-side buffer. Best effort: the read already succeeded
 * and the caller already holds the data, so a failure here must not discard
 * it — it's cleanup, not part of the result.
 *
 * `ZkProtocolError` and `ZkAuthError` are both swallowed here, and for one
 * reason rather than two: each proves the device ANSWERED — with
 * CMD_ACK_ERROR or CMD_ACK_UNAUTH — so the reply was consumed and the session
 * is still in sync. A device that permits a read but refuses the cleanup that
 * follows it must not cost the caller a transfer that already completed.
 * ZkAuthError needs saying separately only because `Session.execute` raises
 * it as a sibling of ZkProtocolError rather than a subtype, which is
 * deliberate — see `readBulk` below, where the distinction is load-bearing.
 *
 * `ZkTimeoutError` and `ZkConnectionError` must propagate: a timeout
 * means FREE_DATA's reply never arrived by the deadline, but it can still
 * arrive later and sit in the transport queue. Swallowing that would let the
 * next command's `receive()` consume FREE_DATA's late reply instead of its
 * own — every reply after that is then off by one, and in a legacy
 * multi-chunk read a one-packet shift still satisfies `detectRecordSize`
 * (same byte count, wrong bytes), which is exactly the misaligned parse this
 * library exists to prevent.
 */
async function freeBuffer(session: Session): Promise<void> {
  try {
    await session.execute(CMD.FREE_DATA)
  } catch (err) {
    if (err instanceof ZkProtocolError || err instanceof ZkAuthError) return
    throw err
  }
}

/**
 * Reads a bulk payload through the buffered commands.
 *
 * _CMD_PREPARE_BUFFER (1503) and _CMD_READ_BUFFER (1504) are undocumented by
 * the vendor. The request shapes here follow published protocol write-ups and
 * are unverified against hardware, which is exactly why `readBulk` keeps the
 * legacy path as a fallback rather than treating a refusal as fatal.
 */
export async function readBulkBuffered(
  session: Session,
  command: number,
  maxChunk: number,
): Promise<Buffer> {
  // <int8 1><int16 command><int32 fct><int32 ext>
  const request = Buffer.alloc(11)
  request.writeUInt8(1, 0)
  request.writeUInt16LE(command, 1)
  request.writeUInt32LE(0, 3)
  request.writeUInt32LE(0, 7)

  const prepared = await session.execute(CMD.PREPARE_BUFFER, request)
  if (prepared.data.length < 4) {
    throw new ZkProtocolError('PREPARE_BUFFER did not report a size', prepared.data)
  }
  const total = prepared.data.readUInt32LE(0)

  const chunks: Buffer[] = []
  let offset = 0
  // Strictly sequential, same reasoning as readBulkLegacy: the transport
  // rejects a second receive() while one is already in flight.
  while (offset < total) {
    const want = Math.min(maxChunk, total - offset)
    const req = Buffer.alloc(8)
    req.writeUInt32LE(offset, 0)
    req.writeUInt32LE(want, 4)
    const res = await session.execute(CMD.READ_BUFFER, req)
    if (res.data.length === 0) {
      // A chunk that comes back empty before `total` bytes have arrived is a
      // transfer that ended early. Returning what arrived so far would hand
      // the record parser a body that looks complete but isn't.
      throw new ZkProtocolError(`READ_BUFFER returned nothing at offset ${offset}`)
    }
    chunks.push(res.data)
    offset += res.data.length
  }

  // The loop above only guards against a reply that stops short. A reply
  // that overshoots — more bytes than `want`, past `total` in aggregate — is
  // the mirror image: it exits the loop just as cleanly, and without this
  // check would hand back a silently oversized buffer instead of failing.
  if (offset !== total) {
    throw new ZkProtocolError(`READ_BUFFER delivered ${offset} bytes total, expected ${total}`)
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}

/**
 * Reads a bulk payload, preferring the buffered commands and falling back to
 * the legacy exchange when the device refuses them. Older firmware does not
 * implement 1503/1504 at all.
 *
 * Only `ZkProtocolError` triggers the fallback — that's what `Session.execute`
 * throws when the device answers CMD_ACK_ERROR, which is the signal that the
 * buffered commands were refused. `ZkConnectionError` and `ZkTimeoutError`
 * mean the socket dropped or the device went silent; retrying the whole read
 * down a different path would only double the wait before the caller learns
 * something went wrong, so those propagate unchanged.
 *
 * `ZkAuthError` propagates for a sharper reason, and it is why `Session.execute`
 * raises CMD_ACK_UNAUTH as a sibling class rather than a ZkProtocolError
 * subtype. Before v0.3.1 an ACK_UNAUTH reply to PREPARE_BUFFER failed
 * readBulkBuffered's 4-byte size check AS a ZkProtocolError — which is
 * exactly the signal this catch reads as "1503 unimplemented" — so an
 * authentication failure was diagnosed as a firmware capability and retried
 * down the legacy path. Whatever that path returns was produced after the
 * device said the session was not authorized, so it cannot be trusted
 * whether or not it looks complete. That it can look entirely complete is
 * demonstrated, not supposed: deleting the guard in Session.execute makes the
 * ACK_UNAUTH case in test/commands/users.spec.ts resolve with a full user
 * list instead of throwing.
 *
 * (Authorization is a property of the session rather than of one command, so
 * a device refusing PREPARE_BUFFER on those grounds has no evident reason to
 * answer the legacy request differently — but no device has been observed,
 * and nothing above rests on that inference.)
 */
export async function readBulk(
  session: Session,
  command: number,
  transport: 'tcp' | 'udp',
): Promise<Buffer> {
  try {
    return await readBulkBuffered(session, command, MAX_CHUNK[transport])
  } catch (err) {
    if (!(err instanceof ZkProtocolError)) throw err
    // A ZkProtocolError here can occur after PREPARE_BUFFER already
    // succeeded (e.g. a later READ_BUFFER failing the total-bytes check),
    // which leaves the device holding buffer state from the aborted
    // attempt. Release it before falling back.
    //
    // freeBuffer swallows only ZkProtocolError — it deliberately rethrows a
    // timeout or a dropped connection, because those leave a reply
    // unconsumed and the session desynchronised. So this call CAN throw, and
    // a FREE_DATA timeout during cleanup aborts the whole read rather than
    // continuing to the legacy path. That is intended: falling back across a
    // possible desync is worse than failing outright, since a one-packet
    // shift still satisfies the record-size check and produces misaligned
    // records no caller can distinguish from good ones. The cost is that
    // firmware answering an unknown 1503 with silence rather than an error
    // never reaches the legacy fallback — accepted, and worth revisiting
    // once a real device has been observed.
    await freeBuffer(session)
    return readBulkLegacy(session, command)
  }
}
