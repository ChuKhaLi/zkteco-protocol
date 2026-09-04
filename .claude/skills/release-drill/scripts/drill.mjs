#!/usr/bin/env node
/**
 * The packed-tarball drill: build, pack, install into a clean directory, and
 * drive the INSTALLED cli against the emulator.
 *
 * Every other check in this repository runs the cli from source, sharing
 * node_modules, tsconfig and build output. A published consumer has none of
 * those, and that gap is not hypothetical -- a top-level `await main()` once
 * made the CJS build fail and silently drop dist/index.cjs, the package's own
 * `main` entry, with no test failing anywhere.
 *
 * Run from the repository root:
 *   node .claude/skills/release-drill/scripts/drill.mjs
 *
 * Exit code 0 means every check below passed. Any failure prints what was
 * expected, what was found, and where the artifacts were left for inspection.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumerSource, consumerTsconfig } from './consumer-fixture.mjs'

const IS_WINDOWS = process.platform === 'win32'
/** Values baked into tools/emulator-serve.ts. Kept in sync by hand; the drill
 *  fails loudly rather than silently if they drift, because the serial check
 *  would go vacuous. */
const SERIAL = 'SN-PACKTEST-001'
const DEVICE_NAME = 'MB360'

const checks = []
let workdir = null
let emulator = null

function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/**
 * Quotes arguments that a shell would otherwise split.
 *
 * `run()` passes `shell: true` on Windows (npm and npx are batch files there),
 * and every path here goes through `mkdtempSync(join(tmpdir(), …))` — which on
 * Windows contains the user's name, so an account named "Ada Lovelace" split
 * the argument in two and the drill failed on a path it had constructed
 * itself.
 */
function shellArgs(args) {
  if (!IS_WINDOWS) return args
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, IS_WINDOWS ? shellArgs(args) : args, {
    encoding: 'utf8', shell: IS_WINDOWS, ...opts,
  })
  if (res.error) throw res.error
  return res
}

/**
 * Aborts, having flushed the reason.
 *
 * `process.stderr.write()` is asynchronous when stderr is a pipe — which is
 * how CI reads it — so `process.exit()` right after it truncates the
 * message. Deferring the exit to the write's callback does not fix that
 * either: this script is almost entirely blocking `spawnSync` calls, which
 * hold the event loop and starve that callback, so an "aborted" run falls
 * through and keeps executing build/pack/install/spawn regardless — flushed
 * but not actually aborted. `fs.writeSync` issues the write as a blocking
 * syscall, so the bytes are already on their way to the fd before this
 * function returns, and the `process.exit()` right after it is synchronous
 * too: nothing past this call ever runs.
 */
function must(condition, message) {
  if (!condition) {
    cleanup()
    writeSync(2, `\ndrill aborted: ${message}\n`)
    process.exit(2)
  }
}

/**
 * The cli's own account of a run, for a failure that would otherwise report
 * only that a file is missing.
 *
 * Worth the eight lines: the bin-entry defect found on Linux showed up here as
 * "no Markdown report was written" while the cli had exited 0 with both streams
 * empty -- the one fact that identifies the bug, and the one fact the abort did
 * not carry. Reproducing it by hand was the only way to see it.
 */
function describeRun(res) {
  const out = (res.stdout ?? '').trim()
  const err = (res.stderr ?? '').trim()
  return [
    `\n  exit:   ${res.status}`,
    `\n  stdout: ${out ? out.slice(0, 400) : '(empty)'}`,
    `\n  stderr: ${err ? err.slice(0, 400) : '(empty)'}`,
  ].join('')
}

/**
 * Kills the emulator and the process it spawned.
 *
 * `tsx` spawns a child of its own, so signalling the npx wrapper left the
 * socket bound after every POSIX run — the comment here described that and
 * fixed it only for Windows. The emulator is spawned detached on POSIX, which
 * makes it a process-group leader, so a negative pid signals the whole group.
 */
function killEmulator() {
  if (!emulator || emulator.killed) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(emulator.pid), '/T', '/F'], { shell: true })
  } else {
    try {
      process.kill(-emulator.pid, 'SIGTERM')
    } catch {
      // Already gone, or never became a group leader: fall back to the child.
      try { emulator.kill('SIGTERM') } catch { /* nothing left to kill */ }
    }
  }
  emulator = null
}

