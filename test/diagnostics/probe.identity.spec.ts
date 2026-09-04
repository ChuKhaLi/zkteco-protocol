import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { CMD } from '../../src/codec/commands.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { emptyFindings, probeIdentity, sanitizeDeviceString } from '../../src/diagnostics/probe.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

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
    expect(os).toMatchObject({ outcome: 'answered', empty: true })
    const missing = findings.parameters.find((p) => !PARAMS[p.key as keyof typeof PARAMS] && p.key !== '~OS')
    expect(missing?.outcome).toBe('refused')
  })

  it('keeps the serial number value out of findings, recording only presence', async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.identity.serialNumberPresent).toBe(true)
    expect(JSON.stringify(findings)).not.toContain('SN-123')
  })

  it("records a refused parameter read as 'refused', not 'ok'", async () => {
    // §6.1: ACK_ERROR is an answer the device gave, not a bug in this tool --
    // recording it as 'ok' would be indistinguishable from a real empty read.
    running = await startEmulator({ transport: 'tcp', params: {}, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const paramSteps = runner.steps.filter((s) => s.name.startsWith('param:'))
    expect(paramSteps.length).toBeGreaterThan(0)
    expect(paramSteps.every((s) => s.outcome === 'refused')).toBe(true)
  })

  it('does not fabricate a firmware value from an ACK_UNAUTH reply, and records unauthorized', async () => {
    // CMD_GET_VERSION is the read with no other validation of any kind (no
    // echo, no length check) -- an ACK_UNAUTH reply falling through to the
    // decode below would be read as a genuine firmware string. Mirrors
    // src/commands/device.ts's readFirmware() guard.
    running = await startEmulator({
      transport: 'tcp',
      params: PARAMS,
      handlers: { [CMD.GET_VERSION]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    expect(findings.identity.firmwareVersion).toBeNull()
    const firmwareStep = runner.steps.find((s) => s.name === 'firmware')
    expect(firmwareStep?.outcome).toBe('unauthorized')
    // stopsTheRun already says 'unauthorized' is continuable -- assert it,
    // don't assume it.
    expect(runner.truncated).toBeNull()
    expect(runner.steps.some((s) => s.name === 'keyword-shape-ab')).toBe(true)
  })

  it('records unauthorized, not ok, when a parameter read answers ACK_UNAUTH', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: PARAMS,
      firmware: 'Ver 6.60',
      handlers: { [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const paramSteps = runner.steps.filter((s) => s.name.startsWith('param:'))
    expect(paramSteps.length).toBeGreaterThan(0)
    expect(paramSteps.every((s) => s.outcome === 'unauthorized')).toBe(true)
    expect(runner.truncated).toBeNull()
  })

  it("records a refused firmware read as 'refused', not 'ok'", async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: null })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const firmwareStep = runner.steps.find((s) => s.name === 'firmware')
    expect(firmwareStep?.outcome).toBe('refused')
  })

  it('keeps the serial number value out of the step trace as well as findings', async () => {
    // The parameter sweep's runner.run callback return value lands in
    // StepResult.value, which flows into the rendered report independently
    // of `findings`. A guard that only inspects `findings` would miss a leak
    // through this sibling field.
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    expect(JSON.stringify(runner.steps)).not.toContain('SN-123')
  })
})

describe('sanitizeDeviceString', () => {
  it('replaces control characters, which is what lets a name forge a table row', () => {
    expect(sanitizeDeviceString('MB360\n| 3 | x |')).toBe('MB360�| 3 | x |')
    expect(sanitizeDeviceString('a\r\tb')).toBe('a��b')
  })

  it('keeps bytes above 0x9F, which item 20 needs and item 7 prints', () => {
    expect(sanitizeDeviceString('Ünïcode')).toBe('Ünïcode')
  })
})

describe('probeIdentity records what the device answered with', () => {
  it("distinguishes a device that answers without echoing the keyword from one that refuses", async () => {
    // A firmware replying `DeviceName=MB360` to `~DeviceName` used to land as
    // answered: false — indistinguishable from ACK_ERROR, on item 15, whose
    // question is precisely whether the device echoes.
    running = await startEmulator({ transport: 'tcp', params: PARAMS, paramEchoOverride: 'DeviceName' })
    session = await open(running.port)
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeIdentity(session, runner, findings)
    const name = findings.parameters.find((p) => p.key === '~DeviceName')
    expect(name).toMatchObject({ outcome: 'mismatched-echo' })
    // The device answered, so the step is not a refusal.
    expect(runner.steps.find((s) => s.name === 'param:~DeviceName')).toMatchObject({ outcome: 'ok' })
    // And a key this emulator does not carry is still a refusal.
    expect(findings.parameters.find((p) => p.key === 'MAC')).toMatchObject({ outcome: 'refused' })
  })

  it('records an answered keyword as answered, with empty separate', async () => {
    running = await startEmulator({ transport: 'tcp', params: { ...PARAMS, MAC: '' } })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.parameters.find((p) => p.key === '~DeviceName')).toMatchObject({ outcome: 'answered', empty: false })
    expect(findings.parameters.find((p) => p.key === 'MAC')).toMatchObject({ outcome: 'answered', empty: true })
  })

  it('sanitises the identity values it records, at the source', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { ...PARAMS, '~DeviceName': 'MB360\n| 3 | forged |' },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.identity.deviceName).toBe('MB360�| 3 | forged |')
    expect(findings.identity.deviceName).not.toContain('\n')
  })

  it("records 'unauthorized' without throwing when a parameter answers ACK_UNAUTH", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: PARAMS,
      handlers: { [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const steps = runner.steps.filter((s) => s.name.startsWith('param:'))
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) expect(step.outcome).toBe('unauthorized')
    // Unauthorized keys stay out of the array, as before: parameterSummary
    // counts them from the steps, so "tried" stays honest.
    expect(findings.parameters).toEqual([])
  })
})
