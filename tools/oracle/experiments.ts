/**
 * Four black-box experiments against pyzk (spec v0.5 §12), plus the two E0
 * controls that establish what has to be served before any of them run at
 * all — neither is in the spec's table; both exist so that precondition is a
 * fixture rather than a claim. Each starts the
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
 * pyzk's `get_users()` gates the whole buffered/legacy read on a count it
 * reads out of the CMD_GET_FREE_SIZES reply first. The 68-byte reply this
 * library's own encoder produces (`encodeFreeSizes`, capped at
 * `FREE_SIZES_OFFSET.recordCapacity + 4`) was not enough for pyzk to attempt
 * the read even with `userCount` set correctly — see the E0 control fixture
 * below (`E0-free-sizes-default-tcp.json`), which serves exactly that reply
 * and records pyzk completing with zero users printed and nothing sent
 * beyond CONNECT, GET_FREE_SIZES, EXIT. An 80-byte reply with the count as a
 * little-endian uint32 at byte offset 16 was enough — see every other
 * fixture, where pyzk goes on to PREPARE_BUFFER/READ_BUFFER. Offset 16
 * happens to match this library's own (hardware-unverified)
 * `FREE_SIZES_OFFSET.userCount`; nothing here claims 80 bytes or offset 16
 * are minimal or exact — intermediate lengths and other offsets were not
 * recorded — only that this combination works and the 68-byte default does
 * not, both reproducible from this tree. E0 alone cannot say WHICH of the two
 * differences stopped it, since the 68-byte reply carries its count at offset
 * 16 as well; the E0b control below holds the length at 80 and zeroes only the
 * count, and records pyzk stopping in the same place. Without the override
 * below, every one of E1-E4 "completes" (exit 0) having sent only CONNECT,
 * CMD_GET_FREE_SIZES, and EXIT — proving nothing about any of the questions
 * these experiments ask.
 */
const FREE_SIZES_REPLY_LEN = 80
const FREE_SIZES_USER_COUNT_OFFSET = 16
/**
 * The 80-byte override, with the count as a parameter rather than always
 * `USERS.length`. E0b serves the very same 80 bytes with the count as 0, which
 * is the only way the fixtures separate "the reply was long enough" from "the
 * count at offset 16 was read": E0 and E1-E4 differ in length as well as
 * count, so on their own they cannot tell those apart.
 */
const freeSizesHandler = (
  userCount: number,
  offset: number = FREE_SIZES_USER_COUNT_OFFSET,
): Handler => (req, state) => {
  const body = Buffer.alloc(FREE_SIZES_REPLY_LEN)
  body.writeUInt32LE(userCount, offset)
  return [reply(state, req, CMD.ACK_OK, body)]
}

/**
 * E5 sweeps `offset` across every 4-byte word of the 80-byte reply, one
 * variant per word, with the rest of the body zero.
 *
 * E0b and E1-E4 together show only that zeroing offset 16 stops pyzk's read.
 * They never served a nonzero word anywhere else, so they cannot separate
 * "pyzk reads offset 16" from "pyzk reads some word that happens to be
 * nonzero only at offset 16 in those fixtures". Exactly one nonzero word per
 * run settles that: a run that proceeds to the user read read THAT word.
 *
 * The negative results are the point. Offset 16 coming back positive is
 * already implied by E1-E4; what nothing currently shows is that no OTHER
 * word also triggers the read.
 *
 * What this can conclude: which word pyzk's parser reads. What it cannot:
 * where a device puts the field. PROVENANCE.md records the difference.
 */
const FREE_SIZES_SWEEP_OFFSETS = Array.from(
  { length: FREE_SIZES_REPLY_LEN / 4 },
  (_, word) => word * 4,
)

interface Run { exitCode: number | null; stdout: string; stderr: string; spawned: boolean }

// A hung pyzk process (e.g. blocked on a socket that never answers a shape
// it doesn't recognise) must not hang the whole harness silently — a kill
// after 30s turns that into a recorded, visible outcome instead.
const PYZK_TIMEOUT_MS = 30_000

function runPyzk(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawned = true
    let killed = false
    const child = spawn(pythonPath(), ['tools/oracle/capture_pyzk.py', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const killTimer = setTimeout(() => { killed = true; child.kill() }, PYZK_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { spawned = false; stderr += String(err) })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (killed) stderr += `${stderr ? '\n' : ''}killed after 30 s`
      resolve({ exitCode: code, stdout, stderr, spawned })
    })
  })
}

