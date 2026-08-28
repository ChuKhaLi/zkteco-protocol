import { describe, expect, it } from 'vitest'
import { checksum16 } from '../../src/codec/checksum.js'

describe('checksum16', () => {
  it('ignores the checksum field already present in the buffer', () => {
    const a = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const b = Buffer.from([0xe8, 0x03, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00])
    expect(checksum16(a)).toBe(checksum16(b))
  })

  it('returns a value that makes the whole payload sum to 0xffff', () => {
    const p = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const c = checksum16(p)
    const withChecksum = Buffer.from(p)
    withChecksum.writeUInt16LE(c, 2)
    let sum = 0
    for (let i = 0; i < withChecksum.length; i += 2) sum += withChecksum.readUInt16LE(i)
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16)
    expect(sum).toBe(0xffff)
  })

  it('pads a trailing odd byte with zero', () => {
    const odd = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f])
    const padded = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x00])
    expect(checksum16(odd)).toBe(checksum16(padded))
  })

  it('stays within 16 bits', () => {
    const big = Buffer.alloc(64, 0xff)
    big.writeUInt16LE(0, 2)
    expect(checksum16(big)).toBeGreaterThanOrEqual(0)
    expect(checksum16(big)).toBeLessThanOrEqual(0xffff)
  })
})
