import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { startEmulator } from '../../test/emulator/index.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle')
const EMULATOR_SESSION_ID = 0x1f2e
const ORACLE_COMM_KEY = 1234

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
): Promise<void> {
  const emulator = await startEmulator({ transport, sessionId: EMULATOR_SESSION_ID, commKey })
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
    const fixture = { source, transport, commKey, emulatorSessionId: EMULATOR_SESSION_ID, packets }
    mkdirSync(OUT_DIR, { recursive: true })
    const kind = commKey === 0 ? 'handshake' : 'auth'
    const file = path.join(OUT_DIR, `${kind}-${transport}-${source}.json`)
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