interface Variant {
  name: string
  experiment: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5'
  transport: 'tcp' | 'udp'
  options: Partial<EmulatorOptions>
  /**
   * The count to write into the 80-byte override, or `null` to leave the
   * emulator's own 68-byte default handler in place.
   */
  freeSizesUserCount: number | null
  /**
   * Where in the 80-byte override that count goes. Defaults to the offset
   * this library reads. Only E5 sets it, and only E5's fixtures are evidence
   * about which word an oracle reads.
   */
  freeSizesCountOffset?: number
}

const VARIANTS: Variant[] = [
  // Control: the emulator's own default CMD_GET_FREE_SIZES handler (68
  // bytes, no override below), with userCount served correctly. Exists so
  // the negative half of the finding above — that 68 bytes is NOT enough —
  // is itself a fixture, not just a claim in a comment.
  { name: 'E0-free-sizes-default-tcp', experiment: 'E0', transport: 'tcp', options: {}, freeSizesUserCount: null },
  // Second control, holding the reply length fixed at the 80 bytes E1-E4 are
  // served and varying only the count. E0 vs E1-E4 changes two things at
  // once, so neither shows on its own whether pyzk gates on the count or
  // merely on the reply being long enough. This isolates the count.
  { name: 'E0b-free-sizes-80-count-zero-tcp', experiment: 'E0', transport: 'tcp', options: {}, freeSizesUserCount: 0 },
  { name: 'E1-no-reply-id-echo-tcp', experiment: 'E1', transport: 'tcp', options: { echoReplyId: false }, freeSizesUserCount: USERS.length },
  { name: 'E1-wrong-session-id-tcp', experiment: 'E1', transport: 'tcp', options: { replySessionIdOverride: 0x2222 }, freeSizesUserCount: USERS.length },
  { name: 'E2-size-at-1-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-1' }, freeSizesUserCount: USERS.length },
  { name: 'E2-size-at-0-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-0' }, freeSizesUserCount: USERS.length },
  { name: 'E3-chunk-transfer-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'transfer' }, freeSizesUserCount: USERS.length },
  { name: 'E3-chunk-single-packet-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'single-packet' }, freeSizesUserCount: USERS.length },
  { name: 'E4-users-72-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 72 }, freeSizesUserCount: USERS.length },
  { name: 'E4-users-28-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 28 }, freeSizesUserCount: USERS.length },
  // E5: exactly one nonzero word per run, swept across the whole reply. See
  // FREE_SIZES_SWEEP_OFFSETS above for what this can and cannot conclude.
  // TCP only: the question is which word the parser reads, and nothing about
  // that is transport-specific. A positive offset is re-run over UDP below
  // once the sweep has said which offsets are positive.
  ...FREE_SIZES_SWEEP_OFFSETS.map((offset): Variant => ({
    name: `E5-free-sizes-count-at-${offset}-tcp`,
    experiment: 'E5',
    transport: 'tcp',
    options: {},
    freeSizesUserCount: USERS.length,
    freeSizesCountOffset: offset,
  })),
]

async function runVariant(v: Variant): Promise<void> {
  const count = v.freeSizesUserCount
  const emulator = await startEmulator({
    transport: v.transport,
    sessionId: SESSION_ID,
    users: USERS,
    // Only matters to E0: every other variant's GET_FREE_SIZES handler is
    // overridden below and ignores state.opts.info entirely.
    info: { userCount: USERS.length, recordCount: 0, recordCapacity: 0 },
    ...v.options,
    // A variant's own `handlers` (none currently define one) must not be
    // able to drop this override by replacing the whole object — merge
    // instead of letting the spread above win outright. E0 is the one
    // variant that must NOT get it, so its fixture can show the emulator's
    // unmodified default behaviour; E0b gets it with a count of 0.
    ...(count === null
      ? {}
      : {
          handlers: {
            ...v.options.handlers,
            [CMD.GET_FREE_SIZES]: freeSizesHandler(count, v.freeSizesCountOffset),
          },
        }),
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
        // See the comment on freeSizesHandler above: without the override,
        // pyzk never attempts the read this fixture exists to observe. E0
        // deliberately gets none, to put that negative result in a fixture
        // rather than only in this comment.
        freeSizesReply: count === null
          ? 'default encodeFreeSizes: 68 bytes, userCount 3'
          : {
              userCount: count,
              replyBytes: FREE_SIZES_REPLY_LEN,
              // The offset actually served, not the constant — E5 varies it,
              // and a fixture that recorded the constant while serving
              // something else would be evidence of the wrong thing.
              userCountOffset: v.freeSizesCountOffset ?? FREE_SIZES_USER_COUNT_OFFSET,
              // Everything else in the 80 bytes is zero, which is what makes
              // a completed read attributable to this one word.
              otherWordsZero: true,
            },
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
