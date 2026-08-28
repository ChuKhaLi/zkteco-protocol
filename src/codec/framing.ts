import { ZkProtocolError } from '../errors.js'
import { MAX_CHUNK } from './commands.js'

/**
 * The 4 bytes that open every TCP packet, in wire order.
 *
 * Some reference implementations carry a source comment naming this 0x7282
 * while their own constant holds 32130 = 0x7D82. Trust the value, not the
 * comment: on the wire the bytes are 50 50 82 7D.
 */
export const START_MARKER = Buffer.from([0x50, 0x50, 0x82, 0x7d])

const TCP_PREFIX_SIZE = 8

/**
 * Upper bound on a declared TCP payload size. Wider than the largest chunk
 * this library ever requests (`MAX_CHUNK.tcp`), by the same margin as the
 * packet header, to leave room for whatever a device legitimately sends
 * without accepting an arbitrary uint32.
 */
const MAX_DECLARED_SIZE = MAX_CHUNK.tcp + 8

/** Wraps a payload for TCP. UDP sends the bare payload and never calls this. */
export function frameTcp(payload: Buffer): Buffer {
  const head = Buffer.alloc(TCP_PREFIX_SIZE)
  START_MARKER.copy(head, 0)
  head.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/**
 * Attempts to read one framed packet from the front of an accumulating buffer.
 * Returns null when more bytes are still needed — TCP splits and coalesces
 * freely, so a caller must be able to wait rather than fail.
 */
export function tryUnframeTcp(buf: Buffer): { payload: Buffer; consumed: number } | null {
  if (buf.length < TCP_PREFIX_SIZE) return null
  if (!buf.subarray(0, 4).equals(START_MARKER)) {
    throw new ZkProtocolError('TCP start marker mismatch', buf.subarray(0, 8))
  }
  const size = buf.readUInt32LE(4)
  // An unbounded declared size means a single corrupt length prefix wedges
  // the connection permanently: TcpTransport.absorb() would keep waiting for
  // `size` bytes that never arrive, concatenating every further chunk into
  // an ever-growing buffer while every receive() times out from here on.
  // Reject before that accumulation starts (spec §5.3: "declared payload
  // size matches actual length").
  if (size > MAX_DECLARED_SIZE) {
    throw new ZkProtocolError(
      `TCP declared payload size ${size} exceeds the ${MAX_DECLARED_SIZE}-byte maximum`,
      buf.subarray(0, 8),
    )
  }
  if (buf.length < TCP_PREFIX_SIZE + size) return null
  return {
    payload: Buffer.from(buf.subarray(TCP_PREFIX_SIZE, TCP_PREFIX_SIZE + size)),
    consumed: TCP_PREFIX_SIZE + size,
  }
}
