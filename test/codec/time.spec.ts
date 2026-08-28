import { describe, expect, it } from 'vitest'
import { decodeZkTime, decodeZkTime6 } from '../../src/codec/time.js'
import { ZkProtocolError } from '../../src/errors.js'

describe('decodeZkTime', () => {
  it('decodes zero as the post-power-loss reset value', () => {
    expect(decodeZkTime(0)).toMatchObject({
      year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0,
      local: '2000-01-01T00:00:00',
    })
  })

  it('unpacks seconds, minutes and hours', () => {
    // 1 hour, 2 minutes, 3 seconds into 2000-01-01.
    expect(decodeZkTime(3600 + 120 + 3)).toMatchObject({
      year: 2000, month: 1, day: 1, hour: 1, minute: 2, second: 3,
    })
  })

  it('treats a month as exactly 31 days', () => {
    const t = 30 * 86_400 // day index 30 -> the 31st
    expect(decodeZkTime(t)).toMatchObject({ month: 1, day: 31 })
    expect(decodeZkTime(t + 86_400)).toMatchObject({ month: 2, day: 1 })
  })

  it('treats a year as exactly 12 pseudo-months', () => {
    const month = 31 * 86_400
    expect(decodeZkTime(11 * month)).toMatchObject({ year: 2000, month: 12, day: 1 })
    expect(decodeZkTime(12 * month)).toMatchObject({ year: 2001, month: 1, day: 1 })
  })

  it('can produce a date that does not exist, and does not correct it', () => {
    // February 31st is representable in the packed pseudo-calendar. The device
    // packs it, so the library returns it. A Date would silently slide it to
    // March 3rd; that is the failure this type exists to prevent.
    const t = 31 * 86_400 + 30 * 86_400 // month index 1, day index 30
    const decoded = decodeZkTime(t)
    expect(decoded).toMatchObject({ month: 2, day: 31 })
    expect(decoded.local).toBe('2000-02-31T00:00:00')
  })

  it('zero-pads every field in `local`', () => {
    expect(decodeZkTime(0).local).toBe('2000-01-01T00:00:00')
    expect(decodeZkTime(9 * 3600 + 5 * 60 + 7).local).toBe('2000-01-01T09:05:07')
  })

  it('handles the full uint32 range without going negative', () => {
    const decoded = decodeZkTime(0xffffffff)
    expect(decoded.year).toBeGreaterThan(2000)
    expect(decoded.month).toBeGreaterThanOrEqual(1)
    expect(decoded.day).toBeGreaterThanOrEqual(1)
  })
})

describe('decodeZkTime6', () => {
  it('reads the year-2000, month, day, hour, minute, second form', () => {
    const buf = Buffer.from([26, 8, 27, 8, 1, 0])
    expect(decodeZkTime6(buf)).toMatchObject({
      year: 2026, month: 8, day: 27, hour: 8, minute: 1, second: 0,
      local: '2026-08-27T08:01:00',
    })
  })

  it('reads from an offset', () => {
    const buf = Buffer.from([0xff, 0xff, 26, 8, 27, 8, 1, 0])
    expect(decodeZkTime6(buf, 2).local).toBe('2026-08-27T08:01:00')
  })

  it('throws rather than returning a value with undefined fields on a short buffer', () => {
    // decodeZkTime6(Buffer.from([26, 8])) used to return
    // local: "2026-08-undefinedTundefined:undefined:undefined", with four
    // fields typed `number` actually holding `undefined` -- the `as number`
    // casts silenced the compiler. This is public via src/index.ts.
    expect(() => decodeZkTime6(Buffer.from([26, 8]))).toThrow(ZkProtocolError)
  })

  it('throws when offset plus 6 bytes runs past the end of the buffer', () => {
    const buf = Buffer.from([0xff, 0xff, 26, 8, 27, 8, 1, 0])
    expect(() => decodeZkTime6(buf, 3)).toThrow(ZkProtocolError)
  })
})
