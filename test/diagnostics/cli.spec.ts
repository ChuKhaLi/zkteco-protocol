import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import {
  describeWrite, exitCodeFor, main, parseCliArgs, resolveReportTargets, writeOutputs,
} from '../../src/cli.js'
import type { CliOptions } from '../../src/cli.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

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

  it('rejects an empty --raw-capture rather than reporting a capture written to nowhere', () => {
    // `--raw-capture=` parsed as '' survived the null check, wrote nothing,
    // and item 1 reported a capture at the path ','.
    expect(() => parseCliArgs(['h', '--raw-capture='])).toThrow(/--raw-capture/)
  })

  it('still accepts a real capture path', () => {
    expect(parseCliArgs(['h', '--raw-capture=trace.jsonl']).rawCapture).toBe('trace.jsonl')
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

/**
 * The only test that drives main() itself.
 *
 * Everything else in this file exercises the pure helpers, and the probe
 * invariants suite reassembles the run out of probeIdentity/probeState/... by
 * hand. Neither notices if runProbe stops calling one of the audits, because
 * neither runs runProbe -- the emptyFindings() default would simply travel to
 * the renderer and read there as a legitimate "not exercised". This closes
 * that hole for the audit added alongside it.
 */
describe('main (end to end, against the emulator)', () => {
  let running: Emulator | null = null
  let dir: string | null = null
  const argv = process.argv
  const exitCode = process.exitCode

  afterEach(async () => {
    await running?.close(); running = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    process.argv = argv
    process.exitCode = exitCode
    vi.restoreAllMocks()
  })

  const COMM_KEY = 483927

  it('reports the comm-key mixing the device demanded, and prints the key nowhere', async () => {
    // The emulator computes its expectation with the library's own
    // mixCommKey, so "accepted" here proves the verdict is WIRED AND RENDERED
    // -- not that the mixing is right for real firmware. Only hardware can
    // answer that, which is the whole reason checklist item 2 exists.
    running = await startEmulator({
      transport: 'tcp',
      commKey: COMM_KEY,
      params: { '~SerialNumber': 'SN-DO-NOT-LEAK', '~DeviceName': 'MB360' },
      firmware: 'Ver 6.60',
      info: { userCount: 0, recordCount: 0, recordCapacity: 1000 },
    })
    dir = mkdtempSync(join(tmpdir(), 'zk-cli-'))
    const out = join(dir, 'report.md')
    // Ruling F7 puts every "wrote ..." line on stderr; silenced so the suite's
    // own output stays clean, not because anything asserts on it.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    process.argv = [
      'node', 'cli.js', '127.0.0.1',
      '--port', String(running.port),
      '--comm-key', String(COMM_KEY),
      '--out', out,
    ]

    await main()

    const markdown = readFileSync(out, 'utf8')
    const json = readFileSync(join(dir, 'report.json'), 'utf8')
    // Scoped to item 2's row: items 5 and 23 legitimately say "not exercised"
    // about entirely different things on this same run.
    const row = markdown.split('\n').find((l) => /^\| 2 \|/.test(l))
    expect(row, 'no row for item 2').toBeDefined()
    expect(row).toMatch(/comm-key mixing: exercised and accepted/i)
    expect(row).not.toMatch(/not exercised/i)
    // The key is a secret its operator typed on a command line, and the
    // Markdown report is written to be pasted into a public issue.
    expect(markdown).not.toContain(String(COMM_KEY))
    expect(json).not.toContain(String(COMM_KEY))
    // Positive control: a renderer that wrote nothing would satisfy every
    // absence above just as well.
    expect(markdown).toContain('MB360')
  })

  it('fills the step table command and ack columns from the real run', async () => {
    // StepRunner takes the trace as a constructor argument, and every caller
    // built one with no arguments until this run did. A runner constructed
    // without it records exactly what it always did, and every assertion about
    // the OTHER columns still passes -- so the two new columns would ship empty
    // on every real invocation with nothing going red.
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'SN-DO-NOT-LEAK', '~DeviceName': 'MB360' },
      firmware: 'Ver 6.60',
      info: { userCount: 0, recordCount: 0, recordCapacity: 1000 },
    })
    dir = mkdtempSync(join(tmpdir(), 'zk-cli-'))
    const out = join(dir, 'report.md')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    process.argv = ['node', 'cli.js', '127.0.0.1', '--port', String(running.port), '--out', out]

    await main()

    const row = readFileSync(out, 'utf8').split('\n').find((l) => l.startsWith('| firmware |'))
    expect(row, 'no step row for firmware').toBeDefined()
    const [, , command, ack] = row!.split('|').map((c) => c.trim())
    // CMD_GET_VERSION answered ACK_OK. Written as literals rather than read
    // back out of CMD, so a wrong constant cannot agree with itself.
    expect(command).toBe('1100')
    expect(ack).toBe('2000')
  })
})
