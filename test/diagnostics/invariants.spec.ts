import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { TracingTransport } from '../../src/diagnostics/TracingTransport.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { auditChecksums, emptyFindings, probeBulk, probeIdentity, probeState } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const ALLOWED = new Set<number>([
  CMD.CONNECT, CMD.EXIT, CMD.AUTH, CMD.OPTIONS_RRQ, CMD.GET_TIME, CMD.GET_VERSION,
  CMD.GET_FREE_SIZES, CMD.USERTEMP_RRQ, CMD.ATTLOG_RRQ, CMD.FREE_DATA,
  CMD.PREPARE_BUFFER, CMD.READ_BUFFER, CMD.REG_EVENT,
])

const SERIAL = 'SN-DO-NOT-LEAK'
const NAME = 'Zaphod Beeblebrox'
const USER_ID = 'EMP-9931'
/** Not sensitive -- the model name is sanctioned to appear in the report
 *  (checklist item 7's compatibility table needs it). Doubles as the positive
 *  control below: a renderer that silently returned nothing would fail here
 *  even though it vacuously "contains none of the secrets" too. */
const DEVICE_NAME = 'MB360'

function emUser(): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(1, 0)
  b.write(NAME, 11, 24, 'latin1')
  b.write(USER_ID, 48, 8, 'latin1')
  return { uid: 1, userId: USER_ID, name: NAME, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

async function runProbe() {
  running = await startEmulator({
    transport: 'tcp',
    params: { '~SerialNumber': SERIAL, '~DeviceName': DEVICE_NAME },
    firmware: 'Ver 6.60',
    info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
    users: [emUser()],
  })
  const traced = new TracingTransport(
    new TcpTransport({ host: '127.0.0.1', port: running.port }),
    () => 0,
  )
  session = new Session(traced, { timeoutMs: 2000 })
  await session.open()
  const runner = new StepRunner()
  const findings = emptyFindings()
  await probeIdentity(session, runner, findings)
  await probeState(session, runner, findings, { epochSeconds: 0, utcOffsetMinutes: 0 })
  await probeBulk(session, runner, findings, { transport: 'tcp', attendance: 'auto' }, traced.events)
  findings.checksum = auditChecksums(traced.events)
  return { traced, runner, findings }
}

describe('probe invariants', () => {
  it('never sends a command outside the allowlist', async () => {
    await runProbe()
    const sent = running!.received.map((p) => p.command)
    expect(sent.length).toBeGreaterThan(0)
    for (const command of sent) expect(ALLOWED.has(command)).toBe(true)
    // Named explicitly: v0.1 §6 ruled that disabling the device locks
    // employees out every poll cycle. A diagnostic must not reintroduce it.
    expect(sent).not.toContain(CMD.DISABLEDEVICE)
    expect(sent).not.toContain(CMD.ENABLEDEVICE)
  })

  it('keeps the serial, user names and ids out of both shareable artifacts', async () => {
    const { runner, findings, traced } = await runProbe()
    const result = {
      libraryVersion: '0.4.0', host: '127.0.0.1', transport: 'tcp' as const,
      startedAt: '2026-08-30T00:00:00.000Z', durationMs: 0, rawCapture: null,
      truncated: runner.truncated, steps: runner.steps, findings,
    }
    const md = renderMarkdown(result)
    const json = JSON.stringify(renderJson(result))
    for (const secret of [SERIAL, NAME, USER_ID]) {
      expect(md).not.toContain(secret)
      expect(json).not.toContain(secret)
    }

    // POSITIVE CONTROLS (Ruling F8). Without these, "the report contains none
    // of the secrets" passes just as well when renderMarkdown/renderJson
    // return nothing at all as it does when they redacted correctly -- the
    // exact vacuity the raw-capture control below exists to rule out for the
    // raw capture, left unaddressed here until this round. deviceName is the
    // right value to assert on: it is sanctioned to appear (checklist item 7
    // needs it), so a real, correctly-redacting renderer must still contain it.
    //
    // The two checks are not symmetric, deliberately, and that asymmetry is
    // itself worth documenting rather than discovering by surprise later:
    // renderJson mirrors `result` with NO filtering (see its own doc comment)
    // -- it is JSON's job to be the catch-all, so `json` above is checked
    // against every one of SERIAL/NAME/USER_ID and would catch a leak into
    // ANY field, sanctioned or not. renderMarkdown instead allowlists which
    // identity fields it prints raw (deviceName, platform, os,
    // firmwareVersion) versus presence-only (serialNumberPresent) -- so `md`
    // above can only catch a leak that lands in one of those printed fields.
    // Do not read the Markdown check as the stronger of the two, and do not
    // weaken the JSON check on the assumption Markdown already covers it.
    expect(md).toContain(DEVICE_NAME)
    expect(json).toContain(DEVICE_NAME)

    // THE CONTROL. Without this the test above passes when the probe captured
    // nothing at all -- which is exactly the defect shape this project has
    // caught in every cycle so far.
    const raw = renderRawCapture(traced.events)
    expect(raw).toContain(Buffer.from(SERIAL, 'latin1').toString('hex'))
  })
})

// --- Ruling R6: a source-grep purity check ---------------------------------
//
// The Global Constraint "no Date.now(), no argless new Date(), no process.*,
// no filesystem access in src/diagnostics/" was, until this test, enforced by
// nothing at all. The existing offsetMs test (test/diagnostics/tracing.spec.ts)
// cannot catch a Date.now() substitution because real elapsed time also
// exceeds zero. Tasks 5, 7 and 9 all depend on this purity for deterministic
// output, so it is asserted here mechanically rather than left as an intent.
//
// src/cli.ts is explicitly exempt -- it is the one impure module (see its own
// doc comment) and owns all of this: the clock, process.argv, exit codes and
// the filesystem.

const DIAGNOSTICS_DIR = fileURLToPath(new URL('../../src/diagnostics/', import.meta.url))

/**
 * Strips `//` and `/* *‍/` comments, leaving string/template literal content
 * untouched (quote-awareness only, so a comment marker inside a string is not
 * mistaken for a real comment). Several files in this directory discuss
 * `Date.now()` or `process.*` in prose precisely because those are forbidden
 * here -- stripping only comments, not strings, is enough to silence every
 * such false positive in this codebase (verified: none of the forbidden
 * substrings occur inside a string literal here), while still leaving import
 * specifiers ("node:fs" etc.) visible to the filesystem-import check below.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  // .charAt() rather than src[i]: noUncheckedIndexedAccess makes src[i]
  // `string | undefined`, and every read here is already range-guarded by
  // the loop condition -- .charAt() returns '' out of range instead, which
  // compares false to every character this function tests for.
  while (i < n) {
    const c = src.charAt(i)
    const c2 = src.charAt(i + 1)
    if (c === '/' && c2 === '/') {
      while (i < n && src.charAt(i) !== '\n') i++
      continue
    }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < n && src.charAt(i) !== quote) {
        if (src.charAt(i) === '\\' && i + 1 < n) {
          out += src.charAt(i) + src.charAt(i + 1)
          i += 2
          continue
        }
        out += src.charAt(i)
        i += 1
      }
      if (i < n) {
        out += src.charAt(i)
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** As `stripComments`, but also blanks string/template literal contents. */
function stripCommentsAndStrings(src: string): string {
  const withComments = stripComments(src)
  let out = ''
  let i = 0
  const n = withComments.length
  while (i < n) {
    const c = withComments.charAt(i)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < n && withComments.charAt(i) !== quote) {
        i += withComments.charAt(i) === '\\' && i + 1 < n ? 2 : 1
      }
      if (i < n) i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

function diagnosticsSourceFiles(): string[] {
  return readdirSync(DIAGNOSTICS_DIR, { recursive: true })
    .map((f) => f.toString())
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(DIAGNOSTICS_DIR, f))
}

describe('src/diagnostics purity (Global Constraint)', () => {
  it('contains no clock reads, no process access, and no filesystem imports outside comments and strings', () => {
    const files = diagnosticsSourceFiles()
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const commentsStripped = stripComments(src)
      const codeOnly = stripCommentsAndStrings(src)

      if (/\bDate\.now\s*\(/.test(codeOnly)) {
        violations.push(`${file}: Date.now()`)
      }
      if (/\bnew\s+Date\s*\(\s*\)/.test(codeOnly)) {
        violations.push(`${file}: argless new Date()`)
      }
      if (/\bprocess\s*\./.test(codeOnly)) {
        violations.push(`${file}: process.*`)
      }
      // Import specifiers are string literals, so this check runs against
      // `commentsStripped` (comments removed, strings intact) rather than
      // `codeOnly` -- and is anchored to import/require syntax rather than a
      // bare "fs" substring, which would otherwise false-positive on words
      // like "offset" or "findings".
      const fsImport =
        /\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(commentsStripped) ||
        /\brequire\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(commentsStripped) ||
        /\bimport\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(commentsStripped)
      if (fsImport) {
        violations.push(`${file}: filesystem import`)
      }
    }

    expect(violations).toEqual([])
  })
})
