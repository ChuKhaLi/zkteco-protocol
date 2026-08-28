import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { startEmulator } from '../../test/emulator/index.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle')
const EMULATOR_SESSION_ID = 0x1f2e
const ORACLE_COMM_KEY = 1234

// Extra (commKey, sessionId) pairs, captured against pyzk only, specifically
// to test the low-byte-discard invariance with real external data instead of
// resting it on this library's own mixCommKey. The single (ORACLE_COMM_KEY,
// EMULATOR_SESSION_ID) pair above vindicates the algorithm at one point, but
// pyzk was never asked to mix two session ids differing only in the low
// byte, so it could not confirm the low-byte invariance specifically —
// EMULATOR_SESSION_ID's low byte (0x2e) never varied across any capture.
//
// Written to their own subdirectory, not OUT_DIR: test/oracle/fixtures.spec.ts
// scans every *.json directly under OUT_DIR for the reply-id checksum
// adjudication (§5.1) and asserts an exact count of discriminating packets
// across that specific corpus. These captures are real evidence too, but for
// a different, narrower question (§A.4's low-byte invariance) — mixing them
// into the general survey would silently change a number that test pins on
// purpose.
//
// zkteco-js is excluded here: it has no comm-key support at all (see the
// `auth-*-zkteco-js.json` fixtures, which carry no CMD_AUTH packet), so it
// cannot offer a second opinion on this either.
const COMMKEY_DIR = path.join(OUT_DIR, 'commkey')
const LOW_BYTE_VARIANT_SESSION_ID = 0x1f99 // same high byte as the baseline (0x1f), different low byte
const HIGH_BYTE_VARIANT_SESSION_ID = 0x2e2e // same low byte as the baseline (0x2e), different high byte
const SECOND_COMM_KEY = 5678

function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

function run(cmd: string, args: string[], useShell = false): Promise<void> {
  return new Promise((resolve) => {
    // useShell is set only for `npx`: on Windows it resolves to npx.cmd, a
    // batch file that Windows refuses to spawn() directly (EINVAL) unless a
    // shell interprets it. cmd/args here are always fixed literals plus a
    // numeric OS-assigned port — never untrusted input — so the shell carries
    // no injection risk. python.exe is a real executable and never needs this.
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: useShell })
    child.on('close', () => resolve())
    child.on('error', (err) => {
      // A failure here means the oracle never ran at all — surface it loudly
      // rather than let the caller mistake "spawn failed" for "captured zero
      // packets because the emulator refused everything".
      process.stderr.write(`failed to spawn ${cmd}: ${String(err)}\n`)
      resolve()
    })
  })
}

async function capture(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
  commKey = 0,
  sessionId = EMULATOR_SESSION_ID,
  // Overrides the handshake/auth naming derived from commKey, and the
  // directory it's written under, for the extra pairs below that are all
  // CMD_AUTH captures but must not collide on disk with the baseline
  // `auth-${transport}-${source}.json` file — and must not land in OUT_DIR
  // at all, per the comment on COMMKEY_DIR above.
  fileTag?: string,
  outDir = OUT_DIR,
): Promise<void> {
  const emulator = await startEmulator({ transport, sessionId, commKey })
  try {
    if (source === 'pyzk') {
      await run(pythonPath(), [
        'tools/oracle/capture_pyzk.py', String(emulator.port), transport, String(commKey),
      ])
    } else {
      await run(
        'npx',
        ['tsx', 'tools/oracle/capture_zkjs.ts', String(emulator.port), transport, String(commKey)],
        true,
      )
    }
    // Give the last datagram a moment to land before tearing the socket down.
    await new Promise((r) => setTimeout(r, 300))

    const packets = emulator.received.map((p, i) => ({
      hex: emulator.receivedRaw[i]!.toString('hex'),
      command: p.command,
      checksum: p.checksum,
      sessionId: p.sessionId,
      replyId: p.replyId,
    }))
    const fixture = { source, transport, commKey, emulatorSessionId: sessionId, packets }
    mkdirSync(outDir, { recursive: true })
    const kind = fileTag ?? (commKey === 0 ? 'handshake' : 'auth')
    const file = path.join(outDir, `${kind}-${transport}-${source}.json`)
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`wrote ${file} (${packets.length} packets)\n`)
  } finally {
    await emulator.close()
  }
}

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await capture(source, transport, 0)
    await capture(source, transport, ORACLE_COMM_KEY)
  }
}

// Low-byte/high-byte/different-key characterisation, pyzk only, TCP only —
// the invariance under test is structural (in the mixing algorithm), not
// transport-dependent, and one transport is enough to pin it against a real
// external computation. Written under COMMKEY_DIR, not OUT_DIR — see the
// comment on that constant above.
await capture('pyzk', 'tcp', ORACLE_COMM_KEY, LOW_BYTE_VARIANT_SESSION_ID, 'auth-lowbyte', COMMKEY_DIR)
await capture('pyzk', 'tcp', ORACLE_COMM_KEY, HIGH_BYTE_VARIANT_SESSION_ID, 'auth-highbyte', COMMKEY_DIR)
await capture('pyzk', 'tcp', SECOND_COMM_KEY, EMULATOR_SESSION_ID, 'auth-keydiff', COMMKEY_DIR)
