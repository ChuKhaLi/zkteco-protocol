import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

/** What one oracle driver did. `code: null` with `spawned: true` means it was killed. */
export interface OracleRun {
  spawned: boolean
  code: number | null
  /** The last line the driver wrote to stderr, for a failure message worth reading. */
  stderrTail: string
}

/** A run that produced evidence. Anything else must not become a fixture. */
export function succeeded(run: OracleRun): boolean {
  return run.spawned && run.code === 0
}

/** One line naming what failed and how, for the summary at the end of a capture. */
export function describeFailure(script: string, run: OracleRun): string {
  const how = run.spawned ? `exit ${String(run.code)}` : 'could not be spawned'
  return `${script}: ${how}${run.stderrTail ? ` — ${run.stderrTail}` : ''}`
}

export function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

/**
 * Runs one oracle driver and reports how it ended.
 *
 * The exit code is the whole point: a driver that raised part-way through a
 * session leaves the emulator holding a partial packet list, and writing that
 * as a fixture files a crash as evidence. stderr is teed rather than
 * inherited so the last line can travel with the failure.
 *
 * `useShell` is set only for `npx`: on Windows it resolves to npx.cmd, a
 * batch file Windows refuses to spawn() directly unless a shell interprets it.
 * The arguments here are fixed literals plus an OS-assigned port, never
 * untrusted input.
 */
export function run(cmd: string, args: string[], useShell = false): Promise<OracleRun> {
  return new Promise((resolve) => {
    let spawned = true
    let stderrTail = ''
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], shell: useShell })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      const lines = chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean)
      if (lines.length > 0) stderrTail = lines[lines.length - 1]!
    })
    child.on('error', (err) => {
      spawned = false
      stderrTail = String(err)
    })
    child.on('close', (code) => resolve({ spawned, code, stderrTail }))
  })
}

/** Runs whichever driver belongs to this oracle, and says which script it was. */
export async function runOracleScript(
  source: 'pyzk' | 'zkteco-js',
  pyScript: string,
  tsScript: string,
  args: string[],
): Promise<{ run: OracleRun; script: string }> {
  if (source === 'pyzk') {
    return { run: await run(pythonPath(), [pyScript, ...args]), script: pyScript }
  }
  return { run: await run('npx', ['tsx', tsScript, ...args], true), script: tsScript }
}

/**
 * Names the oracle runs that produced no fixture and returns the exit code the
 * capture should adopt.
 *
 * Lives here rather than in capture.ts because that file is a top-level-await
 * script and cannot be imported by a test. The decision is three lines and the
 * consequence is not: a capture that skipped every fixture but exited 0 would
 * leave the committed evidence looking refreshed when nothing was rewritten.
 *
 * `write` is injected so a test can read what was printed without a subprocess.
 */
export function reportFailures(failures: string[], write: (s: string) => void): number {
  if (failures.length === 0) return 0
  write(`\n${failures.length} oracle run(s) produced no fixture:\n`)
  for (const line of failures) write(`  ${line}\n`)
  return 1
}
