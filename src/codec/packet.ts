import { checksum16 } from './checksum.js'
import { ZkProtocolError } from '../errors.js'

const HEADER_SIZE = 8
const EMPTY = Buffer.alloc(0)

export interface PacketFields {
  command: number
  sessionId: number
  replyId: number
  data?: Buffer
}

export interface DecodedPacket {
  command: number
  checksum: number
  sessionId: number
  replyId: number
  data: Buffer
}

/** Builds a payload whose checksum is computed correctly over THIS reply id. */
export function encodePayload({ command, sessionId, replyId, data = EMPTY }: PacketFields): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + data.length)
  buf.writeUInt16LE(command & 0xffff, 0)
  buf.writeUInt16LE(0, 2)
  buf.writeUInt16LE(sessionId & 0xffff, 4)
  buf.writeUInt16LE(replyId & 0xffff, 6)
  data.copy(buf, HEADER_SIZE)
  buf.writeUInt16LE(checksum16(buf), 2)
  return buf
}

export function decodePayload(buf: Buffer): DecodedPacket {
  if (buf.length < HEADER_SIZE) {
    throw new ZkProtocolError(`payload shorter than the ${HEADER_SIZE}-byte header`, buf)
  }
  return {
    command: buf.readUInt16LE(0),
    checksum: buf.readUInt16LE(2),
    sessionId: buf.readUInt16LE(4),
    replyId: buf.readUInt16LE(6),
    data: Buffer.from(buf.subarray(HEADER_SIZE)),
  }
}

/**
 * Overwrites the reply-id field on an already-encoded payload and does NOT
 * recompute the checksum. The transmitted packet therefore carries a checksum
 * that disagrees with its own contents.
 *
 * UNUSED BY THIS LIBRARY, deliberately. The protocol documentation this
 * project was built from asserts that devices expect exactly this mismatch.
 * Captured wire bytes say otherwise: two independent third-party
 * implementations, driven as black boxes over both transports, emit checksums
 * matching the reply id they actually transmit.
 *
 *   pyzk      cmd 1001 rid 1: observed 56551, self 56551, previous 56552
 *   zkteco-js cmd 1000 rid 1: observed 64534, self 64534, previous 64535
 *   zkteco-js cmd 1001 rid 2: observed 56550, self 56550, previous 56551
 *
 * The two start their reply-id counters at different values, so that is
 * agreement across different data rather than a coincidence. `Session` was
 * changed to transmit the payload unmodified.
 *
 * This function is kept exported and tested because the evidence is only two
 * implementations and a handshake — no physical device has ever been observed.
 * If the first real terminal refuses self-consistent packets, this is one call
 * site away in `Session.send`. See the first-hardware checklist in the design
 * spec. Do not delete it, and do not wire it back in without new evidence.
 */
export function applyReplyIdQuirk(payload: Buffer, wireReplyId: number): Buffer {
  const out = Buffer.from(payload)
  out.writeUInt16LE(wireReplyId & 0xffff, 6)
  return out
}
