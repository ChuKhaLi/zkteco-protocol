import { CMD } from '../codec/commands.js'
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
 */
async function freeBuffer(session: Session): Promise<void> {
  try {
    await session.execute(CMD.FREE_DATA)
  } catch {
    // Releasing the device-side buffer is best effort; failing to do so must
    // not discard data the caller already has in hand.
  }
}
