/**
 * Four black-box experiments against pyzk (spec v0.5 §12), plus the two E0
 * controls that establish what has to be served before any of them run at
 * all, plus the two offset sweeps E5 and E6 and the record-byte probe E7.
 * Only E1-E4 are in the spec's table; the controls exist so their precondition
 * is a fixture rather than a claim, and the rest postdate it. Each starts the
 * emulator in one
 * configuration, runs pyzk's public API against it, and records three
 * observables: what pyzk sent (the emulator's log), what pyzk printed (the
 * users or attendance records it believes it read), and how it exited.
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
import {
  startEmulator,
  reply,
  type EmulatorOptions,
  type EmulatorRecords,
  type Handler,
} from '../../test/emulator/index.js'

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
 * One attendance row in the 40-byte dialect: uid, printed user id, the two
 * model-dependent bytes, packed time.
 *
 * `status` and `punch` default to 0 so E6's rows keep the exact bytes they
 * were captured with. E7 below is the only caller that sets them.
 */
function rec40(uid: number, userId: string, t: number, status = 0, punch = 0): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'latin1')
  b.writeUInt8(status, 26)
  b.writeUInt32LE(t, 27)
  b.writeUInt8(punch, 31)
  return b
}

/** One row in the 16-byte dialect: numeric user id, packed time, then the two bytes. */
function rec16(numericUserId: number, t: number, status: number, punch: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(numericUserId, 0)
  b.writeUInt32LE(t, 4)
  b.writeUInt8(status, 8)
  b.writeUInt8(punch, 9)
  return b
}

/** One row in the 8-byte dialect: uid, status, packed time, punch. */
function rec8(uid: number, t: number, status: number, punch: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  b.writeUInt8(status, 2)
  b.writeUInt32LE(t, 3)
  b.writeUInt8(punch, 7)
  return b
}

// Three rows, one per served user, so the body is 3 × 40 = 120 bytes. Both
// counts an oracle could plausibly read are therefore 3, which is what makes
// the sweep below a test of WHICH WORD is read rather than of which value:
// serving different counts for users and records would let a run be explained
// by the value it found instead of by the offset it found it at.
const RECORDS: EmulatorRecords = {
  size: 40,
  rows: [
    rec40(1, '100001', 0),
    rec40(2, '100002', 86_400),
    rec40(3, '100003', 172_800),
  ],
}

/**
 * E7 asks which BYTE of an attendance record each implementation reads as
 * `status` and which as `punch`.
 *
 * Why it needs asking. `mapStatusAndVerify` (src/codec/records/attendance.ts)
 * has declared itself a HYPOTHESIS since v0.1: the record layouts name two
 * model-dependent bytes `status` and `punch`, the public API exposes `status`
 * and `verifyMode`, and which feeds which is not settled by the available
 * documentation. Its own docblock promises exactly this experiment — "decodes
 * identical record bytes with two independent implementations and adopts
 * their mapping only if they agree" — and that promise has never been kept.
 * Each of the three dialects carries its own pair of offsets (40-byte:
 * status 26, punch 31; 16-byte: 8 and 9; 8-byte: 2 and 7), so a run that
 * covered only one would leave the other two guessed.
 *
 * E6 could not answer it and deliberately did not try: it served both bytes
 * as ZERO, so `0|0` is what an implementation reading the right byte and one
 * reading any other zero byte would equally print. E7 serves six values that
 * are pairwise distinct and appear nowhere else in the row, so a swap, or a
 * read at any other offset, is unmistakable in what gets printed back.
 *
 * WHAT THIS CAN CONCLUDE, written before the first run so the framing is not
 * fitted to the answer:
 *
 *  - Which byte `pyzk` reads into the field it calls `status`, and which into
 *    the one it calls `punch`, per dialect it can parse at all.
 *
 * WHAT IT CANNOT:
 *
 *  - What those two fields MEAN on a device — in/out versus finger, card,
 *    face, password. That is semantics, which no emulator can settle, and is
 *    why the README returns both as raw numbers rather than decoding them.
 *  - What a device puts in those bytes. Same limit as E5 and E6: this is a
 *    fact about a parser.
 *  - Anything about a dialect `pyzk` cannot read. A run that fails to parse
 *    the 8- or 16-byte body records NO EVIDENCE for that dialect. It is not a
 *    disagreement, and must not be written up as one.
 *
 * If the two oracles disagree with each other, the divergence gets recorded
 * and neither side is adopted — the docblock's instruction, not a judgement
 * made here.
 */
