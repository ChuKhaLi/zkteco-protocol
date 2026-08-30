import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_FLAG } from '../../src/codec/events.js'
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
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000,
    })
    expect(findings.concurrent).toMatchObject({ attempted: true, accepted: true, error: null })
  })

  it('records a refused second connection as data rather than throwing', async () => {
    // Item 10 is answered by either outcome. A device that refuses is a real
    // finding, not a failure of the probe.
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeConcurrent(runner, findings, {
      host: '127.0.0.1', port: 1, transport: 'tcp', timeoutMs: 300,
    })
    expect(findings.concurrent?.accepted).toBe(false)
    expect(findings.concurrent?.error).toBeTruthy()
    // It must not truncate the run: this probe opens its OWN socket, so its
    // failure says nothing about the session the rest of the probe is using.
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
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 5, sleep })
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
      windowSeconds: 1, sleep: async () => {},
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
    await probeRealtime(session, runner, findings, { windowSeconds: 1, sleep })
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
