import { BUFFER_FCT, CMD, MAX_CHUNK } from '../codec/commands.js'
import type { DecodedPacket } from '../codec/packet.js'
import { ZkAuthError, ZkProtocolError } from '../errors.js'
import { type Session, unauthorizedReply } from './Session.js'

/**
 * Reads one transfer: an optional CMD_PREPARE_DATA announcement, a run of
 * CMD_DATA packets, then a closing command.
 *
 * Stopping rule: CMD_DATA packets are consumed unconditionally, one at a
 * time, until a non-DATA packet arrives — the running total is judged
 * against `expected` only once that terminator is in hand, never the instant
 * the total first reaches `expected`. A device with more to send is still
 * sending CMD_DATA, whether the excess lands inside one oversized packet or
 * as a further packet arriving right after a transfer that already looked
 * complete on its own; stopping early would let that later packet — or the
 * transfer's real terminator behind it — go unread, sitting in the transport
 * queue for the next request's receive() to collect instead of its own reply
 * (the same class of desync `freeBuffer`'s docblock below describes for
 * FREE_DATA). Every path through this function, success or refusal, reads
 * exactly one terminator and no further, so a refusal never leaves the
 * exchange mid-flight.
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
 * Refuses, as ZkProtocolError: a total short of `expected` when the run ends,
 * whether by an early ACK_OK or any other command (`"transfer ended after X
 * of Y bytes with command N"`); a total past `expected` (`"transfer delivered
 * X bytes, expected Y"` — the record parsers only reject a body that is too
 * SHORT, so an oversized one would lose its tail silently); and a total that
 * exactly matches `expected` but is closed by anything other than ACK_OK
 * (`"expected ACK_OK to close the transfer, got N"`).
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

  // Strictly sequential: the session allows one exchange at a time. See the
  // stopping rule above — every CMD_DATA packet is read before anything is
  // decided, so `tail` below is always the transfer's actual terminator.
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
 * Reads a bulk payload through the buffered commands, the way the readable
 * reference does (spec v0.5 §6.1; zkteco-js ztcp.js:320-462, zudp.js:283-360).
 *
 * _CMD_PREPARE_BUFFER (1503) and _CMD_READ_BUFFER (1504) are undocumented by
 * the vendor. Until v0.5 this library's model of them agreed with nothing but
 * its own emulator. Four points now follow the reference:
 *   1. the request's fct is per command (BUFFER_FCT);
 *   2. a CMD_DATA reply to PREPARE_BUFFER is the whole body; otherwise the
 *      total is the uint32 at data offset 1 (byte 0 is not interpreted);
 *   3. each READ_BUFFER is answered by a transfer — see readTransfer;
 *   4. no command is required beyond what the reference's UDP handler checks.
 *
 * Returns null when the device answers PREPARE_BUFFER with ACK_ERROR — the
 * one signal that this firmware does not implement 1503 — so readBulk can
 * fall back on exactly that and on nothing else. ACK_UNAUTH throws
 * ZkAuthError here for the reason Session.execute's docblock gives: this is
 * the one tryExecute caller that must not inherit the fallback.
 */
export async function readBulkBuffered(
  session: Session,
  command: number,
  maxChunk: number,
): Promise<Buffer | null> {
  // <int8 1><int16 command><int32 fct><int32 ext>
  const request = Buffer.alloc(11)
  request.writeUInt8(1, 0)
  request.writeUInt16LE(command, 1)
  request.writeUInt32LE(BUFFER_FCT[command] ?? 0, 3)
  request.writeUInt32LE(0, 7)

  const prepared = await session.tryExecute(CMD.PREPARE_BUFFER, request)
  if (prepared.command === CMD.ACK_ERROR) return null
  if (prepared.command === CMD.ACK_UNAUTH) {
    throw unauthorizedReply(CMD.PREPARE_BUFFER, prepared.data)
  }
  if (prepared.command === CMD.DATA) {
    await freeBuffer(session)
    return prepared.data
  }
  if (prepared.data.length < 5) {
    throw new ZkProtocolError('PREPARE_BUFFER did not report a size', prepared.data)
  }
  const total = prepared.data.readUInt32LE(1)

  const chunks: Buffer[] = []
  let offset = 0
  while (offset < total) {
    const want = Math.min(maxChunk, total - offset)
    const req = Buffer.alloc(8)
    req.writeUInt32LE(offset, 0)
    req.writeUInt32LE(want, 4)
    const opening = await session.execute(CMD.READ_BUFFER, req)
    const chunk = await readTransfer(session, want, opening)
    chunks.push(chunk)
    offset += chunk.length
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}

/**
 * Reads a bulk payload, preferring the buffered commands and falling back to
 * the legacy exchange when — and only when — the device answers
 * PREPARE_BUFFER with ACK_ERROR. Older firmware does not implement 1503/1504
 * at all, and that refusal is the one signal of it.
 *
 * Everything else propagates: a framing failure (the stream is misaligned;
 * the session has already ended), a malformed size reply, a chunk that stops
 * short or overshoots, a timeout, a dropped connection, and ACK_UNAUTH (the
 * device said this session is not authorized, and whatever the legacy path
 * returned after that could not be trusted whether or not it looked
 * complete). Until v0.5 the fallback fired on any ZkProtocolError from six
 * throw sites plus the unframer, which is how a misaligned TCP stream was
 * retried down the legacy path and reported as a firmware capability.
 *
 * Firmware answering an unknown 1503 with silence never reaches the fallback
 * — accepted, as before, and worth revisiting once a real device has been
 * observed.
 */
export async function readBulk(
  session: Session,
  command: number,
  transport: 'tcp' | 'udp',
): Promise<Buffer> {
  const buffered = await readBulkBuffered(session, command, MAX_CHUNK[transport])
  if (buffered !== null) return buffered
  return readBulkLegacy(session, command)
}
