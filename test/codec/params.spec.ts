import { describe, expect, it } from 'vitest'
import { DEVICE_PARAM, decodeParamReply, encodeParamRequest } from '../../src/codec/params.js'
import { ZkProtocolError } from '../../src/errors.js'

const body = (s: string): Buffer => Buffer.from(s, 'latin1')

describe('encodeParamRequest', () => {
  it('sends the keyword NUL-terminated, with no length prefix', () => {
    // See the docblock on encodeParamRequest and PROVENANCE.md: the two
    // oracles disagreed on this (pyzk terminates, zkteco-js does not), and
    // this is the form chosen from that disagreement, per design spec §8.1.
    const out = encodeParamRequest('~SerialNumber')
    expect(out).toEqual(Buffer.from('~SerialNumber\0', 'latin1'))
    expect(out.length).toBe(14)
    expect(out.subarray(0, -1).includes(0)).toBe(false)
    expect(out.at(-1)).toBe(0)
  })

  it('refuses an empty keyword', () => {
    expect(() => encodeParamRequest('')).toThrow(RangeError)
  })

  it("refuses a keyword containing '=' (echo-check ambiguity) or NUL (wire safety, since this function appends its own terminator)", () => {
    expect(() => encodeParamRequest('~OS=x')).toThrow(RangeError)
    expect(() => encodeParamRequest('~OS\0')).toThrow(RangeError)
  })
})

describe('decodeParamReply', () => {
  it('returns the value after the separator', () => {
    expect(decodeParamReply('~SerialNumber', body('~SerialNumber=ABC123'))).toBe('ABC123')
  })

  it('truncates NUL padding', () => {
    expect(decodeParamReply('~OS', body('~OS=Linux\0\0\0\0'))).toBe('Linux')
  })

  it('splits on the FIRST separator, so a value may contain one', () => {
    expect(decodeParamReply('~SSR', body('~SSR=a=b=c'))).toBe('a=b=c')
  })

  it('returns an empty string for an empty value, which is an answer not a refusal', () => {
    expect(decodeParamReply('~OS', body('~OS='))).toBe('')
  })

  it('throws when the reply echoes a different keyword than was requested', () => {
    // zkteco-js returns the whole body here, so a ~Platform reply to a
    // ~DeviceName request becomes the device name. That is fabricating an
    // identity, which v0.1 §2.5 forbids.
    expect(() => decodeParamReply('~DeviceName', body('~Platform=ZMM220'))).toThrow(ZkProtocolError)
    expect(() => decodeParamReply('~DeviceName', body('~Platform=ZMM220'))).toThrow(/~DeviceName/)
  })

  it('throws on a body with no separator at all', () => {
    // Asserting the class alone does not pin this to the sep === -1 branch:
    // deleting that branch still throws ZkProtocolError, from the echoed-
    // keyword mismatch instead (text.slice(0, -1) on 'Linux' is 'Linu', which
    // is not '~OS' either). The message is what distinguishes the branches.
    expect(() => decodeParamReply('~OS', body('Linux'))).toThrow(
      /carries no '=' separator/,
    )
  })

  it('round-trips bytes above 0x7f without loss', () => {
    const raw = Buffer.concat([body('~DeviceName='), Buffer.from([0xc3, 0x94, 0xd0, 0x96])])
    const value = decodeParamReply('~DeviceName', raw)
    expect(Buffer.from(value, 'latin1')).toEqual(Buffer.from([0xc3, 0x94, 0xd0, 0x96]))
  })
})

describe('DEVICE_PARAM', () => {
  it('carries the observed keywords as literal types', () => {
    expect(DEVICE_PARAM.SERIAL_NUMBER).toBe('~SerialNumber')
    expect(DEVICE_PARAM.DEVICE_NAME).toBe('~DeviceName')
    expect(DEVICE_PARAM.PLATFORM).toBe('~Platform')
    expect(DEVICE_PARAM.OS).toBe('~OS')
    expect(DEVICE_PARAM.MAC).toBe('MAC')
  })
})
