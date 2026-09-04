#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  auditChecksums, auditCommKey, auditReplyIds, emptyFindings, probeBulk, probeConcurrent, probeIdentity,
  probeRealtime, probeState,
} from './diagnostics/probe.js'
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
  /** 0 (the default) means off — the realtime probe is opt-in; see runProbe(). */
  realtimeSeconds: number
  /** false (the default) means off — the second-connection probe is opt-in; see runProbe(). */
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
  const markdown = out === null ? 'stdout' : out
  const json = deriveJsonPath(base)
  // `--out report.json` derives the IDENTICAL path for the sidecar, and both
  // targets are then written in order: the Markdown report lands, stderr
  // announces it, and the sidecar overwrites it a millisecond later while
  // writeOutputs reports success and the process exits 0. Someone who wants
  // the JSON is exactly the person who types that. Disambiguate rather than
  // reject -- both artifacts are mandatory, and losing one to a flag spelling
  // helps nobody.
  if (!samePath(markdown, json)) return { markdown, json }
  return { markdown, json: `${json.slice(0, json.lastIndexOf('.'))}.sidecar.json` }
}

/**
 * Would these two paths write the same file?
 *
 * Compared case-insensitively because this tool runs on Windows, where
 * `report.JSON` and `report.json` ARE one file. On a case-sensitive
 * filesystem the worst this costs is a disambiguated name for two paths that
 * would not actually have collided -- both files still get written, which is
 * the failure this check exists to prevent, in reverse and harmless.
 *
 * Not a path resolution: `./report.md` and `report.md` still slip past. That
 * is deliberate -- resolving would need the cwd, and this function is pure so
 * the routing decision stays checkable without a filesystem. It catches the
 * collision the tool DERIVES for itself, which is the one nobody typed.
 */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
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

/**
 * The stderr line printed after `writeOutputs` actually writes a file.
 *
 * Pure and exported so the wording is checkable without a stream or a
 * filesystem. Ruling F7: `writeOutputs` writes every one of its files with no
 * prompt and no `--force` flag -- the reviewer's finding was that a run from
 * a scratch directory left `zkteco-report.json` on disk with stdout AND
 * stderr both silent, so neither "a new file appeared" nor "an existing one
 * was just clobbered" was visible anywhere. One line per file, always, is
 * what fixes both halves of that at once: whoever is watching stderr sees
 * every file this run touched, freshly written or overwritten alike.
 */
export function describeWrite(kind: string, path: string): string {
  return `wrote ${kind} to ${path}\n`
}

/**
 * Writes the run's artifacts, announcing every file it actually writes.
 *
 * Announcements go to stderr ONLY, never stdout -- stdout is where the
 * Markdown itself lands when `--out` was not given, and mixing an
 * announcement line into that stream would corrupt the most obvious way
 * someone captures it, `zkteco-protocol host > report.md` (Ruling F7).
 *
 * Exported so this can be verified directly against a real temp directory
 * and spied `process.stdout`/`process.stderr` writers, without needing a
 * session or a socket -- see test/diagnostics/cli.spec.ts.
 */
