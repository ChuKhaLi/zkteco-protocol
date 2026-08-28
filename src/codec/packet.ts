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
 * This looks like a defect and is not treated as one: implementations behaving
 * this way have worked against real hardware for years, so it appears to be
 * what devices expect. This function exists precisely so the behaviour cannot
 * be invisible — do not "fix" it by calling encodePayload again.
 */
export function applyReplyIdQuirk(payload: Buffer, wireReplyId: number): Buffer {
  const out = Buffer.from(payload)
  out.writeUInt16LE(wireReplyId & 0xffff, 6)
  return out
}