function cleanup() {
  killEmulator()
  if (workdir && !process.env.KEEP_DRILL_ARTIFACTS) rmSync(workdir, { recursive: true, force: true })
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })

// --- 1. build -------------------------------------------------------------
process.stdout.write('building...\n')
must(run('pnpm', ['build']).status === 0, 'pnpm build failed')
must(existsSync('dist/index.cjs'), 'dist/index.cjs is missing — the CJS pass failed silently')
check('dist/index.cjs exists (the package main entry)', true)

// --- 2. pack --------------------------------------------------------------
workdir = mkdtempSync(join(tmpdir(), 'zk-drill-'))
const packed = run('npm', ['pack', '--pack-destination', workdir, '--json'])
must(packed.status === 0, `npm pack failed:\n${packed.stderr}`)
const tarball = join(workdir, JSON.parse(packed.stdout)[0].filename)
must(existsSync(tarball), `packed tarball not found at ${tarball}`)

// The CJS bundle of the CLI could never run — its import.meta is shimmed to
// {} so the main-module check is always false — so v0.5 stopped building it.
// The tarball is where a consumer would meet it.
const packedFiles = JSON.parse(packed.stdout)[0].files.map((f) => f.path)
check(
  'no CommonJS CLI or CLI declaration is in the tarball',
  !packedFiles.some((p) => /^dist\/cli\.(cjs|d\.[cm]?ts)$/.test(p)),
  packedFiles.filter((p) => p.startsWith('dist/cli')).join(', ') || 'dist/cli.js only',
)

// --- 3. install into a directory that shares nothing with this repo -------
const consumer = join(workdir, 'consumer')
mkdirSync(consumer)
writeFileSync(join(consumer, 'package.json'), '{"name":"drill-consumer","private":true}\n')
const install = run('npm', ['install', tarball], { cwd: consumer })
must(install.status === 0, `npm install failed:\n${install.stderr}`)
// "added 1 package" is the zero-runtime-dependencies rule, observed from
// outside rather than asserted from package.json.
check(
  'install pulls exactly 1 package, 0 transitive dependencies',
  /added 1 package/.test(install.stdout),
  install.stdout.trim().split('\n').find((l) => l.includes('package')) ?? 'no package line',
)

