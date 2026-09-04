import { describe, expect, it } from 'vitest'
import {
  ALTERNATE_USER_RECORD_SIZE,
  AMBIGUOUS_USER_BODY_MODULUS,
  USER_RECORD_SIZE,
  detectUserRecordSize,
  parseUserData,
} from '../../../src/codec/records/user.js'
import { ZkFramingError } from '../../../src/errors.js'

function userRec(
  uid: number, userId: string, name: string,
  opts: { privilege?: number; password?: string; card?: number } = {},
): Buffer {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.writeUInt8(opts.privilege ?? 0, 2)
  if (opts.password) b.write(opts.password, 3, 8, 'ascii')
  b.write(name, 11, 24, 'ascii')
  b.writeUInt32LE(opts.card ?? 0, 35)
  b.write(userId, 48, 9, 'ascii')
  return b
}

function withHeader(...records: Buffer[]): Buffer {
  const body = Buffer.concat(records)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

describe('parseUserData', () => {
  it('decodes uid, printed id and name', () => {
    const [u] = parseUserData(withHeader(userRec(5, '000123', 'Alice')), null)
    expect(u).toMatchObject({ uid: 5, userId: '000123', name: 'Alice' })
  })

  it('preserves leading zeros in the printed id', () => {
    expect(parseUserData(withHeader(userRec(1, '007', 'Bob')), null)[0]!.userId).toBe('007')
  })

  it('reports whether a password is set without returning it', () => {
    const withPw = parseUserData(withHeader(userRec(1, '1', 'A', { password: 'secret' })), null)[0]!
    const withoutPw = parseUserData(withHeader(userRec(2, '2', 'B')), null)[0]!
    expect(withPw.hasPassword).toBe(true)
    expect(withoutPw.hasPassword).toBe(false)
    // The ASCII form never appears, but that is not the interesting property:
    // `raw` is hex, so a plaintext search would pass even with the password
    // fully intact. Assert on the encoded form, and on recovery from `raw`.
    expect(withPw.raw).not.toContain(Buffer.from('secret', 'ascii').toString('hex'))
    expect(Buffer.from(withPw.raw, 'hex').subarray(3, 11).every((b) => b === 0)).toBe(true)
    // Verify non-password bytes survive the redaction
    expect(withPw).toMatchObject({ uid: 1, name: 'A', userId: '1' })
  })

  it('decodes privilege and card number as raw numbers', () => {
    const [u] = parseUserData(withHeader(userRec(1, '1', 'A', { privilege: 14, card: 987 })), null)
    expect(u).toMatchObject({ privilege: 14, cardNumber: 987 })
  })

  it('decodes several users', () => {
    const data = withHeader(userRec(1, '1', 'A'), userRec(2, '2', 'B'), userRec(3, '3', 'C'))
    expect(parseUserData(data, null).map((u) => u.uid)).toEqual([1, 2, 3])
  })

  it('attaches raw hex per record', () => {
    const one = userRec(1, '1', 'A')
    expect(parseUserData(withHeader(one), null)[0]!.raw).toBe(one.toString('hex'))
  })

  it('returns an empty array for an empty body', () => {
    expect(parseUserData(withHeader(), null)).toEqual([])
  })

  it('throws when the body is not a whole number of records', () => {
    const data = withHeader(userRec(1, '1', 'A').subarray(0, 40))
    expect(() => parseUserData(data, null)).toThrow(ZkFramingError)
  })

  it('throws when the declared size exceeds what arrived', () => {
    const data = withHeader(userRec(1, '1', 'A'))
    expect(() => parseUserData(data.subarray(0, 20), null)).toThrow(ZkFramingError)
  })

  it('reads a nine-character printed id in full', () => {
    // zkteco-js reads slice(48, 48 + 9) (helper/utils.js:143-144). An eight-byte
    // read returned '12345678' — a different identity that then keyed the
    // attendance lookup (review R4).
    expect(parseUserData(withHeader(userRec(7, '123456789', 'Nine')), null)[0]!.userId).toBe('123456789')
  })
})

describe('non-ASCII names', () => {
  it('preserves bytes above 0x7f instead of stripping the high bit', () => {
    // A 72-byte user record whose name field (bytes 11..34) holds bytes that
    // are not valid ASCII. Node's 'ascii' decoder masks them to & 0x7f, which
    // silently returns a different, plausible-looking name with no way back
    // to what the device actually sent.
    const rec = Buffer.alloc(USER_RECORD_SIZE)
    rec.writeUInt16LE(7, 0)
    const nameBytes = Buffer.from([0xc3, 0x94, 0xc3, 0xa9, 0xd0, 0x96])
    nameBytes.copy(rec, 11)
    rec.write('1001', 48, 'latin1')

    const body = Buffer.alloc(4 + USER_RECORD_SIZE)
    body.writeUInt32LE(USER_RECORD_SIZE, 0)
    rec.copy(body, 4)

    const [user] = parseUserData(body, null)
    expect(user).toBeDefined()
    expect(Buffer.from(user!.name, 'latin1')).toEqual(nameBytes)
  })
})

describe('detectUserRecordSize', () => {
  // 18 x 28 = 504 = 7 x 72. This is the whole defect: the body is a whole
  // number of records under BOTH widths, so the `% 72` guard passes and the
  // caller receives seven users assembled from slices of eighteen other
  // people's records.
  const AMBIGUOUS = AMBIGUOUS_USER_BODY_MODULUS

  it('refuses an ambiguous body length when no count is available', () => {
    expect(() => detectUserRecordSize(AMBIGUOUS, null)).toThrow(ZkFramingError)
    // The message is the entire evidentiary output of this change on first
    // hardware, so assert it names both readings, not just that it threw.
    expect(() => detectUserRecordSize(AMBIGUOUS, null)).toThrow(/7 record\(s\) of 72 bytes, or 18 of 28/)
  })

  it('resolves an ambiguous body length when the count settles it', () => {
    expect(detectUserRecordSize(AMBIGUOUS, 7)).toBe(USER_RECORD_SIZE)
  })

  it('refuses rather than decodes when the count implies the 28-byte dialect', () => {
    expect(() => detectUserRecordSize(AMBIGUOUS, 18)).toThrow(/28-byte/)
    expect(() => detectUserRecordSize(AMBIGUOUS, 18)).toThrow(ZkFramingError)
  })

  it('reads an unambiguous body as 72 bytes without a count, exactly as before', () => {
    // 8 x 72 = 576, which is not a multiple of 504. Nothing about this case
    // changes; the test exists so an over-broad guard cannot pass review.
    expect(detectUserRecordSize(8 * USER_RECORD_SIZE, null)).toBe(USER_RECORD_SIZE)
  })

  it('reads an empty body as zero records under a null or zero count', () => {
    expect(detectUserRecordSize(0, null)).toBe(USER_RECORD_SIZE)
    expect(detectUserRecordSize(0, 0)).toBe(USER_RECORD_SIZE)
  })

  it('refuses an empty body against a count that claims users', () => {
    // The mirror of the zero-count case below: an early return of [] here
    // would answer "how many are enrolled" with a fabricated absence.
    expect(() => detectUserRecordSize(0, 5)).toThrow(/count is 5 but the body is empty/)
  })

  it('refuses a zero count against a non-empty body', () => {
    // FREE_SIZES_OFFSET is unverified. If the userCount offset is wrong the
    // field reads a spurious 0, and returning [] would report "nobody is
    // enrolled" for a device with users -- which then silently disables
    // user-id resolution for every attendance record.
    expect(() => detectUserRecordSize(AMBIGUOUS, 0)).toThrow(/count is 0 but the body carries 504 bytes/)
  })

  it('refuses a count that does not divide the body', () => {
    expect(() => detectUserRecordSize(500, 7)).toThrow(/does not divide evenly by 7/)
    // A body that IS a whole number of 72-byte records (5 x 72 = 360) but
    // whose count disagrees. The width is never re-derived from the body
    // alone once a count has been supplied.
    expect(() => detectUserRecordSize(360, 7)).toThrow(/does not divide evenly by 7/)
  })

  it('refuses a body that divides by the count into neither known width', () => {
    // 5 x 72 = 360 over a count of 7 is 51.43 -- not an integer, so this is
    // caught by the divisibility rule. 360 over a count of 5 is 72 and must
    // pass; 360 over a count of 9 is 40, a whole number that is neither
    // width, and is what this row actually exercises.
    expect(detectUserRecordSize(360, 5)).toBe(USER_RECORD_SIZE)
    expect(() => detectUserRecordSize(360, 9)).toThrow(/derived user record size 40 is not 72/)
  })

  it('refuses a body that is not a whole number of 72-byte records without a count', () => {
    expect(() => detectUserRecordSize(100, null)).toThrow(/not a multiple of 72/)
  })

  it('refuses a negative or fractional count', () => {
    expect(() => detectUserRecordSize(144, -1)).toThrow(/non-negative integer/)
    expect(() => detectUserRecordSize(144, 1.5)).toThrow(/non-negative integer/)
  })

  it('exports the alternate width and the ambiguous modulus', () => {
    expect(ALTERNATE_USER_RECORD_SIZE).toBe(28)
    // lcm(72, 28). Pinned so a later edit cannot quietly narrow the guard.
    expect(AMBIGUOUS_USER_BODY_MODULUS).toBe(504)
    expect(AMBIGUOUS_USER_BODY_MODULUS % USER_RECORD_SIZE).toBe(0)
    expect(AMBIGUOUS_USER_BODY_MODULUS % ALTERNATE_USER_RECORD_SIZE).toBe(0)
  })
})

describe('parseUserData width handling', () => {
  it('refuses a 504-byte body rather than returning seven fabricated users', () => {
    // Eighteen 28-byte records, built as raw bytes because this library has
    // no 28-byte encoder and must not gain one.
    const body = Buffer.alloc(18 * ALTERNATE_USER_RECORD_SIZE, 0x41)
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    const data = Buffer.concat([head, body])
    expect(data.length - 4).toBe(504)
    expect(() => parseUserData(data, null)).toThrow(ZkFramingError)
  })
})
