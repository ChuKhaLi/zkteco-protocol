#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { auditChecksums, emptyFindings, probeBulk, probeIdentity, probeState } from './diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture, type ProbeResult } from './diagnostics/report.js'
import { StepRunner } from './diagnostics/step.js'
import { TracingTransport } from './diagnostics/TracingTransport.js'
import type { TraceEvent } from './diagnostics/types.js'
import { VERSION } from './index.js'
import { Session } from './session/Session.js'
import { TcpTransport } from './transport/tcp.js'
import type { Transport } from './transport/Transport.js'
import { UdpTransport } from './transport/udp.js'

/**
 * This is the ONE impure module. Argument parsing, the clock, the filesystem
 * and exit codes live here and nowhere else, which is what keeps `probe.ts`,
 * `report.ts` and `TracingTransport.ts` deterministic under test (design
 * spec §3.3, §7.3). Nothing in this file should be reused for its logic --
 * only for its plumbing.
 */

export interface CliOptions {
  host: string
  port: number
  transport: 'tcp' | 'udp'
  commKey: number
  timeoutMs: number
  attendance: 'auto' | 'always' | 'never'
  rawCapture: string | null
  out: string | null
  /** 0 (the default) means off. Task 10 wires this up; see main(). */
  realtimeSeconds: number
  /** Task 10 wires this up; see main(). */
  concurrent: boolean
}

const TRANSPORTS = ['tcp', 'udp'] as const
const ATTENDANCE_MODES = ['auto', 'always', 'never'] as const

function isOneOf<T extends string>(values: readonly T[], candidate: string): candidate is T {
  return (values as readonly string[]).includes(candidate)
}