// --- 3b. a CommonJS consumer must typecheck against the packed types -------
// The review reproduced TS1479 here on TypeScript 5.9.3 under node16 and
// node18: `exports` carried one top-level `types` pointing at the ESM
// declaration, so a require()-style consumer was sent to a file it cannot use
// while require() itself worked at runtime. dist/index.d.cts existed and was
// referenced by nothing. Nothing in the test suite compiles a consumer.
const repoRoot = process.cwd().replaceAll('\\', '/')
writeFileSync(join(consumer, 'consumer.ts'), consumerSource())
writeFileSync(join(consumer, 'tsconfig.json'), consumerTsconfig(repoRoot))
const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc')
const typecheck = spawnSync(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json')], { encoding: 'utf8' })
check(
  'a CommonJS TypeScript consumer typechecks against the packed declarations',
  typecheck.status === 0,
  typecheck.status === 0 ? 'module: node16' : `${(typecheck.stdout ?? '').trim().split('\n')[0] ?? ''}`,
)

// --- 4. start the emulator ------------------------------------------------
const portFile = join(workdir, 'port.txt')
emulator = spawn('npx', shellArgs(['tsx', 'tools/emulator-serve.ts', portFile]), {
  stdio: 'ignore', shell: IS_WINDOWS, detached: !IS_WINDOWS,
})
const deadline = Date.now() + 30_000
while (!existsSync(portFile) && Date.now() < deadline) {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'])
}
must(existsSync(portFile), 'emulator never wrote its port file within 30s')
const port = readFileSync(portFile, 'utf8').trim()

// --- 5. the default run, which is what the README documents first ---------
function invoke(outName, extraArgs = []) {
  const out = join(workdir, outName)
  const res = run('npx', ['zkteco-protocol', '127.0.0.1', '--port', port, '--out', out, ...extraArgs], {
    cwd: consumer,
  })
  return { res, out, json: out.replace(/\.md$/, '.json') }
}

const plain = invoke('report.md')
check('default run exits 0', plain.res.status === 0, `exit ${plain.res.status}`)
must(existsSync(plain.out), `no Markdown report was written${describeRun(plain.res)}`)
const md = readFileSync(plain.out, 'utf8')
const json = readFileSync(plain.json, 'utf8')

check('the serial appears nowhere in the Markdown report', !md.includes(SERIAL))
check('the serial appears nowhere in the JSON sidecar', !json.includes(SERIAL))
// The positive control. Without it, a renderer that wrote nothing would pass
// both absence checks above just as well.
check(
  `${DEVICE_NAME} IS present, so the absence above is meaningful`,
  md.includes(DEVICE_NAME),
  'positive control',
)
// The checklist row is `| # | question | state | observation |`; the state
// cell is field index 3. Matching the STATE CELL exactly, rather than
// substring-testing the whole row, matters: 'not answered' contains
// 'answered', so a substring test can never fail regardless of which state
// the row is actually in. See the captured-run check below for what that
// cost before this fix.
const stateCell = (row) => (row.split('|')[3] ?? '').trim()
const item1 = md.split('\n').find((l) => l.startsWith('| 1 |')) ?? ''
check(
  'item 1 reads "not answered" and names --raw-capture as the remedy',
  stateCell(item1) === 'not answered' && /--raw-capture/.test(item1),
  item1.slice(0, 90),
)

// --- 6. the --raw-capture run: item 1 must flip, and the bytes must be there
const capturePath = join(workdir, 'trace.jsonl')
const captured = invoke('report-capture.md', ['--raw-capture', capturePath])
check('--raw-capture run exits 0', captured.res.status === 0, `exit ${captured.res.status}`)
must(
  existsSync(captured.out),
  `no Markdown report was written for the --raw-capture run${describeRun(captured.res)}`,
)
const capturedMd = readFileSync(captured.out, 'utf8')
const item1Captured = capturedMd.split('\n').find((l) => l.startsWith('| 1 |')) ?? ''
check(
  'item 1 flips to "answered" and names the real capture file',
  stateCell(item1Captured) === 'answered' && item1Captured.includes('trace.jsonl'),
  item1Captured.slice(0, 90),
)
// The positive control for the check above. Without it, "item 1 flips to
// answered" is a claim about the renderer; with it, the row rests on a
// request that actually went out. Item 1 asks for a handshake AND an
// attendance read, and the drill's device reported zero records until now.
const captureEvents = readFileSync(capturePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const askedForAttendance = captureEvents.some((e) => {
  if (e.direction !== 'send' || typeof e.hex !== 'string') return false
  if (e.command === 13) return true                    // CMD_ATTLOG_RRQ, sent directly
  if (e.command !== 1503) return false                 // CMD_PREPARE_BUFFER wrapping it:
  const payload = Buffer.from(e.hex, 'hex')            // header is 8 bytes, then
  return payload.length >= 11 && payload.readUInt16LE(9) === 13  // <int8 1><int16 command>
})
check('the capture holds an attendance request, so item 1 rests on the wire', askedForAttendance)
check('the Markdown still hides the serial with a capture written', !capturedMd.includes(SERIAL))
// The capture is unredacted BY DESIGN -- that is the whole reason it is
// opt-in and carries a header saying so. Asserting the bytes ARE there keeps
// the two artifacts' different jobs honest in both directions.
const captureHex = readFileSync(capturePath, 'utf8')
check(
  'the raw capture DOES contain the serial, as its opt-in contract promises',
  captureHex.includes(Buffer.from(SERIAL, 'latin1').toString('hex')),
)

// --- done -----------------------------------------------------------------
killEmulator()
const failed = checks.filter((c) => !c.ok)
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
if (failed.length > 0) {
  process.stdout.write(`artifacts left in ${workdir} for inspection\n`)
  process.exitCode = 1
} else {
  cleanup()
}
