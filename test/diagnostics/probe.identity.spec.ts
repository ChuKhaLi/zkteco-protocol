import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { emptyFindings, probeIdentity } from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const PARAMS = {
  '~SerialNumber': 'SN-123',
  '~DeviceName': 'MB360',
  '~Platform': 'ZMM220_TFT',
  '~OS': 'Linux',
}

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 1000 })
  await s.open()
  return s
}

describe('probeIdentity', () => {
  it("reports 'both' when the device tolerates either keyword shape", async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('both')
  })

  it("reports 'nul-only' when the device refuses the bare shape", async () => {
    running = await startEmulator({
      transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60', keywordForm: 'nul',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('nul-only')
  })

  it("reports 'bare-only' when the device refuses the NUL-terminated shape", async () => {
    // This is the outcome that would refute encodeParamRequest. It is the whole
    // reason the A/B exists, and the emulator's tolerant default cannot produce it.
    running = await startEmulator({
      transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60', keywordForm: 'bare',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('bare-only')
  })

  it("reports 'neither' when the keyword itself is unsupported", async () => {
    running = await startEmulator({ transport: 'tcp', params: {}, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('neither')
  })

  it('records the firmware control read before any parameter read', async () => {
    // GET_VERSION carries an empty payload and so is untouched by the keyword
    // shape question. If it answers and every parameter refuses, that is the
    // item-18 signature rather than an item-16 answer.
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const names = runner.steps.map((s) => s.name)
    expect(names[0]).toBe('firmware')
    expect(names.indexOf('firmware')).toBeLessThan(names.indexOf('keyword-shape-ab'))
    expect(findings.identity.firmwareVersion).toBe('Ver 6.60')
  })

  it('records each parameter as answered, empty, or refused', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { ...PARAMS, '~OS': '' },
      firmware: 'Ver 6.60',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    const os = findings.parameters.find((p) => p.key === '~OS')
    expect(os).toMatchObject({ answered: true, empty: true })
    const missing = findings.parameters.find((p) => !PARAMS[p.key as keyof typeof PARAMS] && p.key !== '~OS')
    expect(missing?.answered).toBe(false)
  })

  it('keeps the serial number value out of findings, recording only presence', async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.identity.serialNumberPresent).toBe(true)
    expect(JSON.stringify(findings)).not.toContain('SN-123')
  })
})
