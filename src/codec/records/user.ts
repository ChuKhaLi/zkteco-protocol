import { ZkFramingError } from '../../errors.js'
import type { ZkUser } from '../../types.js'

export const USER_RECORD_SIZE = 72

function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('ascii')
}

function decodeOne(rec: Buffer): ZkUser {
  return {
    uid: rec.readUInt16LE(0),
    privilege: rec.readUInt8(2),
    // Whether a password exists is useful; the password itself is never
    // surfaced, so it cannot leak into a log or an upstream payload.
    hasPassword: readNulTerminated(rec, 3, 8).length > 0,
    name: readNulTerminated(rec, 11, 24),
    cardNumber: rec.readUInt32LE(35),
    userId: readNulTerminated(rec, 48, 8),
    raw: rec.toString('hex'),
  }
}

/**
 * Decodes a user-list payload: a 4-byte little-endian totalSize followed by
 * fixed-width 72-byte records. Applies the same fail-loud policy as the
 * attendance parser — a body that is not a whole number of records is refused
 * rather than parsed into misaligned garbage.
 */
export function parseUserData(data: Buffer): ZkUser[] {
  if (data.length < 4) {
    throw new ZkFramingError('user payload too short to hold its size header', data)
  }
  const totalSize = data.readUInt32LE(0)
  if (data.length < 4 + totalSize) {
    throw new ZkFramingError(
      `user payload declares ${totalSize} bytes but only ${data.length - 4} arrived`,
      data.subarray(0, 16),
    )
  }
  const body = data.subarray(4, 4 + totalSize)
  if (body.length % USER_RECORD_SIZE !== 0) {
    throw new ZkFramingError(
      `user body of ${body.length} bytes is not a multiple of ${USER_RECORD_SIZE}`,
    )
  }
  const out: ZkUser[] = []
  for (let off = 0; off + USER_RECORD_SIZE <= body.length; off += USER_RECORD_SIZE) {
    out.push(decodeOne(body.subarray(off, off + USER_RECORD_SIZE)))
  }
  return out
}
