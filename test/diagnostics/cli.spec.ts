import { describe, expect, it } from 'vitest'
import { exitCodeFor, parseCliArgs, resolveReportTargets } from '../../src/cli.js'

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
})
