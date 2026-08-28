import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { applyReplyIdQuirk, decodePayload, encodePayload } from '../../src/codec/packet.js'
import { checksum16 } from '../../src/codec/checksum.js'
import { ZkProtocolError } from '../../src/errors.js'

describe('encodePayload', () => {
  it('lays out command, checksum, sessionId, replyId, data', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0x1234, replyId: 7 })
    expect(p.length).toBe(8)
    expect(p.readUInt16LE(0)).toBe(1000)
    expect(p.readUInt16LE(4)).toBe(0x1234)
    expect(p.readUInt16LE(6)).toBe(7)
  })

  it('appends data after the 8-byte header', () => {
    const data = Buffer.from([1, 2, 3])
    const p = encodePayload({ command: CMD.AUTH, sessionId: 1, replyId: 1, data })
    expect(p.length).toBe(11)
    expect(p.subarray(8)).toEqual(data)
  })

  it('writes a checksum that validates against the payload', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })
    expect(p.readUInt16LE(2)).toBe(checksum16(p))
  })
})

describe('decodePayload', () => {
  it('round-trips what encodePayload produced', () => {
    const data = Buffer.from([9, 9])
    const p = encodePayload({ command: CMD.ATTLOG_RRQ, sessionId: 42, replyId: 3, data })
    const d = decodePayload(p)
    expect(d).toMatchObject({ command: CMD.ATTLOG_RRQ, sessionId: 42, replyId: 3 })
    expect(d.data).toEqual(data)
  })

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodePayload(Buffer.from([1, 2, 3]))).toThrow(ZkProtocolError)
  })
})

describe('applyReplyIdQuirk', () => {
  it('overwrites the reply id on the wire', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    const wire = applyReplyIdQuirk(p, 5)
    expect(wire.readUInt16LE(6)).toBe(5)
  })

  it('leaves the checksum computed over the OLD reply id — this is deliberate', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    const wire = applyReplyIdQuirk(p, 5)
    expect(wire.readUInt16LE(2)).toBe(p.readUInt16LE(2))
    // The transmitted packet's checksum therefore does NOT match its contents.
    expect(wire.readUInt16LE(2)).not.toBe(checksum16(wire))
  })

  it('does not mutate its input', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    applyReplyIdQuirk(p, 5)
    expect(p.readUInt16LE(6)).toBe(4)
  })

  it('wraps the reply id at 16 bits', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0xffff })
    expect(applyReplyIdQuirk(p, 0x10000).readUInt16LE(6)).toBe(0)
  })
})