/** Parses `--name=value`/`--name value`, throwing `Error` naming `name` on a non-finite result. */
function parseNumberOption(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got '${raw}'`)
  return n
}

/**
 * Parses argv into `CliOptions`.
 *
 * Uses `parseArgs` from `node:util` — no argument-parsing dependency is
 * needed for a tool with this few flags, and adding one would violate the
 * zero-runtime-dependencies constraint the rest of the library keeps.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      transport: { type: 'string' },
      port: { type: 'string' },
      'comm-key': { type: 'string' },
      attendance: { type: 'string' },
      'raw-capture': { type: 'string' },
      out: { type: 'string' },
      timeout: { type: 'string' },
      realtime: { type: 'string' },
      concurrent: { type: 'boolean' },
    },
  })

  const host = positionals[0]
  if (!host) throw new Error('a host is required: zkteco-protocol <host>')

  const transport = values.transport ?? 'tcp'
  if (!isOneOf(TRANSPORTS, transport)) {
    throw new Error(`--transport must be one of ${TRANSPORTS.join(', ')}, got '${transport}'`)
  }

  const attendance = values.attendance ?? 'auto'
  if (!isOneOf(ATTENDANCE_MODES, attendance)) {
    throw new Error(`--attendance must be one of ${ATTENDANCE_MODES.join(', ')}, got '${attendance}'`)
  }

  return {
    host,
    port: parseNumberOption('port', values.port, 4370),
    transport,
    commKey: parseNumberOption('comm-key', values['comm-key'], 0),
    timeoutMs: parseNumberOption('timeout', values.timeout, 5000),
    attendance,
    rawCapture: values['raw-capture'] ?? null,
    out: values.out ?? null,
    realtimeSeconds: parseNumberOption('realtime', values.realtime, 0),
    concurrent: values.concurrent ?? false,
  }
}

/**
 * Where the two mandatory report artifacts go, given `--out` (or its
 * absence).
 *
 * Pure and exported so the routing decision is checkable without touching a
 * filesystem. The brief only says the JSON sidecar lands "next to" the
 * Markdown report; when `--out` is omitted the Markdown goes to stdout,
 * which has no directory to be "next to", so the sidecar still gets a real
 * file (`zkteco-report.json` in the current directory) rather than being
 * silently dropped or interleaved onto the same stream as the Markdown --
 * doing the latter would corrupt `zkteco-protocol host > report.md`, the
 * most obvious way someone captures the Markdown by hand.
 */
export function resolveReportTargets(out: string | null): { markdown: string; json: string } {
  const base = out ?? 'zkteco-report.md'
  return { markdown: out === null ? 'stdout' : out, json: deriveJsonPath(base) }
}

/** Swaps a trailing file extension for `.json`, or appends one if there is none. */
function deriveJsonPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot > slash) return `${path.slice(0, dot)}.json`
  return `${path}.json`
}

/**
 * The pure exit-code decision behind main() -- Spec §5.5.
 *
 * Exit 0 whenever the probe RAN, even if the device refused every single
 * step: a terminal that says no to twenty reads is a successful diagnostic
 * and the report is the deliverable. Non-zero only when the probe never got
 * the chance to run (`connected: false`) or its output never reached disk
 * (`wroteOutput: false`). Getting this backwards would make the tool look
 * broken exactly when it is working.
 *
 * Deliberately blind to `Findings`/`StepResult` -- the whole point is that
 * how the steps came out plays no part in this decision. Factored out of
 * main() so the rule can be asserted directly, without a socket.
 */
export function exitCodeFor(outcome: { connected: boolean; wroteOutput: boolean }): number {
  if (!outcome.connected) return 1
  if (!outcome.wroteOutput) return 1
  return 0
}

function makeTransport(opts: CliOptions): Transport {
  const t = { host: opts.host, port: opts.port }
  return opts.transport === 'tcp' ? new TcpTransport(t) : new UdpTransport(t)
}

async function writeOutputs(
  result: ProbeResult,
  events: readonly TraceEvent[],
  opts: CliOptions,
): Promise<void> {
  const targets = resolveReportTargets(opts.out)
  const markdown = renderMarkdown(result)
  const json = JSON.stringify(renderJson(result), null, 2)

  if (targets.markdown === 'stdout') {
    process.stdout.write(markdown)
  } else {
    await writeFile(targets.markdown, markdown, 'utf8')
  }
  await writeFile(targets.json, json, 'utf8')

  if (opts.rawCapture) {
    await writeFile(opts.rawCapture, renderRawCapture(events), 'utf8')
  }
}

/**
 * Runs one probe against `opts.host` and writes its artifacts.
 *
 * Order is not cosmetic (design spec §4.1, and the brief this task started
 * from): identity, then state, then bulk, in that fixed sequence, because the
 * control read (`probeIdentity`'s CMD_GET_VERSION) must precede the
 * parameter sweep it disambiguates, and free-sizes (`probeState`) must
 * precede the attendance-size decision `probeBulk` makes from it.
 * `probeConcurrent` — opt-in via `--concurrent` — would run next, because it
 * needs the first session still usable. `probeRealtime` — opt-in via
 * `--realtime` — runs last of all, because subscribing flips the transport
 * one-way (`Transport.listen`) and nothing can follow it.
 *
 * TASK 10 TODO: neither probe exists yet. Wire `probeConcurrent(session, ...)`
 * here, gated on `opts.concurrent`, immediately after `probeBulk` and before
 * the checksum audit below (the session is still open and unsubscribed at
 * that point). Wire `probeRealtime(session, ...)` after that, gated on
 * `opts.realtimeSeconds > 0`, and nothing else may run after it.
 */
async function runProbe(session: Session, traced: TracingTransport, opts: CliOptions): Promise<ProbeResult> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const findings = emptyFindings()
  const runner = new StepRunner()

  try {
    await probeIdentity(session, runner, findings)
    await probeState(session, runner, findings, Math.floor(Date.now() / 1000))
    await probeBulk(
      session, runner, findings, { transport: opts.transport, attendance: opts.attendance }, traced.events,
    )

    // TASK 10 GAP -- see this function's doc comment. `opts.concurrent` and
    // `opts.realtimeSeconds` are already parsed and threaded through; only
    // the probes themselves are missing.

    findings.checksum = auditChecksums(traced.events)
  } finally {
    await session.close().catch(() => {})
  }

  return {
    libraryVersion: VERSION,
    host: opts.host,
    transport: opts.transport,
    startedAt,
    durationMs: Date.now() - t0,
    truncated: runner.truncated,
    steps: runner.steps,
    findings,
  }
}

export async function main(): Promise<void> {
  let opts: CliOptions
  try {
    opts = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exitCode = 1
    return
  }

  // Neither probe exists yet (Task 10). A flag that silently does nothing is
  // worse than one that does not exist -- see this file's runProbe() doc
  // comment for where these get wired up.
  if (opts.realtimeSeconds > 0) {
    process.stderr.write(
      '--realtime was given, but the realtime probe is not implemented yet (Task 10); it will not run.\n',
    )
  }
  if (opts.concurrent) {
    process.stderr.write(
      '--concurrent was given, but the second-connection probe is not implemented yet (Task 10); it will not run.\n',
    )
  }

  const traced = new TracingTransport(makeTransport(opts), () => Date.now())
  const session = new Session(traced, { timeoutMs: opts.timeoutMs, commKey: opts.commKey })

  let connected = true
  try {
    await session.open()
  } catch (err) {
    connected = false
    process.stderr.write(`could not connect to ${opts.host}:${opts.port}: ${(err as Error).message}\n`)
  }
  if (!connected) {
    process.exitCode = exitCodeFor({ connected: false, wroteOutput: false })
    return
  }

  const result = await runProbe(session, traced, opts)

  let wroteOutput = true
  try {
    await writeOutputs(result, traced.events, opts)
  } catch (err) {
    wroteOutput = false
    process.stderr.write(`could not write report output: ${(err as Error).message}\n`)
  }

  process.exitCode = exitCodeFor({ connected, wroteOutput })
}

// Not `await main()` at top level: tsup builds this entry as both ESM and
// CJS (tsup.config.ts's `format`, unchanged by this task), and top-level
// await is not legal CJS syntax -- esbuild fails the WHOLE cjs pass on it,
// which took dist/index.cjs down with it even though index.ts never
// touches this file. `.catch()` keeps this file's only shipped artifact
// (dist/cli.js, per the bin field) working under either format, and turns
// an unexpected escape past every internal try/catch in main() into a
// message and a non-zero exit rather than a raw unhandled-rejection crash.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`)
    process.exitCode = 1
  })
}
