import { describe, expect, it } from 'vitest'
import {
  detectRecordSize,
  parseAttendanceData,
} from '../../../src/codec/records/attendance.js'
import { ZkFramingError } from '../../../src/errors.js'

/** Builds one 40-byte record. */
function rec40(uid: number, userId: string, status: number, t: number, punch: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt8(status, 26)
  b.writeUInt32LE(t, 27)
  b.writeUInt8(punch, 31)
  return b
}

function rec16(userId: number, t: number, status: number, punch: number, workcode = 0): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(userId, 0)
  b.writeUInt32LE(t, 4)
  b.writeUInt8(status, 8)
  b.writeUInt8(punch, 9)
  b.writeUInt32LE(workcode, 12)
  return b
}

function rec8(uid: number, status: number, t: number, punch: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  b.writeUInt8(status, 2)
  b.writeUInt32LE(t, 3)
  b.writeUInt8(punch, 7)
  return b
}

/** Wraps records in the 4-byte totalSize header the device sends. */
function withHeader(...records: Buffer[]): Buffer {
  const body = Buffer.concat(records)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

describe('detectRecordSize', () => {
  it('accepts the three known dialects', () => {
    expect(detectRecordSize(80, 10)).toBe(8)
    expect(detectRecordSize(160, 10)).toBe(16)
    expect(detectRecordSize(400, 10)).toBe(40)
  })

  it('throws when the length does not divide evenly', () => {
    expect(() => detectRecordSize(81, 10)).toThrow(ZkFramingError)
  })

  it('throws on a quotient that is not a known record size', () => {
    expect(() => detectRecordSize(240, 10)).toThrow(ZkFramingError)
  })

  it('throws on a non-positive record count', () => {
    expect(() => detectRecordSize(80, 0)).toThrow(ZkFramingError)
    expect(() => detectRecordSize(80, -1)).toThrow(ZkFramingError)
  })
})

describe('parseAttendanceData', () => {
  it('decodes a 40-byte record including the printed user id', () => {
    const data = withHeader(rec40(5, '000123', 1, 0, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: 5,
      userIdFromRecord: '000123',
      numericUserId: null,
      recordSize: 40,
    })
    expect(r!.timestamp.local).toBe('2000-01-01T00:00:00')
  })

  it('preserves leading zeros in the printed user id', () => {
    const data = withHeader(rec40(1, '007', 0, 0, 0))
    expect(parseAttendanceData(data, 1)[0]!.userIdFromRecord).toBe('007')
  })

  it('reports a blank 40-byte user id as null, never as an empty string', () => {
    // '' labelled userIdSource: 'device' (assigned by the caller from
    // userIdFromRecord !== null) would be a fabricated identity — spec §4.2
    // and the README both promise null, never a fabricated one. null is also
    // what routes the record into the uid lookup path alongside the 8- and
    // 16-byte dialects, which still carries a usable identifier.
    const data = withHeader(rec40(5, '', 0, 0, 0))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({ uid: 5, userIdFromRecord: null, recordSize: 40 })
  })

  it('decodes a 16-byte record with no printed user id', () => {
    const data = withHeader(rec16(123, 0, 1, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: null,
      userIdFromRecord: null,
      numericUserId: 123,
      recordSize: 16,
    })
  })

  it('decodes an 8-byte record carrying only a uid', () => {
    const data = withHeader(rec8(9, 1, 0, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: 9,
      userIdFromRecord: null,
      numericUserId: null,
      recordSize: 8,
    })
  })

  it('decodes several records of the same dialect', () => {
    const data = withHeader(rec8(1, 0, 0, 0), rec8(2, 0, 0, 0), rec8(3, 0, 0, 0))
    expect(parseAttendanceData(data, 3).map((r) => r.uid)).toEqual([1, 2, 3])
  })

  it('attaches the raw hex of each record', () => {
    const one = rec8(1, 2, 3, 4)
    const [r] = parseAttendanceData(withHeader(one), 1)
    expect(r!.raw).toBe(one.toString('hex'))
  })

  it('skips a junk prefix on the 40-byte dialect', () => {
    const junk = Buffer.from([0xff, 0x32, 0x35, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00])
    const data = withHeader(junk, rec40(7, 'A1', 0, 0, 0))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({ uid: 7, userIdFromRecord: 'A1', recordSize: 40 })
  })

  it('THROWS rather than parsing when the body does not divide evenly', () => {
    const data = withHeader(rec8(1, 0, 0, 0), rec8(2, 0, 0, 0))
    // The device claimed 3 records; the body holds 2. The quotient would be
    // garbage and a parse loop would happily emit misaligned records.
    expect(() => parseAttendanceData(data, 3)).toThrow(ZkFramingError)
  })

  it('throws when the buffer is shorter than the declared totalSize', () => {
    const data = withHeader(rec8(1, 0, 0, 0))
    expect(() => parseAttendanceData(data.subarray(0, 8), 1)).toThrow(ZkFramingError)
  })

  it('throws when the buffer is too short to hold the header', () => {
    expect(() => parseAttendanceData(Buffer.from([1, 2]), 1)).toThrow(ZkFramingError)
  })

  it('returns an empty array for a zero record count without inspecting the body', () => {
    expect(parseAttendanceData(withHeader(), 0)).toEqual([])
  })
})
