import { describe, expect, it } from 'vitest'
import { USER_RECORD_SIZE, parseUserData } from '../../../src/codec/records/user.js'
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
    const [u] = parseUserData(withHeader(userRec(5, '000123', 'Alice')))
    expect(u).toMatchObject({ uid: 5, userId: '000123', name: 'Alice' })
  })

  it('preserves leading zeros in the printed id', () => {
    expect(parseUserData(withHeader(userRec(1, '007', 'Bob')))[0]!.userId).toBe('007')
  })

  it('reports whether a password is set without returning it', () => {
    const withPw = parseUserData(withHeader(userRec(1, '1', 'A', { password: 'secret' })))[0]!
    const withoutPw = parseUserData(withHeader(userRec(2, '2', 'B')))[0]!
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
    const [u] = parseUserData(withHeader(userRec(1, '1', 'A', { privilege: 14, card: 987 })))
    expect(u).toMatchObject({ privilege: 14, cardNumber: 987 })
  })

  it('decodes several users', () => {
    const data = withHeader(userRec(1, '1', 'A'), userRec(2, '2', 'B'), userRec(3, '3', 'C'))
    expect(parseUserData(data).map((u) => u.uid)).toEqual([1, 2, 3])
  })

  it('attaches raw hex per record', () => {
    const one = userRec(1, '1', 'A')
    expect(parseUserData(withHeader(one))[0]!.raw).toBe(one.toString('hex'))
  })

  it('returns an empty array for an empty body', () => {
    expect(parseUserData(withHeader())).toEqual([])
  })

  it('throws when the body is not a whole number of records', () => {
    const data = withHeader(userRec(1, '1', 'A').subarray(0, 40))
    expect(() => parseUserData(data)).toThrow(ZkFramingError)
  })

  it('throws when the declared size exceeds what arrived', () => {
    const data = withHeader(userRec(1, '1', 'A'))
    expect(() => parseUserData(data.subarray(0, 20))).toThrow(ZkFramingError)
  })

  it('reads a nine-character printed id in full', () => {
    // zkteco-js reads slice(48, 48 + 9) (helper/utils.js:143-144). An eight-byte
    // read returned '12345678' — a different identity that then keyed the
    // attendance lookup (review R4).
    expect(parseUserData(withHeader(userRec(7, '123456789', 'Nine')))[0]!.userId).toBe('123456789')
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

    const [user] = parseUserData(body)
    expect(user).toBeDefined()
    expect(Buffer.from(user!.name, 'latin1')).toEqual(nameBytes)
  })
})
