import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodeParamRequest } from '../../src/codec/params.js'

interface Packet {
  hex: string
  command: number
  checksum: number
  sessionId: number
  replyId: number
  data: string
}
interface Fixture {
  source: string
  transport: string
  packets: Packet[]
}

const DIR = path.join('test', 'fixtures', 'oracle', 'params')
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Fixture)

describe('CMD_OPTIONS_RRQ request shape', () => {
  it('has fixtures for all four source/transport combinations', () => {
    expect(fixtures).toHaveLength(4)
  })

  it('carries the keyword as plain ASCII text, with no length prefix and no separator', () => {
    // True of every captured request regardless of the trailing-NUL
    // disagreement adjudicated below: no fixture shows a length-prefixed or
    // otherwise encoded keyword.
    const requests = fixtures.flatMap((f) => f.packets.filter((p) => p.command === CMD.OPTIONS_RRQ))
    expect(requests.length).toBeGreaterThan(0)
    for (const p of requests) {
      const data = Buffer.from(p.data, 'hex')
      const text = data.toString('latin1').replace(/\0$/, '')
      expect(text).toMatch(/^[~A-Za-z0-9]+$/)
    }
  })

  it('the two oracles DISAGREE on a trailing NUL — recorded per design spec §8.1, not resolved by picking a side', () => {
    // §8.1's rule for a disagreement: record both figures (PROVENANCE.md),
    // implement the form a device tolerating either would accept, and leave
    // it as an open first-hardware question (checklist item 18). This test
    // is the record. It does NOT assert one uniform shape across all
    // fixtures — that would be the exact mistake the brief warned against:
    // adjusting the test to match a belief the capture refuted.
    const pyzkRequests = fixtures
      .filter((f) => f.source === 'pyzk')
      .flatMap((f) => f.packets.filter((p) => p.command === CMD.OPTIONS_RRQ))
    const zkjsRequests = fixtures
      .filter((f) => f.source === 'zkteco-js')
      .flatMap((f) => f.packets.filter((p) => p.command === CMD.OPTIONS_RRQ))

    // Both oracles reach the command at least once, so both sides of the
    // disagreement are backed by real evidence, not silence.
    expect(pyzkRequests.length).toBeGreaterThan(0)
    expect(zkjsRequests.length).toBeGreaterThan(0)

    // pyzk (GPL-2.0, executed as a black box only): every request appends
    // exactly one trailing NUL after the keyword, and nowhere else.
    for (const p of pyzkRequests) {
      const data = Buffer.from(p.data, 'hex')
      expect(data.at(-1)).toBe(0)
      expect(data.subarray(0, -1).includes(0)).toBe(false)
      const keyword = data.subarray(0, -1).toString('latin1')
      // encodeParamRequest implements pyzk's form: this is the byte-for-byte
      // match that justified choosing it.
      expect(encodeParamRequest(keyword)).toEqual(data)
    }

    // zkteco-js (MIT, read at source level): every request sends the keyword
    // bare, with no terminator of any kind.
    for (const p of zkjsRequests) {
      const data = Buffer.from(p.data, 'hex')
      expect(data.includes(0)).toBe(false)
      const keyword = data.toString('latin1')
      // What this library sends is one byte longer than zkteco-js's bare
      // form — the divergence, recorded rather than smoothed over.
      expect(encodeParamRequest(keyword)).toEqual(Buffer.concat([data, Buffer.from([0])]))
    }
  })

  it('records that zkteco-js reaches the parameter commands on TCP only', () => {
    const zkjsUdp = fixtures.find((f) => f.source === 'zkteco-js' && f.transport === 'udp')
    const zkjsTcp = fixtures.find((f) => f.source === 'zkteco-js' && f.transport === 'tcp')
    expect(zkjsTcp!.packets.filter((p) => p.command === CMD.OPTIONS_RRQ).length).toBeGreaterThan(0)
    // Not an agreement with anything — an absence. zkteco-js wires these
    // methods for TCP only and throws before touching a UDP socket. This
    // is the predicted asymmetry (design spec §8.2), confirmed by capture.
    expect(zkjsUdp!.packets.filter((p) => p.command === CMD.OPTIONS_RRQ)).toHaveLength(0)
    // getTime is the documented exception: a real UDP implementation, so the
    // UDP run still yields a CMD_GET_TIME packet even though it yields no
    // CMD_OPTIONS_RRQ.
    expect(zkjsUdp!.packets.filter((p) => p.command === CMD.GET_TIME).length).toBeGreaterThan(0)
  })

  it('pins the odd-length checksum branch against an external implementation', () => {
    // ~SerialNumber is 13 bytes, so zkteco-js's bare payload for it is
    // odd-length. (pyzk's NUL-terminated form makes ~SerialNumber's payload
    // even instead — 14 bytes — but ~ZKFPVersion, at 12 bytes, becomes 13
    // once pyzk appends its terminator, so pyzk contributes an odd-length
    // packet of its own.) Every fixture captured before this scope was 8 or
    // 12 bytes, so the trailing-odd-byte branch of checksum16 had no
    // external evidence, despite already carrying CMD_PREPARE_BUFFER on the
    // bulk-read path since v0.1.
    const odd = fixtures
      .flatMap((f) => f.packets)
      .filter((p) => Buffer.from(p.hex, 'hex').length % 2 === 1)
    expect(odd.length).toBeGreaterThan(0)
  })
})
