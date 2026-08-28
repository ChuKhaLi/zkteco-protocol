import { describe, expect, it } from 'vitest'
import { START_MARKER, frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import { ZkProtocolError } from '../../src/errors.js'

const payload = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

describe('frameTcp', () => {
  it('prepends the start marker and a little-endian length', () => {
    const framed = frameTcp(payload)
    expect(framed.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
    expect(framed.readUInt32LE(4)).toBe(payload.length)
    expect(framed.subarray(8)).toEqual(payload)
  })

  it('exports the marker it writes', () => {
    expect(START_MARKER).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
  })
})

describe('tryUnframeTcp', () => {
  it('recovers the payload and reports how many bytes it consumed', () => {
    const r = tryUnframeTcp(frameTcp(payload))
    expect(r?.payload).toEqual(payload)
    expect(r?.consumed).toBe(8 + payload.length)
  })

  it('returns null when the header is incomplete', () => {
    expect(tryUnframeTcp(Buffer.from([0x50, 0x50, 0x82]))).toBeNull()
  })

  it('returns null when the body has not fully arrived', () => {
    const framed = frameTcp(payload)
    expect(tryUnframeTcp(framed.subarray(0, 10))).toBeNull()
  })

  it('leaves trailing bytes of the next packet alone', () => {
    const two = Buffer.concat([frameTcp(payload), frameTcp(payload)])
    const first = tryUnframeTcp(two)
    expect(first?.consumed).toBe(8 + payload.length)
    const second = tryUnframeTcp(two.subarray(first!.consumed))
    expect(second?.payload).toEqual(payload)
  })

  it('throws when the start marker does not match', () => {
    const bad = frameTcp(payload)
    bad.writeUInt8(0x51, 0)
    expect(() => tryUnframeTcp(bad)).toThrow(ZkProtocolError)
  })
})