const STATUS_PUNCH: ReadonlyArray<readonly [status: number, punch: number]> = [
  [0x11, 0x22],
  [0x33, 0x44],
  [0x55, 0x66],
]

const E7_RECORDS: Readonly<Record<8 | 16 | 40, EmulatorRecords>> = {
  40: {
    size: 40,
    rows: [
      rec40(1, '100001', 0, ...STATUS_PUNCH[0]!),
      rec40(2, '100002', 86_400, ...STATUS_PUNCH[1]!),
      rec40(3, '100003', 172_800, ...STATUS_PUNCH[2]!),
    ],
  },
  16: {
    size: 16,
    rows: [
      rec16(100_001, 0, ...STATUS_PUNCH[0]!),
      rec16(100_002, 86_400, ...STATUS_PUNCH[1]!),
      rec16(100_003, 172_800, ...STATUS_PUNCH[2]!),
    ],
  },
  8: {
    size: 8,
    rows: [
      rec8(1, 0, ...STATUS_PUNCH[0]!),
      rec8(2, 86_400, ...STATUS_PUNCH[1]!),
      rec8(3, 172_800, ...STATUS_PUNCH[2]!),
    ],
  },
}

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

/**
 * E6 applies E5's sweep to the OTHER load-bearing counter.
 *
 * Why it is worth a second sweep. `FREE_SIZES_OFFSET.recordCount` is
 * load-bearing in the same way `userCount` is, and it fails more quietly:
 * `detectRecordSize` divides the attendance body by it, and the known record
 * sizes are multiples of one another, so a count wrong by a divisor of the
 * true size MISFRAMES the log rather than refusing it. After E5, `userCount`
 * rests on two independent methods — pyzk's behaviour and zkteco-js's source.
 * `recordCount` rests on zkteco-js alone. This is the missing half.
 *
 * The shape is E5's, unchanged: exactly one nonzero 4-byte word per run,
 * swept across all twenty words of the 80-byte reply, the rest zero, so a run
 * that goes on to read must have read THAT word. Both a user list and an
 * attendance log are served, and the driver is asked for the attendance one.
 *
 * WHAT THIS CAN CONCLUDE, written down before the first run rather than after
 * it, so the framing is not fitted to the answer:
 *
 *  - Which word pyzk's parser reads before it attempts an attendance read.
 *    The nineteen negatives are the evidence; a positive at 32 would only
 *    confirm what zkteco-js's source already says.
 *
 * WHAT IT CANNOT:
 *
 *  - Where a device puts the field. This is a fact about pyzk's parser, in
 *    exactly the way E5 is. If every implementation inherited the same wrong
 *    offset from the same documentation, all of them would agree and all of
 *    them would be wrong. Only checklist item 4, against hardware, retires
 *    that.
 *  - Anything at all, if pyzk turns out not to gate the attendance read on
 *    this reply. Then every one of the twenty runs comes back positive, the
 *    technique does not apply to this counter, and `recordCount` keeps
 *    resting on zkteco-js alone. That is a legitimate outcome of running
 *    this, not a failure to be tuned away: the twenty runs contain both
 *    halves, which is why E6 needs no separate control of E0b's kind.
 */
const FREE_SIZES_RECORD_COUNT_OFFSET = 32

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
  experiment: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7'
  transport: 'tcp' | 'udp'
  options: Partial<EmulatorOptions>
  /**
   * The count to write into the 80-byte override, or `null` to leave the
   * emulator's own 68-byte default handler in place.
   *
   * Named for the value, not for the field: E5 writes a user count here and
   * E6 a record count, and the two sweeps differ in which word they put it
   * at, not in what they write. The fixture records it under the name that
   * matches the mode, so a reader is never told a run served a `userCount`
   * when the question was about records.
   */
  freeSizesCount: number | null
  /**
   * Where in the 80-byte override that count goes. Defaults to the offset
   * this library reads for the user count. Only the sweeps set it, and only
   * their fixtures are evidence about which word an oracle reads.
   */
  freeSizesCountOffset?: number
  /**
   * Which read the driver is asked to attempt. Every variant before E6 asked
   * for the user list, which is why that is the default.
   */
  mode?: 'read-users' | 'read-attendance'
  /** Attendance rows to serve. Only the modes that read them set this. */
  records?: EmulatorRecords
}

