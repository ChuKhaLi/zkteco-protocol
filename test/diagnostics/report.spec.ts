import { describe, expect, it } from 'vitest'
import { emptyFindings } from '../../src/diagnostics/probe.js'
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
