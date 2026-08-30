import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import {
  describeWrite, exitCodeFor, parseCliArgs, resolveReportTargets, writeOutputs,
} from '../../src/cli.js'
import type { CliOptions } from '../../src/cli.js'

describe('parseCliArgs', () => {
  it('takes the host as a positional and defaults everything else', () => {
    const opts = parseCliArgs(['192.168.1.201'])
    expect(opts).toMatchObject({
      host: '192.168.1.201', port: 4370, transport: 'tcp',
      attendance: 'auto', commKey: 0, rawCapture: null,
    })
  })

  it('accepts the documented flags', () => {
    const opts = parseCliArgs([
      '10.0.0.5', '--transport=udp', '--port=5000', '--comm-key=1234',
      '--attendance=always', '--raw-capture=trace.jsonl', '--timeout=9000',
      '--realtime=30', '--concurrent',
    ])
    expect(opts).toMatchObject({
      host: '10.0.0.5', port: 5000, transport: 'udp', commKey: 1234,
      attendance: 'always', rawCapture: 'trace.jsonl', timeoutMs: 9000,
      realtimeSeconds: 30, concurrent: true,
    })
  })

  it('leaves the one-way probes off unless asked', () => {
    // Subscribing flips the transport irreversibly (Transport.listen is
    // one-way, once per socket). That must not happen to someone who typed
    // the bare command.
    const opts = parseCliArgs(['192.168.1.201'])
    expect(opts.realtimeSeconds).toBe(0)
    expect(opts.concurrent).toBe(false)
  })

  it('rejects an unknown attendance mode rather than silently defaulting', () => {
    expect(() => parseCliArgs(['h', '--attendance=sometimes'])).toThrow(/attendance/)
  })

  it('rejects a missing host', () => {
    expect(() => parseCliArgs([])).toThrow(/host/i)
  })

  it('rejects an unknown transport rather than silently defaulting', () => {
    expect(() => parseCliArgs(['h', '--transport=serial'])).toThrow(/transport/)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseCliArgs(['h', '--port=nope'])).toThrow(/port/)
  })
})

describe('exitCodeFor', () => {
  // Spec §5.5: exit 0 whenever the probe ran, even if the device refused
  // every single read -- a terminal that says no to twenty reads is a
  // successful diagnostic and the report is the deliverable. Exit non-zero
  // only when the probe never got the chance to run (connect failed) or its
  // output never reached disk (a file write failed). This is the pure
  // decision main() defers to, so the rule can be asserted without a socket.

  it('is 0 once connected and the report was written, no matter how the steps came out', () => {
    // The decision type carries no step outcomes at all -- only whether the
    // probe connected and its output landed. That is deliberate: a run where
    // the device refused all twenty reads and a run where it answered all
    // twenty must reach exactly the same exit code, because both produced a
    // report. This is the case main() hits after every step in the run comes
    // back 'refused' or 'unauthorized'.
    expect(exitCodeFor({ connected: true, wroteOutput: true })).toBe(0)
  })

  it('is non-zero when the probe never connected', () => {
    expect(exitCodeFor({ connected: false, wroteOutput: true })).not.toBe(0)
    expect(exitCodeFor({ connected: false, wroteOutput: false })).not.toBe(0)
  })

  it('is non-zero when connected but the output could not be written', () => {
    expect(exitCodeFor({ connected: true, wroteOutput: false })).not.toBe(0)
  })
})

describe('resolveReportTargets', () => {
  it('sends the markdown to stdout and the JSON sidecar to a default file when --out is absent', () => {
    const targets = resolveReportTargets(null)
    expect(targets.markdown).toBe('stdout')
    expect(targets.json).toBe('zkteco-report.json')
  })

  it('puts the JSON sidecar next to a given --out path, swapping its extension', () => {
    expect(resolveReportTargets('report.md')).toEqual({ markdown: 'report.md', json: 'report.json' })
  })

  it('appends .json when --out has no extension of its own', () => {
    expect(resolveReportTargets('out/report')).toEqual({
      markdown: 'out/report', json: 'out/report.json',
    })
  })

  it('does not mistake a directory dot for a file extension', () => {
    expect(resolveReportTargets('out.dir/report')).toEqual({
      markdown: 'out.dir/report', json: 'out.dir/report.json',
    })
  })

  // I-8. `--out report.json` derived the identical path for the sidecar, so
  // the sidecar silently overwrote the Markdown report -- after stderr had
  // already announced writing both. It is a natural thing for someone who
  // wants the JSON to type.
  it('does not derive a sidecar path that would overwrite the Markdown report', () => {
    expect(resolveReportTargets('report.json')).toEqual({
      markdown: 'report.json', json: 'report.sidecar.json',
    })
  })

  it('disambiguates case-insensitively, since Windows paths are', () => {
    expect(resolveReportTargets('report.JSON').json).toBe('report.sidecar.json')
  })
})

/** A minimal ProbeResult, the same shape test/diagnostics/report.spec.ts builds. */
function sampleResult(): ProbeResult {
  return {
    libraryVersion: '0.3.2',
    host: '192.168.1.201',
    transport: 'tcp',
    startedAt: '2026-08-30T00:00:00.000Z',
    durationMs: 12,
    truncated: null,
    rawCapture: null,
    steps: [{ name: 'firmware', outcome: 'ok' }],
    findings: emptyFindings(),
  }
}

