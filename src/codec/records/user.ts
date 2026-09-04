import { ZkFramingError } from '../../errors.js'
import type { ZkUser } from '../../types.js'
import { readNulTerminated } from './shared.js'

export const USER_RECORD_SIZE = 72

/**
 * The other width the reference decodes over UDP (`zkteco-js`
 * helper/utils.js:114-126). This library has no decoder for it. The constant
 * exists so a refusal can name what it refused; adding a decoder would be a
 * new wire hypothesis and is out of scope (design §2.2).
 */
export const ALTERNATE_USER_RECORD_SIZE = 28

/**
 * lcm(72, 28). A body length divisible by both widths is a whole number of
 * records under either reading, so a division-free guard cannot tell them
 * apart: 504 bytes is seven 72-byte records or eighteen 28-byte ones. This is
 * the entire exposure -- every other length is decidable.
 */
export const AMBIGUOUS_USER_BODY_MODULUS = 504

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
    // Nine bytes, per zkteco-js helper/utils.js:143-144 (`slice(48, 48 + 9)`).
    // Eight, before v0.5, truncated a nine-digit id into a different identity.
    // PROVENANCE.md §User record width and size.
    userId: readNulTerminated(rec, 48, 9),
    raw: rawBuffer.toString('hex'),
  }
}

/**
 * Derives the user record width, by division against the device's own user
 * count where one is available.
 *
 * This is `detectRecordSize`'s technique (records/attendance.ts), applied to
 * the one bulk parser that never took a count. It reads no record bytes:
 * discriminating the widths from the bytes is a new wire hypothesis, and the
 * first hardware run is where that gets settled.
 *
 * Without a count the 72-byte read continues for every decidable length, so a
 * device whose CMD_GET_FREE_SIZES reply is broken keeps a working user read.
 * The count is what rescues a legitimate 72-byte device with a multiple of
 * seven users; it is not what closes the hole.
 */
export function detectUserRecordSize(
  bodyLength: number,
  userCount: number | null,
): typeof USER_RECORD_SIZE {
  // Validated before the empty-body branch below so a negative or fractional
  // count is refused the same way regardless of bodyLength -- previously
  // (0, -1) reported "body is empty" instead of "non-negative integer",
  // which is a different refusal than every other bodyLength gets for the
  // same malformed count.
  if (userCount !== null && (!Number.isInteger(userCount) || userCount < 0)) {
    throw new ZkFramingError(`user count must be a non-negative integer, got ${userCount}`)
  }

  // Zero records is zero users under either width -- arithmetically ambiguous
  // (0 is a multiple of 504), semantically not. Handled HERE rather than by an
  // early return in parseUserData, because an empty body against a count that
  // claims users is a contradiction, and answering it with [] would be the
  // same fabricated absence reached from the other direction.
  if (bodyLength === 0) {
    if (userCount === null || userCount === 0) return USER_RECORD_SIZE
    throw new ZkFramingError(`user count is ${userCount} but the body is empty`)
  }

  if (userCount === null) {
    if (bodyLength % USER_RECORD_SIZE !== 0) {
      throw new ZkFramingError(
        `user body of ${bodyLength} bytes is not a multiple of ${USER_RECORD_SIZE}`,
      )
    }
    if (bodyLength % AMBIGUOUS_USER_BODY_MODULUS === 0) {
      throw new ZkFramingError(
        `user body of ${bodyLength} bytes is undecidable without a user count: ` +
          `${bodyLength / USER_RECORD_SIZE} record(s) of ${USER_RECORD_SIZE} bytes, ` +
          `or ${bodyLength / ALTERNATE_USER_RECORD_SIZE} of ${ALTERNATE_USER_RECORD_SIZE}. ` +
          `This library decodes only ${USER_RECORD_SIZE}-byte user records, and ` +
          `CMD_GET_FREE_SIZES supplied no count to settle it.`,
      )
    }
    return USER_RECORD_SIZE
  }

  if (userCount === 0) {
    throw new ZkFramingError(
      `user count is 0 but the body carries ${bodyLength} bytes; the count and the body ` +
        'contradict each other. FREE_SIZES_OFFSET is unverified, so a wrong userCount offset ' +
        'looks exactly like this.',
    )
  }
  if (bodyLength % userCount !== 0) {
    throw new ZkFramingError(
      `user body of ${bodyLength} bytes does not divide evenly by ${userCount} user(s)`,
    )
  }
  const size = bodyLength / userCount
  if (size === ALTERNATE_USER_RECORD_SIZE) {
    throw new ZkFramingError(
      `user body of ${bodyLength} bytes over a count of ${userCount} implies ` +
        `${ALTERNATE_USER_RECORD_SIZE}-byte user records. This library decodes only ` +
        `${USER_RECORD_SIZE}-byte records and will not guess at the ` +
        `${ALTERNATE_USER_RECORD_SIZE}-byte dialect.`,
    )
  }
  if (size !== USER_RECORD_SIZE) {
    throw new ZkFramingError(
      `user body of ${bodyLength} bytes over a count of ${userCount} implies ` +
        `${size}-byte user records, which is neither ${USER_RECORD_SIZE} nor the ` +
        `${ALTERNATE_USER_RECORD_SIZE}-byte dialect this library refuses.`,
    )
  }
  return USER_RECORD_SIZE
}

/**
 * Decodes a user-list payload: a 4-byte little-endian totalSize followed by
 * fixed-width records.
 *
 * `userCount` is the device's own count from CMD_GET_FREE_SIZES, or `null`
 * when none is available. It is required rather than defaulted so a call site
 * that has a count cannot lose it silently in a later edit. See
 * `detectUserRecordSize` for what each case refuses.
 *
 * Until v0.6 this assumed 72 bytes unconditionally, and a body that was a
 * whole number of records under BOTH widths -- any multiple of 504 -- was
 * parsed into users nobody had enrolled.
 */
export function parseUserData(data: Buffer, userCount: number | null): ZkUser[] {
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
  const size = detectUserRecordSize(body.length, userCount)
  const out: ZkUser[] = []
  for (let off = 0; off + size <= body.length; off += size) {
    out.push(decodeOne(body.subarray(off, off + size)))
  }
  return out
}
