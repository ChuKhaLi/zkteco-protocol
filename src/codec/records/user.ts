import { ZkFramingError } from '../../errors.js'
import type { ZkUser } from '../../types.js'
import { readNulTerminated } from './shared.js'

export const USER_RECORD_SIZE = 72

function decodeOne(rec: Buffer): ZkUser {
  const hasPassword = readNulTerminated(rec, 3, 8).length > 0

  // Zero the password field before hex-encoding for `raw`. The password field
  // occupies bytes 3–10; we redact it here because `raw` is meant to be
  // persisted and forwarded for reconciliation, and a credential must not ride
  // along with that data. This means `raw` is not a byte-for-byte copy of the
  // record.
  const rawBuffer = Buffer.from(rec)
  rawBuffer.fill(0, 3, 11)

  return {
    uid: rec.readUInt16LE(0),
    privilege: rec.readUInt8(2),
    hasPassword,
    name: readNulTerminated(rec, 11, 24),
    cardNumber: rec.readUInt32LE(35),
    userId: readNulTerminated(rec, 48, 8),
    raw: rawBuffer.toString('hex'),
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
