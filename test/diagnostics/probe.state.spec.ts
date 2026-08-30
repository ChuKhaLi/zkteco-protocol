import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import {
  auditChecksums, auditReplyIds, emptyFindings, FREE_SIZES_RAW_MAX_BYTES, probeState,
} from '../../src/diagnostics/probe.js'
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

  /**
   * I-7. The raw body is the sole verbatim device payload in the
   * always-written JSON sidecar, and it was recorded unbounded -- everything
   * the device sent, however long, from a reply nobody has ever seen. Item 4
   * needs it (FREE_SIZES_OFFSET is unverified and its highest field ends at
   * byte 68), so the fix is a bound, not a removal.
   */
  it('caps the raw free-sizes body rather than recording whatever arrived', async () => {
    const oversized = Buffer.alloc(FREE_SIZES_RAW_MAX_BYTES * 3, 0xab)
    oversized.writeUInt32LE(7, 16)
    running = await startEmulator({
      transport: 'tcp',
      handlers: {
        [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK, oversized)],
      },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.freeSizes?.userCount).toBe(7) // the reply really was decoded
    expect(findings.freeSizes?.rawHex).toHaveLength(FREE_SIZES_RAW_MAX_BYTES * 2)
  })

  it('does not truncate a body that already fits under the cap', async () => {
    const short = Buffer.alloc(72, 0xcd)
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK, short)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.freeSizes?.rawHex).toBe(short.toString('hex'))
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

/** One traced payload, in the given direction. */
function event(direction: TraceEvent['direction'], payload: Buffer, seq = 0): TraceEvent {
  const decoded = { seq, direction, offsetMs: 0, hex: payload.toString('hex') }
  return direction === 'error' ? decoded : { ...decoded, replyId: payload.readUInt16LE(6) }
}

describe('auditChecksums', () => {
  it('counts a good device packet as checked with no mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    expect(auditChecksums([event('recv', payload)])).toEqual({
      received: { packetsChecked: 1, mismatches: 0 },
      sent: { packetsChecked: 0, mismatches: 0 },
    })
  })

  it('counts a corrupted checksum as a mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    payload.writeUInt16LE(0x1234, 2)
    expect(auditChecksums([event('recv', payload)]).received).toEqual({
      packetsChecked: 1, mismatches: 1,
    })
  })

  it('ignores events with no payload', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'error', offsetMs: 0, errorClass: 'ZkTimeoutError' },
    ]
    expect(auditChecksums(events)).toEqual({
      received: { packetsChecked: 0, mismatches: 0 },
      sent: { packetsChecked: 0, mismatches: 0 },
    })
  })

  // M-9(b). A `send` payload was built by checksum16 moments earlier, so
  // recomputing it can never disagree -- roughly half of the old combined
  // count was this tool agreeing with itself, inflating the one number a
  // reader uses to judge whether 5's formulation survives contact with
  // hardware.
  it('keeps our own sent packets out of the device total, as a positive control', () => {
    const ours = encodePayload({ command: CMD.GET_VERSION, sessionId: 1, replyId: 1 })
    const theirs = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 1 })
    const audit = auditChecksums([event('send', ours), event('recv', theirs, 1)])
    expect(audit.received.packetsChecked).toBe(1)
    expect(audit.sent.packetsChecked).toBe(1)
  })

  it('counts a device push as the device, not as us', () => {
    const pushed = encodePayload({ command: CMD.REG_EVENT, sessionId: 1, replyId: 0 })
    expect(auditChecksums([event('push', pushed)]).received.packetsChecked).toBe(1)
  })
})

/**
 * M-9(a). Spec 5.1 asks for "locally computed checksum AND reply-id verdicts";
 * TraceEvent.replyId was recorded and then read by nothing, while item 2 said
 * `answered` on the checksum third alone.
 *
 * Reported as an observation, not a pass/fail judgment: whether a device
 * echoes the request's reply id is exactly the quirk item 2 exists to find
 * out, so a device that does not echo is data, not a failure.
 */
describe('auditReplyIds', () => {
  function exchange(requestId: number, replyIdOnTheReply: number): TraceEvent[] {
    return [
      event('send', encodePayload({ command: CMD.GET_VERSION, sessionId: 1, replyId: requestId })),
      event('recv', encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: replyIdOnTheReply }), 1),
    ]
  }

  it('counts a reply that echoes the request id', () => {
    expect(auditReplyIds(exchange(7, 7))).toEqual({ repliesChecked: 1, echoedRequestId: 1 })
  })

  it('counts a reply that does not echo it', () => {
    expect(auditReplyIds(exchange(7, 8))).toEqual({ repliesChecked: 1, echoedRequestId: 0 })
  })

  it('ignores a reply with no request before it', () => {
    const [, orphan] = exchange(7, 7)
    expect(auditReplyIds([orphan!])).toEqual({ repliesChecked: 0, echoedRequestId: 0 })
  })
})