export async function writeOutputs(
  result: ProbeResult,
  events: readonly TraceEvent[],
  opts: CliOptions,
): Promise<void> {
  const targets = resolveReportTargets(opts.out)

  // Checked BEFORE the first write, so a colliding flag cannot destroy a
  // report on its way to failing. `--raw-capture` is a path the operator typed
  // in full, so this rejects rather than renaming it behind their back -- and
  // it rejects loudly, because the raw capture is UNREDACTED: landing it on
  // top of a shareable artifact turns "the report" into the comm key, the
  // serial and every employee name, under a filename that says otherwise.
  if (opts.rawCapture !== null) {
    const clash = [targets.markdown, targets.json].find((t) => samePath(t, opts.rawCapture as string))
    if (clash) {
      throw new Error(
        `--raw-capture ${opts.rawCapture} would overwrite ${clash}. The raw capture is UNREDACTED; give it a path of its own.`,
      )
    }
  }

  const markdown = renderMarkdown(result)
  const json = JSON.stringify(renderJson(result), null, 2)

  if (targets.markdown === 'stdout') {
    process.stdout.write(markdown)
  } else {
    await writeFile(targets.markdown, markdown, 'utf8')
    process.stderr.write(describeWrite('the Markdown report', targets.markdown))
  }

  await writeFile(targets.json, json, 'utf8')
  process.stderr.write(describeWrite('the JSON sidecar', targets.json))

  if (opts.rawCapture) {
    await writeFile(opts.rawCapture, renderRawCapture(events), 'utf8')
    process.stderr.write(describeWrite('the raw capture', opts.rawCapture))
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
 * `probeConcurrent` — opt-in via `--concurrent` — runs next, because it
 * needs the first session still usable and its own socket doesn't touch that
 * session. `probeRealtime` — opt-in via `--realtime` — runs last of all,
 * because subscribing flips the transport one-way (`Transport.listen`) and
 * nothing can follow it.
 */
async function runProbe(session: Session, traced: TracingTransport, opts: CliOptions): Promise<ProbeResult> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const findings = emptyFindings()
  // The trace is handed to the runner so each step can carry the command it
  // sent and the code the device answered (design spec 5.1). A reader, not the
  // array: TracingTransport appends to its own log, and the runner needs the
  // length before a step as well as the entries after it.
  //
  // probeConcurrent's step comes back with these absent, correctly -- it opens
  // a SECOND connection over an untraced transport, so none of its traffic is
  // in this log and there is nothing here to attribute.
  const runner = new StepRunner(() => traced.events)

  try {
    await probeIdentity(session, runner, findings)
    await probeState(session, runner, findings, {
      epochSeconds: Math.floor(Date.now() / 1000),
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    })
    await probeBulk(
      session, runner, findings, { transport: opts.transport, attendance: opts.attendance }, traced.events,
    )

    if (opts.concurrent) {
      await probeConcurrent(runner, findings, {
        host: opts.host, port: opts.port, transport: opts.transport, timeoutMs: opts.timeoutMs,
      })
    }

    // MUST BE LAST: subscribing flips the transport one-way (Transport.listen
    // is one-way, once per socket), so nothing may run after this.
    if (opts.realtimeSeconds > 0) {
      await probeRealtime(session, runner, findings, {
        windowSeconds: opts.realtimeSeconds,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      })
    }

    findings.checksum = auditChecksums(traced.events)
    findings.replyIds = auditReplyIds(traced.events)
    // `opts.commKey !== 0` is the ONE thing the trace cannot show, and it is
    // not the verdict: Session.open sends CMD_AUTH only when the device
    // answers CONNECT with ACK_UNAUTH, so a run given --comm-key against a
    // device that never asks exercises the mixing zero times. Whether it was
    // exercised, and whether the device took it, are read off the wire.
    findings.commKey = auditCommKey(traced.events, opts.commKey !== 0)
  } finally {
    await session.close().catch(() => {})
  }

  return {
    libraryVersion: VERSION,
    host: opts.host,
    transport: opts.transport,
    startedAt,
    durationMs: Date.now() - t0,
    // Checklist item 1 is answered by the raw capture and by nothing else
    // (design spec §4.5). `report.ts` cannot know whether one was asked for --
    // this is the only module that reads argv, so it is the only one that can
    // say. Without it the row said "see the accompanying raw capture" on a
    // default run that writes no such file.
    rawCapture: opts.rawCapture,
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
/**
 * Was this module the program's entry point?
 *
 * `argv[1]` is the path the shell was given; `import.meta.url` is the module
 * Node actually loaded, with symlinks in the entry already resolved. Comparing
 * them unresolved is the same expression as long as nothing links to this
 * file -- and npm links a bin as a symlink on every platform but Windows, where
 * it writes a `.cmd` shim naming the real path instead. So the naive comparison
 * held for the one platform this was developed on and was false for every
 * consumer who installed the package, leaving `main()` uncalled: exit 0, no
 * report, no message, nothing. `realpathSync` is what makes the two sides
 * comparable.
 *
 * Both forms are accepted because `--preserve-symlinks-main` inverts which one
 * matches: under that flag Node keeps the link in `import.meta.url`, so the
 * resolved path is the one that differs. Either match means the same thing.
 *
 * A path that cannot be resolved is not this entry. It is not an error either
 * -- `node -e` has no `argv[1]` to resolve -- so it answers no rather than
 * throwing out of module initialisation.
 */
function invokedAsMain(argv1: string | undefined): boolean {
  if (!argv1) return false
  if (import.meta.url === pathToFileURL(argv1).href) return true
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (invokedAsMain(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`)
    process.exitCode = 1
  })
}
