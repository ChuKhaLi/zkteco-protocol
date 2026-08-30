import { describe, expect, it } from 'vitest'
import { START_MARKER, tryUnframeTcp } from '../../src/codec/framing.js'
import { parseUserData } from '../../src/codec/records/user.js'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import type { Findings } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import type { StepResult, TraceEvent } from '../../src/diagnostics/types.js'

function sample(): ProbeResult {
  const findings = emptyFindings()
  findings.identity.deviceName = 'MB360'
  findings.identity.firmwareVersion = 'Ver 6.60'
  findings.identity.serialNumberPresent = true
  findings.keywordForm = 'both'
  return {
    libraryVersion: '0.4.0',
    host: '192.168.1.201',
    transport: 'tcp',
    startedAt: '2026-08-30T00:00:00.000Z',
    durationMs: 1234,
    truncated: null,
    // The default run: no --raw-capture. This is the invocation the README
    // documents first, and the one C-2 was rendered from.
    rawCapture: null,
    steps: [{ name: 'firmware', outcome: 'ok' }],
    findings,
  }
}

/** A run that both captured bytes and read attendance — item 1's full evidence. */
function withCapture(path: string, rowCount = 3): ProbeResult {
  const result = sample()
  result.rawCapture = path
  result.findings.attendance = {
    read: true, skippedReason: null, detectedRecordSize: 40, rowCount,
  }
  return result
}

describe('renderMarkdown', () => {
  it('is deterministic for the same input', () => {
    expect(renderMarkdown(sample())).toBe(renderMarkdown(sample()))
  })

  it('names the model, which item 7 needs for the compatibility table', () => {
    const md = renderMarkdown(sample())
    expect(md).toContain('MB360')
    expect(md).toContain('Ver 6.60')
  })

  it('states that item 22 is not testable by this tool rather than omitting it', () => {
    // An absence must be visible as an absence at the point a reader would
    // otherwise assume presence.
    expect(renderMarkdown(sample())).toMatch(/22[^\n]*not testable/i)
  })

  it('says the run was truncated, and where', () => {
    const result = { ...sample(), truncated: { after: 'clock', reason: 'silent' } }
    const md = renderMarkdown(result)
    expect(md).toMatch(/truncated/i)
    expect(md).toContain('clock')
  })

  it('spells out what a bare-only verdict means for the library', () => {
    const result = sample()
    result.findings.keywordForm = 'bare-only'
    expect(renderMarkdown(result)).toMatch(/encodeParamRequest/)
  })

  it("warns that a 'neither' verdict is a keyword question, not a shape question", () => {
    const result = sample()
    result.findings.keywordForm = 'neither'
    expect(renderMarkdown(result)).toMatch(/item 17/i)
  })

  it("marks the one-way probes 'not requested' when they were not run", () => {
    const md = renderMarkdown(sample())   // findings.realtime and .concurrent are null
    expect(md).toMatch(/not requested/i)
    expect(md).not.toMatch(/item 10[^\n]*not answered/i)
  })
})

/**
 * Reads the `state` cell out of one checklist table row, by item number.
 *
 * Splitting on `|` and trusting positional indices is safe here specifically
 * because none of the question/observation text this file's fixtures produce
 * contains a literal `|` — the table format itself is `| item | question |
 * state | observation |`.
 */
function checklistState(md: string, item: number): string {
  const line = md.split('\n').find((l) => l.startsWith(`| ${item} |`))
  if (!line) throw new Error(`no checklist row found for item ${item}`)
  const cells = line.split('|').map((c) => c.trim())
  return cells[3] ?? ''
}

function withRealtime(overrides: Partial<NonNullable<Findings['realtime']>>): ProbeResult {
  const result = sample()
  result.findings.realtime = {
    windowSeconds: 5,
    registered: false,
    eventsObserved: 0,
    eventTypes: [],
    desyncOnRegister: false,
    error: null,
    ...overrides,
  }
  return result
}