const VARIANTS: Variant[] = [
  // Control: the emulator's own default CMD_GET_FREE_SIZES handler (68
  // bytes, no override below), with userCount served correctly. Exists so
  // the negative half of the finding above — that 68 bytes is NOT enough —
  // is itself a fixture, not just a claim in a comment.
  { name: 'E0-free-sizes-default-tcp', experiment: 'E0', transport: 'tcp', options: {}, freeSizesCount: null },
  // Second control, holding the reply length fixed at the 80 bytes E1-E4 are
  // served and varying only the count. E0 vs E1-E4 changes two things at
  // once, so neither shows on its own whether pyzk gates on the count or
  // merely on the reply being long enough. This isolates the count.
  { name: 'E0b-free-sizes-80-count-zero-tcp', experiment: 'E0', transport: 'tcp', options: {}, freeSizesCount: 0 },
  { name: 'E1-no-reply-id-echo-tcp', experiment: 'E1', transport: 'tcp', options: { echoReplyId: false }, freeSizesCount: USERS.length },
  { name: 'E1-wrong-session-id-tcp', experiment: 'E1', transport: 'tcp', options: { replySessionIdOverride: 0x2222 }, freeSizesCount: USERS.length },
  { name: 'E2-size-at-1-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-1' }, freeSizesCount: USERS.length },
  { name: 'E2-size-at-0-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-0' }, freeSizesCount: USERS.length },
  { name: 'E3-chunk-transfer-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'transfer' }, freeSizesCount: USERS.length },
  { name: 'E3-chunk-single-packet-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'single-packet' }, freeSizesCount: USERS.length },
  { name: 'E4-users-72-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 72 }, freeSizesCount: USERS.length },
  { name: 'E4-users-28-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 28 }, freeSizesCount: USERS.length },
  // E5: exactly one nonzero word per run, swept across the whole reply. See
  // FREE_SIZES_SWEEP_OFFSETS above for what this can and cannot conclude.
  // The sweep itself is TCP: the question is which word the parser reads, and
  // the answer should not depend on the transport.
  ...FREE_SIZES_SWEEP_OFFSETS.map((offset): Variant => ({
    name: `E5-free-sizes-count-at-${offset}-tcp`,
    experiment: 'E5',
    transport: 'tcp',
    options: {},
    freeSizesCount: USERS.length,
    freeSizesCountOffset: offset,
  })),
  // "Should not depend on the transport" is an assumption until something
  // checks it, so the sweep's result is re-run over UDP as a PAIR. The
  // positive alone would not do: a UDP run that reads at offset 16 shows only
  // that UDP reads something, not that it reads the same word. The negative
  // beside it is what makes the pair evidence that UDP behaves as TCP did.
  {
    name: 'E5-free-sizes-count-at-16-udp',
    experiment: 'E5',
    transport: 'udp',
    options: {},
    freeSizesCount: USERS.length,
    freeSizesCountOffset: 16,
  },
  {
    name: 'E5-free-sizes-count-at-20-udp',
    experiment: 'E5',
    transport: 'udp',
    options: {},
    freeSizesCount: USERS.length,
    freeSizesCountOffset: 20,
  },
  // E6: the same sweep, asking for the ATTENDANCE read instead. See
  // FREE_SIZES_RECORD_COUNT_OFFSET above for what this can and cannot
  // conclude — written before the first run, not after it.
  ...FREE_SIZES_SWEEP_OFFSETS.map((offset): Variant => ({
    name: `E6-free-sizes-records-at-${offset}-tcp`,
    experiment: 'E6',
    transport: 'tcp',
    options: {},
    freeSizesCount: RECORDS.rows.length,
    freeSizesCountOffset: offset,
    mode: 'read-attendance',
    records: RECORDS,
  })),
  // The same UDP pair E5 carries, for the same reason: a positive alone would
  // show only that UDP reads some count, not that it reads the same word.
  {
    name: `E6-free-sizes-records-at-${FREE_SIZES_RECORD_COUNT_OFFSET}-udp`,
    experiment: 'E6',
    transport: 'udp',
    options: {},
    freeSizesCount: RECORDS.rows.length,
    freeSizesCountOffset: FREE_SIZES_RECORD_COUNT_OFFSET,
    mode: 'read-attendance',
    records: RECORDS,
  },
  {
    name: `E6-free-sizes-records-at-${FREE_SIZES_RECORD_COUNT_OFFSET + 4}-udp`,
    experiment: 'E6',
    transport: 'udp',
    options: {},
    freeSizesCount: RECORDS.rows.length,
    freeSizesCountOffset: FREE_SIZES_RECORD_COUNT_OFFSET + 4,
    mode: 'read-attendance',
    records: RECORDS,
  },
  // E7: the two model-dependent bytes, served distinct instead of zero. See
  // STATUS_PUNCH above for what this can and cannot conclude — written before
  // the first run, not after it. One variant per dialect, because each
  // carries its own pair of offsets and a run covering only the 40-byte form
  // would leave the other two guessed.
  ...([40, 16, 8] as const).map((size): Variant => ({
    name: `E7-status-punch-${size}-tcp`,
    experiment: 'E7',
    transport: 'tcp',
    options: {},
    freeSizesCount: E7_RECORDS[size].rows.length,
    // The word E6 established pyzk reads its record count from. E7 depends on
    // that result rather than re-deriving it.
    freeSizesCountOffset: FREE_SIZES_RECORD_COUNT_OFFSET,
    mode: 'read-attendance',
    records: E7_RECORDS[size],
  })),
  // The 40-byte dialect again over UDP. Not a full second sweep: the question
  // is which byte a parser reads, and E6 already showed this reply's handling
  // does not differ by transport. This is the cheap check that the RECORD
  // decoding does not either.
  {
    name: 'E7-status-punch-40-udp',
    experiment: 'E7',
    transport: 'udp',
    options: {},
    freeSizesCount: E7_RECORDS[40].rows.length,
    freeSizesCountOffset: FREE_SIZES_RECORD_COUNT_OFFSET,
    mode: 'read-attendance',
    records: E7_RECORDS[40],
  },
]

async function runVariant(v: Variant): Promise<void> {
  const count = v.freeSizesCount
  const mode = v.mode ?? 'read-users'
  const emulator = await startEmulator({
    transport: v.transport,
    sessionId: SESSION_ID,
    users: USERS,
    ...(v.records ? { records: v.records } : {}),
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
    const run = await runPyzk([String(emulator.port), v.transport, '0', mode])
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
      // Which read the driver was asked for. Recorded on every fixture, not
      // just the ones that vary it: with two modes in existence, a fixture
      // that omits this leaves a reader to infer the question from the
      // experiment name, and `printed: []` means something different under
      // each mode.
      mode,
      served: {
        users: USERS.map((u) => `${u.uid}|${u.userId}|${u.name}`),
        ...(v.records
          ? {
              records: {
                size: v.records.size,
                rows: v.records.rows.length,
                // The bytes themselves, so what pyzk printed can be checked
                // against what it was given rather than against a summary.
                rowsHex: v.records.rows.map((r) => r.toString('hex')),
              },
            }
          : {}),
        options: v.options,
        // See the comment on freeSizesHandler above: without the override,
        // pyzk never attempts the read this fixture exists to observe. E0
        // deliberately gets none, to put that negative result in a fixture
        // rather than only in this comment.
        // The single nonzero word is named for the count the mode is about.
        // E5 writes a user count and E6 a record count into the same slot;
        // labelling E6's `userCount` would describe the run as evidence about
        // the field it is NOT asking after.
        freeSizesReply: count === null
          ? 'default encodeFreeSizes: 68 bytes, userCount 3'
          : {
              ...(mode === 'read-attendance' ? { recordCount: count } : { userCount: count }),
              replyBytes: FREE_SIZES_REPLY_LEN,
              // The offset actually served, not the constant — the sweeps
              // vary it, and a fixture that recorded the constant while
              // serving something else would be evidence of the wrong thing.
              ...(mode === 'read-attendance'
                ? { recordCountOffset: v.freeSizesCountOffset ?? FREE_SIZES_RECORD_COUNT_OFFSET }
                : { userCountOffset: v.freeSizesCountOffset ?? FREE_SIZES_USER_COUNT_OFFSET }),
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
