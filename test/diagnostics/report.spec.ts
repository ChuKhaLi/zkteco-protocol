import { describe, expect, it } from 'vitest'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import type { Findings } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

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
    steps: [{ name: 'firmware', outcome: 'ok' }],
    findings,
  }
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