function withConcurrent(overrides: Partial<NonNullable<Findings['concurrent']>>): ProbeResult {
  const result = sample()
  result.findings.concurrent = { attempted: true, accepted: false, error: null, ...overrides }
  return result
}

/**
 * Fix round 1, F9: the three-way realtime/concurrent -> checklist-state
 * mapping was hand-verified by a reviewer once and locked in by nothing —
 * these tests exercise it through the actual renderer, the same way a real
 * report would be read, for the four cases the reviewer walked by hand.
 */
describe('the realtime/concurrent checklist mapping (Fix round 1, F9)', () => {
  it('a completed subscription answers 8/9/13, leaves 14 not answered, and 12 stays not testable', () => {
    const md = renderMarkdown(
      withRealtime({ registered: true, eventsObserved: 2, eventTypes: [1], desyncOnRegister: false }),
    )
    expect(checklistState(md, 8)).toBe('answered')
    expect(checklistState(md, 9)).toBe('answered')
    expect(checklistState(md, 13)).toBe('answered')
    expect(checklistState(md, 14)).toBe('not answered')
    // F11: item 12 has no supporting mechanism in ANY branch -- this library
    // has no cancel/unsubscribe primitive, so a completed window must not
    // make it look answered.
    expect(checklistState(md, 12)).toBe('not testable by this tool')
  })

  it('a refused registration leaves 8/9/13/14 all not answered', () => {
    const md = renderMarkdown(
      withRealtime({
        registered: false,
        error: 'device refused a realtime subscription with command 1001',
        desyncOnRegister: false,
      }),
    )
    for (const item of [8, 9, 13, 14]) expect(checklistState(md, item)).toBe('not answered')
    expect(checklistState(md, 12)).toBe('not testable by this tool')
  })

  it('a desync answers item 14 alone, even though 8/9/13 stay not answered on the same run', () => {
    const md = renderMarkdown(
      withRealtime({
        registered: false,
        error: 'a realtime event arrived where the CMD_REG_EVENT reply was expected: out of step',
        desyncOnRegister: true,
      }),
    )
    expect(checklistState(md, 14)).toBe('answered')
    for (const item of [8, 9, 13]) expect(checklistState(md, item)).toBe('not answered')
  })

  it('item 10 is answered whether the second connection was accepted or refused', () => {
    const accepted = renderMarkdown(withConcurrent({ accepted: true, error: null }))
    const declined = renderMarkdown(withConcurrent({ accepted: false, error: 'connection refused' }))
    expect(checklistState(accepted, 10)).toBe('answered')
    expect(checklistState(declined, 10)).toBe('answered')
  })
})

/**
 * C-2. Item 1 said `answered` and pointed at "the accompanying raw capture" on
 * a run that writes no such file — the README's own default invocation. Both
 * directions again, plus the second half of the question ("and one attendance
 * read"), which `steps.length > 0` was satisfied by the firmware step alone.
 */
describe('item 1 — the raw byte dump (C-2)', () => {
  it('is not answered on a default run, and says the bytes are gone', () => {
    const md = renderMarkdown(sample()) // rawCapture: null, one step traced
    expect(checklistState(md, 1)).toBe('not answered')
    expect(md).toMatch(/1 \|[^\n]*--raw-capture/)
    // The false claim itself, named so a re-introduction cannot pass quietly.
    expect(md).not.toMatch(/accompanying raw capture/)
  })

  it('is answered, naming the file, when a capture was requested and attendance was read', () => {
    const md = renderMarkdown(withCapture('trace.jsonl'))
    expect(checklistState(md, 1)).toBe('answered')
    expect(md).toMatch(/1 \|[^\n]*trace\.jsonl/)
  })

  it('stays not answered when the capture exists but attendance was skipped', () => {
    // "a full handshake AND one attendance read" -- half the evidence is not
    // an answer, and --attendance=never is a normal thing to pass.
    const result = withCapture('trace.jsonl')
    result.findings.attendance = {
      read: false, skippedReason: 'skipped: --attendance=never', detectedRecordSize: null, rowCount: 0,
    }
    const md = renderMarkdown(result)
    expect(checklistState(md, 1)).toBe('not answered')
    expect(md).toMatch(/1 \|[^\n]*--attendance=never/)
  })
})

