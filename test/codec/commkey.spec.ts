import { describe, expect, it } from 'vitest'
import { assertCommKey, mixCommKey } from '../../src/codec/commkey.js'

describe('mixCommKey', () => {
  it('always produces 4 bytes', () => {
    expect(mixCommKey(0, 0)).toHaveLength(4)
    expect(mixCommKey(123456, 0xabcd)).toHaveLength(4)
  })

  it('is deterministic', () => {
    expect(mixCommKey(1234, 42)).toEqual(mixCommKey(1234, 42))
  })

  it('depends on the session id', () => {
    expect(mixCommKey(1234, 0x0100)).not.toEqual(mixCommKey(1234, 0x0200))
  })

  it('depends on the key', () => {
    expect(mixCommKey(1234, 7)).not.toEqual(mixCommKey(5678, 7))
  })

  it('discards the low byte of the session id — CONFIRMED genuine, not a defect', () => {
    // Adding a small session id changes only byte 0 of the packed value; the
    // half-swap moves that byte to index 2; step 5 then assigns the tick byte
    // to index 2, erasing it. Session ids 1, 2 and 255 are therefore
    // indistinguishable here.
    //
    // This originally read as a likely spec-prose error: devices issue small
    // session ids, so if genuine, the session plays almost no part in
    // authentication, defeating the point of mixing it in. Task 14's oracle
    // capture adjudicated it: pyzk, driven as a black box against the
    // emulator's comm-key challenge over both TCP and UDP, put CMD_AUTH bytes
    // on the wire that match mixCommKey's output exactly (see
    // test/oracle/commkey.spec.ts and the auth-*-pyzk.json fixtures). The
    // erasure is real device behaviour, not a misreading of the prose.
    expect(mixCommKey(1234, 1)).toEqual(mixCommKey(1234, 2))
    expect(mixCommKey(1234, 1)).toEqual(mixCommKey(1234, 255))
    expect(mixCommKey(1234, 1)).not.toEqual(mixCommKey(1234, 256))
  })

  it('assigns byte 2 directly from the tick byte rather than XORing it', () => {
    // Spec §A.4: bytes 0, 1 and 3 are XORed with B; byte 2 is ASSIGNED B.
    // With the default ticks of 50, byte 2 is therefore always 50.
    for (const key of [0, 1, 999, 123456, 0xffffffff]) {
      expect(mixCommKey(key, 3)[2]).toBe(50)
    }
    expect(mixCommKey(1234, 3, 77)[2]).toBe(77)
  })

  it('handles a key with the top bit set without going negative', () => {
    const out = mixCommKey(0xffffffff, 1)
    for (const byte of out) expect(byte).toBeGreaterThanOrEqual(0)
  })
})

describe('assertCommKey', () => {
  it('accepts every integer from 0 to 2^32 - 1 and returns it unchanged', () => {
    for (const k of [0, 1, 1234, 0x7fffffff, 0xffffffff]) expect(assertCommKey(k)).toBe(k)
  })

  it('refuses a fraction, a negative, 2^32 and non-finite values with a RangeError naming the key', () => {
    // Each of these used to reach mixCommKey, whose bit operations turn 12.5 into 12 and
    // wrap -1 and 2^32 into other keys: the device then refuses auth with no hint why.
    for (const k of [12.5, -1, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCommKey(k)).toThrow(RangeError)
      expect(() => assertCommKey(k)).toThrow(/commKey must be an integer from 0 to 4294967295/)
    }
  })

  it('names the option it was given, for the CLI', () => {
    expect(() => assertCommKey(-1, '--comm-key')).toThrow(/^--comm-key must be an integer/)
  })

  it('guards mixCommKey itself, so no caller can mix a key that is not one', () => {
    expect(() => mixCommKey(12.5, 0)).toThrow(RangeError)
    expect(mixCommKey(12, 0)).toHaveLength(4)
  })
})
