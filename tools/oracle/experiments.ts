/**
 * Four black-box experiments against pyzk (spec v0.5 §12). Each starts the
 * emulator in one configuration, runs pyzk's public API against it, and
 * records three observables: what pyzk sent (the emulator's log), what pyzk
 * printed (the users it believes it read), and how it exited.
 *
 * A run that could not be spawned, or exited non-zero without printing, is
 * recorded as `completed: false` with the exit code — never as a result.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CMD } from '../../src/codec/commands.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import type { ZkUser } from '../../src/types.js'
import { startEmulator, reply, type EmulatorOptions, type Handler } from '../../test/emulator/index.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle', 'bulk')
const SESSION_ID = 0x1f2e

function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'latin1')
  b.write(userId, 48, 9, 'latin1')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

// Three users: 3 × 72 + 4 = 220 body bytes, so a size read at the wrong
// offset is unmistakable (0x000000dc at offset 1 reads as 0x0000dc00 at 0).
const USERS = [emUser(1, '100001', 'Ann'), emUser(2, '100002', 'Bo'), emUser(3, '100003', 'Cy')]

/**
 * pyzk's `get_users()` gates the whole buffered/legacy read on a nonzero
 * count it reads out of the CMD_GET_FREE_SIZES reply first — a plain
 * `info: { userCount: 3 }` (served through this emulator's own
 * `encodeFreeSizes`, capped at `FREE_SIZES_OFFSET.recordCapacity + 4` = 68
 * bytes) was not enough: pyzk still read zero users and sent nothing further.
 * Bisecting both the reply length and which offset carries the count
 * (black-box only, per the pyzk boundary — see PROVENANCE.md) found pyzk
 * needs a reply of at least 80 bytes with the count as a little-endian
 * uint32 at byte offset 16. That offset happens to match this library's own
 * (hardware-unverified) `FREE_SIZES_OFFSET.userCount`; the length does not
 * match anything this library encodes, so the emulator's default handler is
 * overridden here rather than widened — that offset table is a separate,
 * still-open question (PROVENANCE.md, "Unverified field offsets").
 * Without this override every one of E1-E4 "completes" (exit 0) having sent
 * only CONNECT, CMD_GET_FREE_SIZES, and EXIT — proving nothing about any of
 * the questions these experiments ask.
 */
const FREE_SIZES_REPLY_LEN = 80
const FREE_SIZES_USER_COUNT_OFFSET = 16
const freeSizesHandler: Handler = (req, state) => {
  const body = Buffer.alloc(FREE_SIZES_REPLY_LEN)
  body.writeUInt32LE(USERS.length, FREE_SIZES_USER_COUNT_OFFSET)
  return [reply(state, req, CMD.ACK_OK, body)]
}

interface Run { exitCode: number | null; stdout: string; stderr: string; spawned: boolean }

function runPyzk(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawned = true
    const child = spawn(pythonPath(), ['tools/oracle/capture_pyzk.py', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { spawned = false; stderr += String(err) })
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr, spawned }))
  })
}

interface Variant { name: string; experiment: 'E1' | 'E2' | 'E3' | 'E4'; transport: 'tcp' | 'udp'; options: Partial<EmulatorOptions> }

const VARIANTS: Variant[] = [
  { name: 'E1-no-reply-id-echo-tcp', experiment: 'E1', transport: 'tcp', options: { echoReplyId: false } },
  { name: 'E1-wrong-session-id-tcp', experiment: 'E1', transport: 'tcp', options: { replySessionIdOverride: 0x2222 } },
  { name: 'E2-size-at-1-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-1' } },
  { name: 'E2-size-at-0-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-0' } },
  { name: 'E3-chunk-transfer-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'transfer' } },
  { name: 'E3-chunk-single-packet-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'single-packet' } },
  { name: 'E4-users-72-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 72 } },
  { name: 'E4-users-28-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 28 } },
]

async function runVariant(v: Variant): Promise<void> {
  const emulator = await startEmulator({
    transport: v.transport,
    sessionId: SESSION_ID,
    users: USERS,
    handlers: { [CMD.GET_FREE_SIZES]: freeSizesHandler },
    ...v.options,
  })
  try {
    const run = await runPyzk([String(emulator.port), v.transport, '0', 'read-users'])
    await new Promise((r) => setTimeout(r, 300))
    const sent = emulator.received.map((p) => ({
      command: p.command,
      sessionId: p.sessionId,
      replyId: p.replyId,
      // The READ_BUFFER request's (offset, size) is E2's observable.
      data: p.command === CMD.READ_BUFFER || p.command === CMD.PREPARE_BUFFER ? p.data.toString('hex') : undefined,
    }))
    const fixture = {
      experiment: v.experiment,
      variant: v.name,
      transport: v.transport,
      served: {
        users: USERS.map((u) => `${u.uid}|${u.userId}|${u.name}`),
        options: v.options,
        // See the comment on freeSizesHandler above: without this, pyzk
        // never attempts the read this fixture exists to observe.
        freeSizesReply: { userCount: USERS.length, replyBytes: FREE_SIZES_REPLY_LEN, userCountOffset: FREE_SIZES_USER_COUNT_OFFSET },
      },
      completed: run.spawned && run.exitCode === 0,
      exitCode: run.exitCode,
      printed: run.stdout.trim().split(/\r?\n/).filter(Boolean),
      stderr: run.stderr.trim(),
      sent,
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `${v.name}.json`)
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`${fixture.completed ? 'completed' : `NOT COMPLETED (exit ${String(run.exitCode)})`}: ${file}\n`)
  } finally {
    await emulator.close()
  }
}

for (const v of VARIANTS) await runVariant(v)