describe('describeWrite', () => {
  // Ruling F7: writeOutputs() always writes its files with no prompt and no
  // --force flag, so an unannounced write (new file OR silent overwrite) is
  // the actual defect a reviewer hit -- a file landing with zero signal on
  // either stream. Pure and exported so the exact wording is checkable
  // without a stream or a filesystem.
  it('names the kind and the resolved path', () => {
    expect(describeWrite('the JSON sidecar', 'zkteco-report.json')).toBe(
      'wrote the JSON sidecar to zkteco-report.json\n',
    )
  })
})

/** Not generic, unlike `vi.spyOn` itself -- pins a concrete return type so a
 * `let` holding the result doesn't need (and can't cleanly get) one of its own. */
function spyOnWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, 'write').mockImplementation(() => true)
}

describe('writeOutputs (Ruling F7 — announce every file written, on stderr only)', () => {
  let dir: string
  let stdoutSpy: ReturnType<typeof spyOnWrite>
  let stderrSpy: ReturnType<typeof spyOnWrite>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zkteco-cli-spec-'))
    stdoutSpy = spyOnWrite(process.stdout)
    stderrSpy = spyOnWrite(process.stderr)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
  }
  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('')
  }

  it('announces the JSON sidecar, the Markdown file, and the raw capture -- each exactly once, on stderr, not stdout', async () => {
    const opts: CliOptions = {
      ...parseCliArgs(['192.168.1.201']),
      out: join(dir, 'report.md'),
      rawCapture: join(dir, 'trace.jsonl'),
    }
    const result = sampleResult()

    await writeOutputs(result, [], opts)

    // All three files genuinely landed.
    expect(existsSync(join(dir, 'report.md'))).toBe(true)
    expect(existsSync(join(dir, 'report.json'))).toBe(true)
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true)
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('ZKTeco bring-up report')

    // Every write is announced on stderr, naming its resolved path.
    const err = stderrText()
    expect(err).toContain(join(dir, 'report.md'))
    expect(err).toContain(join(dir, 'report.json'))
    expect(err).toContain(join(dir, 'trace.jsonl'))
    expect(err.match(/\n/g)?.length).toBe(3) // exactly one line per file, no more

    // Nothing wrote to stdout at all in this mode (Markdown went to a file).
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('keeps the Markdown report intact when --out itself ends in .json (I-8)', async () => {
    const opts: CliOptions = {
      ...parseCliArgs(['192.168.1.201']), out: join(dir, 'report.json'), rawCapture: null,
    }
    await writeOutputs(sampleResult(), [], opts)

    // The report the operator asked for is still a report, not a sidecar that
    // landed on top of it a millisecond after stderr announced both.
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).toContain('ZKTeco bring-up report')
    expect(readFileSync(join(dir, 'report.sidecar.json'), 'utf8')).toContain('"libraryVersion"')
    expect(stderrText()).toContain(join(dir, 'report.sidecar.json'))
  })

  it('refuses to point the UNREDACTED raw capture at a shareable artifact, before writing anything', async () => {
    const opts: CliOptions = {
      ...parseCliArgs(['192.168.1.201']),
      out: join(dir, 'report.md'),
      rawCapture: join(dir, 'report.md'),
    }
    await expect(writeOutputs(sampleResult(), [], opts)).rejects.toThrow(/report\.md/)
    // Nothing was written: the check runs before the first writeFile, so a
    // colliding flag cannot destroy a report on its way to failing.
    expect(existsSync(join(dir, 'report.md'))).toBe(false)
    expect(existsSync(join(dir, 'report.json'))).toBe(false)
  })

  it('still writes all three when the raw capture has a path of its own', async () => {
    const opts: CliOptions = {
      ...parseCliArgs(['192.168.1.201']),
      out: join(dir, 'report.md'),
      rawCapture: join(dir, 'trace.jsonl'),
    }
    await writeOutputs(sampleResult(), [], opts)
    for (const f of ['report.md', 'report.json', 'trace.jsonl']) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
  })

  it('does not mix an announcement into stdout when the Markdown itself goes there', async () => {
    const opts: CliOptions = { ...parseCliArgs(['192.168.1.201']), out: null, rawCapture: null }
    const result = sampleResult()

    await writeOutputs(result, [], opts)

    // The Markdown is the primary artifact on stdout -- and ONLY the
    // Markdown; an announcement line mixed in here is exactly what would
    // corrupt `zkteco-protocol host > report.md`.
    const out = stdoutText()
    expect(out).toContain('ZKTeco bring-up report')
    expect(out).not.toMatch(/^wrote /m)

    // The JSON sidecar (still a real file by default) is announced, and
    // only on stderr.
    const err = stderrText()
    expect(err).toMatch(/wrote the JSON sidecar to /)
    expect(err).not.toContain('ZKTeco bring-up report')

    rmSync('zkteco-report.json', { force: true }) // the default target, written to CWD
  })
})
