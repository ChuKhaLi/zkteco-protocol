import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { auditChecksums, emptyFindings, probeState } from '../../src/diagnostics/probe.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 1000 })
  await s.open()
  return s
}

describe('probeState', () => {
  it('records the storage counters and keeps the raw body for item 4', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 42, recordCount: 1337, recordCapacity: 100_000 },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.freeSizes).toMatchObject({ userCount: 42, recordCount: 1337 })
    // FREE_SIZES_OFFSET is documentation-derived and unverified. The raw body
    // is what lets a reader check the offsets against a real reply.
    expect(findings.freeSizes?.rawHex).toMatch(/^[0-9a-f]+$/)
  })

  it('records device and host clocks side by side without judging the difference', async () => {
    // deviceTimeRaw 0 decodes to 2000-01-01T00:00:00 — a real calendar date,
    // so this exercises the answered-and-valid path rather than the
    // device-refused default (CMD_GET_TIME answers ACK_ERROR when
    // deviceTimeRaw is absent).
    running = await startEmulator({ transport: 'tcp', deviceTimeRaw: 0 })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.clock?.deviceLocal).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(typeof findings.clock?.skewSeconds).toBe('number')
  })

  it('keeps going when the device refuses the clock', async () => {
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_TIME]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeState(session, runner, findings, 0)
    expect(findings.clock).toBeNull()
    expect(findings.freeSizes).not.toBeNull()
    expect(runner.truncated).toBeNull()
  })

  it('records the clock but withholds skew when the packed value is not a real calendar date', async () => {
    // decodeZkTime unpacks through a pseudo-calendar of 31-day months. Work
    // out a packed value whose day-of-month component is 31 in a short month
    // by inverting decodeZkTime's own arithmetic: year 2026 (v=26), month 2
    // (Feb, zero-based 1), day 31 (zero-based 30), at midnight.
    const yearPart = 26
    const monthPart = 1 // February, zero-based
    const dayPart = 30 // day 31, zero-based
    const packed = ((yearPart * 12 + monthPart) * 31 + dayPart) * 24 * 60 * 60
    running = await startEmulator({
      transport: 'tcp',
      handlers: {
        [CMD.GET_TIME]: (req, state) => {
          const data = Buffer.alloc(4)
          data.writeUInt32LE(packed >>> 0, 0)
          return [reply(state, req, CMD.ACK_OK, data)]
        },
      },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.clock?.deviceLocal).toBe('2026-02-31T00:00:00')
    expect(findings.clock?.skewSeconds).toBeNull()
  })
})

describe('auditChecksums', () => {
  it('counts a good packet as checked with no mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    const events: TraceEvent[] = [
      { seq: 0, direction: 'recv', offsetMs: 0, hex: payload.toString('hex') },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 1, mismatches: 0 })
  })

  it('counts a corrupted checksum as a mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    payload.writeUInt16LE(0x1234, 2)
    const events: TraceEvent[] = [
      { seq: 0, direction: 'recv', offsetMs: 0, hex: payload.toString('hex') },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 1, mismatches: 1 })
  })

  it('ignores events with no payload', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'error', offsetMs: 0, errorClass: 'ZkTimeoutError' },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 0, mismatches: 0 })
  })
})
