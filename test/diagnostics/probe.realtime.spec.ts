import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { encodePayload } from '../../src/codec/packet.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { emptyFindings, probeConcurrent, probeRealtime } from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

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

function attendancePayload(userId: string): Buffer {
  const buf = Buffer.alloc(32)
  buf.write(userId, 0, 9, 'latin1')
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

describe('probeConcurrent', () => {
  it('records that a second connection was accepted', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeConcurrent(new StepRunner(), findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000, commKey: 0,
    })
    expect(findings.concurrent).toMatchObject({ accepted: true, error: null })
  })

  it('records a refused second connection as data rather than throwing', async () => {
    // Item 10 is answered by either outcome. A device that refuses is a real
    // finding, not a failure of the probe.
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeConcurrent(runner, findings, {
      host: '127.0.0.1', port: 1, transport: 'tcp', timeoutMs: 300, commKey: 0,
    })
    expect(findings.concurrent?.accepted).toBe(false)
    expect(findings.concurrent?.error).toBeTruthy()
    // It must not truncate the run: this probe opens its OWN socket, so its
    // failure says nothing about the session the rest of the probe is using.
    expect(runner.truncated).toBeNull()
  })

  it('opens the second connection with the comm key the first one used', async () => {
    // Against a keyed device the probe used to report "a second connection was
    // refused: device requires a comm key" — item 10 answered with this tool's
    // omission rather than with the device's behaviour.
    const COMM_KEY = 483927
    running = await startEmulator({ transport: 'tcp', commKey: COMM_KEY })
    const findings = emptyFindings()
    await probeConcurrent(new StepRunner(), findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000, commKey: COMM_KEY,
    })
    expect(findings.concurrent).toMatchObject({ accepted: true, error: null })
  })

  it('still reports a refusal as a refusal when the key is wrong', async () => {
    running = await startEmulator({ transport: 'tcp', commKey: 483927 })
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeConcurrent(runner, findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000, commKey: 1,
    })
    expect(findings.concurrent?.accepted).toBe(false)
    expect(runner.truncated).toBeNull()
  })
})

describe('probeRealtime', () => {
  it('registers and counts the events that arrive in the window', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('A1'))
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('B2'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 5, sleep, now: fakeNow() })
    expect(findings.realtime).toMatchObject({ registered: true, windowSeconds: 5 })
    expect(findings.realtime!.eventsObserved).toBe(2)
    expect(findings.realtime!.eventTypes).toContain(EVENT_FLAG.ATTENDANCE)
    await session.close().catch(() => {}); session = null
  })

  it('records a refused registration without ending the run', async () => {
    running = await startEmulator({ transport: 'tcp', refuseRegEvent: true })
    session = await open(running.port)
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeRealtime(session, runner, findings, {
      windowSeconds: 1, sleep: async () => {}, now: fakeNow(),
    })
    expect(findings.realtime).toMatchObject({ registered: false })
    expect(findings.realtime?.error).toBeTruthy()
  })

  it('never records event payload contents, only types and a count', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    const runner = new StepRunner()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('SECRET99'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, runner, findings, { windowSeconds: 1, sleep, now: fakeNow() })
    expect(JSON.stringify(findings)).not.toContain('SECRET99')
    // Fix round 1 (F10): `renderJson` spreads `result` -- `steps` and their
    // `value` fields included -- verbatim into the JSON sidecar the CLI
    // writes to disk. It is safe today only because `runner.run`'s callback
    // returns the very same `findings.realtime` object this test already
    // checked above, so there is nothing extra in `runner.steps` to leak --
    // by aliasing coincidence, not by construction. Asserting against
    // `findings` alone would miss a future edit that decorates either
    // returned value with something `findings` never sees; probe.bulk.spec.ts
    // ("keeps no user names or ids in findings") already establishes the
    // pattern of checking both for exactly this reason.
    expect(JSON.stringify(runner.steps)).not.toContain('SECRET99')
    await session.close().catch(() => {}); session = null
  })
})

/** A monotonic fake clock: 10ms per read, so endedAfterMs is deterministic. */
function fakeNow(): () => number {
  let t = 0
  return () => (t += 10)
}

describe('probeRealtime counts only events, and ends when the subscription does', () => {
  it('counts a stray non-event packet separately from events', async () => {
    running = await startEmulator({
      transport: 'tcp',
      pushNonEvent: [encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 9 })],
    })
    session = await open(running.port)
    const findings = emptyFindings()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('A1'))
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('B2'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 5, sleep, now: fakeNow() })
    expect(findings.realtime).toMatchObject({ registered: true, heldOpen: true, eventsObserved: 2, nonEventPackets: 1 })
    await session.close().catch(() => {}); session = null
  })

  it('ends the window when the device drops the connection, and says it did not hold open', async () => {
    running = await startEmulator({ transport: 'tcp', dropAfterRegisterMs: 30 })
    session = await open(running.port)
    const findings = emptyFindings()
    // A 60s window the test must NOT wait out: the drop ends it.
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    // A REAL monotonic clock here, unlike the fakeNow() the counting tests
    // inject. `endedAfterMs` is printed to the operator as "dropped it after
    // Nms" (src/diagnostics/report.ts, item 9), and under fakeNow() it is 10
    // whatever the window did -- so setting the expression to 0 reddened
    // nothing. The purity rule binds src/diagnostics/, not this test.
    const startedAt = performance.now()
    await probeRealtime(session, new StepRunner(), findings, {
      windowSeconds: 60, sleep, now: () => performance.now(),
    })
    const wallMs = performance.now() - startedAt
    expect(findings.realtime).toMatchObject({ registered: true, heldOpen: false })
    expect(findings.realtime!.error).toBeTruthy()
    // Bounded on both sides, because either bound alone is cheap to satisfy
    // by accident. Below: the emulator arms its 30ms destroy timer as it
    // writes the CMD_REG_EVENT ack, a shade before the probe takes its own
    // start, so the measured span can land just under 30 -- 20 is the margin,
    // still an order of magnitude above the fake's 10 and far from 0. Above:
    // the span cannot exceed the probe call that contains it, and must be
    // nowhere near the 60s window it did not wait out.
    const endedAfterMs = findings.realtime!.endedAfterMs
    expect(endedAfterMs).toBeGreaterThanOrEqual(20)
    expect(endedAfterMs).toBeLessThanOrEqual(wallMs)
    expect(endedAfterMs).toBeLessThan(60_000)
    session = null
  }, 10_000)
})
