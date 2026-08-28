import { CMD, MAX_CHUNK } from '../codec/commands.js'
import { ZkProtocolError } from '../errors.js'
import type { Session } from './Session.js'

/**
 * Reads a bulk payload the legacy way, which older firmware understands.
 *
 * The device answers either ACK_DATA with the whole body inline, or
 * PREPARE_DATA announcing a size, then a run of CMD_DATA packets, then ACK_OK.
 * The returned stream begins with its own 4-byte little-endian totalSize
 * header — the record parsers expect that header and validate against it.
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
  const chunks: Buffer[] = []
  let received = 0

  // Strictly sequential: each receiveMore() is awaited before the next is
  // issued, because the transport rejects a second receive() while one is
  // already pending.
  while (received < declared) {
    const packet = await session.receiveMore()
    if (packet.command === CMD.DATA) {
      chunks.push(packet.data)
      received += packet.data.length
      continue
    }
    // Anything other than a DATA packet before the declared size is reached
    // means the transfer ended early. Returning what arrived so far would
    // hand the record parser a body that looks complete but isn't — it must
    // throw instead of returning a short body.
    throw new ZkProtocolError(
      `transfer ended after ${received} of ${declared} bytes with command ${packet.command}`,
    )
  }

  // The device closes the run with an acknowledgement.
  const tail = await session.receiveMore()
  if (tail.command !== CMD.ACK_OK) {
    throw new ZkProtocolError(`expected ACK_OK to close the transfer, got ${tail.command}`)
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}

/**
 * Releases the device-side buffer. Best effort: the read already succeeded
 * and the caller already holds the data, so a failure here must not discard
 * it — it's cleanup, not part of the result.
 *
 * Only `ZkProtocolError` is swallowed here — it proves the device answered
 * (with CMD_ACK_ERROR), so the reply was consumed and the session is still
 * in sync. `ZkTimeoutError` and `ZkConnectionError` must propagate: a timeout
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
    if (!(err instanceof ZkProtocolError)) throw err
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