/** Runs one throwing callback through a real StepRunner, as the probe would. */
async function stepsFrom(name: string, fn: () => unknown): Promise<readonly StepResult[]> {
  const runner = new StepRunner()
  await runner.run(name, async () => fn())
  return runner.steps
}

/**
 * C-1. Item 5 names exactly one constant — MAX_DECLARED_SIZE in
 * src/codec/framing.ts — and the row was matching `ZkFramingError`, which that
 * file never throws and the two RECORD parsers throw seven times. Both
 * directions are tested because they are independent defects: the false
 * negative loses the one event the row exists to catch, and the false positive
 * prints `answered` about framing.ts while citing an error from
 * codec/records/user.ts.
 *
 * Both errors come from the REAL library functions rather than a hand-written
 * message, so a reworded throw site reddens this test instead of silently
 * disabling the row.
 */
describe('item 5 — the TCP declared-size cap (C-1)', () => {
  it('answers item 5 when the declared-size cap actually fires', async () => {
    const oversized = Buffer.alloc(8)
    START_MARKER.copy(oversized, 0)
    oversized.writeUInt32LE(0x00ff_ffff, 4) // far above MAX_CHUNK.tcp + 8
    const steps = await stepsFrom('firmware', () => tryUnframeTcp(oversized))

    // The premise, asserted rather than assumed: the cap throws
    // ZkProtocolError, and TcpTransport propagates it unwrapped.
    expect(steps[0]).toMatchObject({ outcome: 'malformed', errorClass: 'ZkProtocolError' })

    const md = renderMarkdown({ ...sample(), steps })
    expect(checklistState(md, 5)).toBe('answered')
  })

  it('leaves item 5 not answered when a record parser throws ZkFramingError', async () => {
    // A user body that declares more than arrived — nothing to do with the TCP
    // declared-size cap, and the exact shape that used to print `answered`.
    const short = Buffer.alloc(4 + 144)
    short.writeUInt32LE(800, 0)
    const steps = await stepsFrom('users', () => parseUserData(short))

    expect(steps[0]).toMatchObject({ outcome: 'malformed', errorClass: 'ZkFramingError' })

    const md = renderMarkdown({ ...sample(), steps })
    expect(checklistState(md, 5)).toBe('not answered')
  })

  it('says where the rejected bytes are, since the report no longer carries them', async () => {
    const oversized = Buffer.alloc(8)
    START_MARKER.copy(oversized, 0)
    oversized.writeUInt32LE(0x00ff_ffff, 4)
    const steps = await stepsFrom('firmware', () => tryUnframeTcp(oversized))
    const md = renderMarkdown({ ...sample(), steps })
    // Spec §4.5 names the framing error's `raw` as item 5's evidence; F5
    // removed `raw` from StepResult, so the row must point at the opt-in
    // capture instead of leaving a reader hunting for bytes that are not here.
    expect(md).toMatch(/5 \|[^\n]*--raw-capture/)
  })
})

describe('renderRawCapture', () => {
  it('emits one JSON object per line, after a header line', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'send', offsetMs: 0, hex: 'aabb' },
      { seq: 1, direction: 'recv', offsetMs: 1, hex: 'ccdd' },
    ]
    const lines = renderRawCapture(events).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    const header = JSON.parse(lines[0]!)
    // The header must say what is in the file, in words, before anyone
    // attaches it to a public issue.
    expect(header.warning).toMatch(/comm key/i)
    expect(JSON.parse(lines[1]!).hex).toBe('aabb')
  })
})

describe('renderJson', () => {
  it('carries the same findings as the markdown', () => {
    const json = renderJson(sample()) as { findings: { identity: { deviceName: string } } }
    expect(json.findings.identity.deviceName).toBe('MB360')
  })
})
