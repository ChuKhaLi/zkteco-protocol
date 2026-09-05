import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join('test', 'fixtures', 'oracle', 'bulk')

/** CMD_PREPARE_BUFFER: the first command of the buffered read. */
const PREPARE_BUFFER = 1503

interface Expected {
  name: string
  completed: boolean
  exitCode: number
  /** Whether `printed` should equal `served.users` (a genuine read) or `[]` (no read happened). */
  read: boolean
  /** Whether `pyzk` got as far as sending a PREPARE_BUFFER at all. */
  prepared: boolean
}

const EXPECTED: Expected[] = [
  { name: 'E0-free-sizes-default-tcp', completed: true, exitCode: 0, read: false, prepared: false },
  // The same 80-byte reply E1-E4 are served, with the count 0 instead of 3:
  // pyzk stops in the same place the 68-byte E0 does. The count is what gates
  // the read, which E0 alone could not show — it varies length and count at
  // once.
  { name: 'E0b-free-sizes-80-count-zero-tcp', completed: true, exitCode: 0, read: false, prepared: false },
  { name: 'E1-no-reply-id-echo-tcp', completed: true, exitCode: 0, read: true, prepared: true },
  { name: 'E1-wrong-session-id-tcp', completed: true, exitCode: 0, read: true, prepared: true },
  { name: 'E2-size-at-1-tcp', completed: true, exitCode: 0, read: true, prepared: true },
  { name: 'E2-size-at-0-tcp', completed: false, exitCode: 2, read: false, prepared: true },
  { name: 'E3-chunk-transfer-tcp', completed: true, exitCode: 0, read: true, prepared: true },
  { name: 'E3-chunk-single-packet-tcp', completed: false, exitCode: 2, read: false, prepared: true },
  { name: 'E4-users-72-udp', completed: true, exitCode: 0, read: true, prepared: true },
  { name: 'E4-users-28-udp', completed: true, exitCode: 0, read: true, prepared: true },
]

interface Fixture {
  completed: boolean
  exitCode: number | null
  printed: string[]
  sent: { command: number }[]
  served: { users: string[] }
}

// These fixtures are evidence for PROVENANCE.md, not tests of the library.
// A boolean-typed `completed` notices nothing on its own — two of these
// fixtures are legitimately `completed: false`, and a regeneration that
// silently flipped ANY of the nine recorded outcomes (E2-size-at-0 starting
// to succeed, E1 starting to fail, etc.) would change what this project
// believes pyzk does without anyone noticing. So each row here pins the
// exact outcome the corresponding fixture was captured with: existence,
// `completed`, `exitCode`, whether pyzk actually read the served users back
// (`printed` equal to `served.users`) or not (`printed` empty), and whether it
// got as far as a PREPARE_BUFFER. A regeneration that disagrees with any row
// must fail here, not rewrite the project's belief silently.
//
// `prepared` is not redundant with `read`. Four fixtures print nothing for two
// different reasons — E0 and E0b never start the read, E2-size-at-0 and
// E3-chunk-single-packet start it and fail partway — and PROVENANCE cites the
// E0/E0b pair for the stronger claim that no PREPARE_BUFFER is ever sent under
// a reply pyzk reads no count from (E0: too short; E0b: count 0). Without this
// column, that half of the claim rests on nothing.
describe('buffered-read experiments (spec v0.5 §12)', () => {
  it.each(EXPECTED)('$name is recorded', (expected) => {
    const file = path.join(DIR, `${expected.name}.json`)
    expect(existsSync(file)).toBe(true)
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as Fixture
    expect(fixture.sent.length).toBeGreaterThan(0)
    expect(fixture.completed).toBe(expected.completed)
    expect(fixture.exitCode).toBe(expected.exitCode)
    expect(fixture.printed).toEqual(expected.read ? fixture.served.users : [])
    expect(fixture.sent.some((p) => p.command === PREPARE_BUFFER)).toBe(expected.prepared)
  })
})

/** The 80-byte override E5 sweeps, as 4-byte words. */
const SWEEP_OFFSETS = Array.from({ length: 20 }, (_, word) => word * 4)

/** The offset `src/commands/info.ts` reads, and the one E5 set out to test. */
const LIBRARY_USER_COUNT_OFFSET = 16

interface SweepFixture extends Fixture {
  served: { users: string[]; freeSizesReply: { userCountOffset: number } }
}

function sweepFixture(offset: number): SweepFixture {
  const file = path.join(DIR, `E5-free-sizes-count-at-${offset}-tcp.json`)
  expect(existsSync(file)).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as SweepFixture
}

// E5 asks which WORD of the free-sizes reply pyzk reads its user count from.
//
// E0b and E1-E4 could not answer it. They serve a body that is zero except at
// offset 16, so "pyzk stopped when offset 16 was zeroed" is equally consistent
// with pyzk reading offset 16 and with pyzk reading any word that was zero in
// every one of those fixtures anyway. E5 serves exactly one nonzero word per
// run and sweeps all twenty, so a run that reads must have read THAT word.
//
// The positive result at 16 is the weaker half and was already implied. The
// nineteen NEGATIVES are what this experiment adds: nothing else in the reply
// triggers the read, which is what turns "offset 16 is where pyzk looks" from
// an inference into a recorded observation.
//
// What it does NOT establish: where a real device puts the field. This is a
// fact about pyzk's parser. PROVENANCE.md, "Unverified field offsets", keeps
// that distinction.
describe('free-sizes offset sweep (E5)', () => {
  it('sweeps every word of the 80-byte reply, so no offset is silently untested', () => {
    // A future edit that shortened the sweep would otherwise narrow the
    // finding without any test noticing.
    expect(SWEEP_OFFSETS).toHaveLength(20)
    expect(SWEEP_OFFSETS[SWEEP_OFFSETS.length - 1]! + 4).toBe(80)
    for (const offset of SWEEP_OFFSETS) {
      expect(sweepFixture(offset).served.freeSizesReply.userCountOffset).toBe(offset)
    }
  })

  it('exactly one word triggers the read, and it is the offset the library reads', () => {
    // Computed from the fixtures, never asserted per-offset from a hardcoded
    // list: a table saying "16 reads, the rest do not" would restate the
    // conclusion instead of deriving it, and would still pass if a
    // regeneration turned a second offset positive.
    const positives = SWEEP_OFFSETS.filter((offset) => sweepFixture(offset).printed.length > 0)
    expect(positives).toEqual([LIBRARY_USER_COUNT_OFFSET])
  })

  it('every other word leaves pyzk stopping before it prepares a read', () => {
    // The negative half, pinned as its own outcome rather than inferred from
    // an empty `printed`: E2 and E3 show that printing nothing is also what a
    // read that STARTED and failed looks like, so "no PREPARE_BUFFER" is the
    // claim that separates "never began" from "began and broke".
    for (const offset of SWEEP_OFFSETS.filter((o) => o !== LIBRARY_USER_COUNT_OFFSET)) {
      const fixture = sweepFixture(offset)
      expect(fixture.completed).toBe(true)
      expect(fixture.printed).toEqual([])
      expect(fixture.sent.some((p) => p.command === PREPARE_BUFFER)).toBe(false)
    }
  })

  it('the positive offset reads the served users back in full', () => {
    const fixture = sweepFixture(LIBRARY_USER_COUNT_OFFSET)
    expect(fixture.completed).toBe(true)
    expect(fixture.printed).toEqual(fixture.served.users)
    expect(fixture.sent.some((p) => p.command === PREPARE_BUFFER)).toBe(true)
  })

  // The sweep runs over TCP. That the answer does not depend on the transport
  // is an assumption until something checks it, so the result is re-run over
  // UDP as a PAIR. A UDP positive on its own would show only that UDP reads
  // some count, not that it reads the SAME word; the negative beside it is
  // what makes the two fixtures evidence rather than a restatement.
  it('holds over UDP too, positive and negative', () => {
    const positive = JSON.parse(
      readFileSync(path.join(DIR, 'E5-free-sizes-count-at-16-udp.json'), 'utf8'),
    ) as SweepFixture
    expect(positive.served.freeSizesReply.userCountOffset).toBe(LIBRARY_USER_COUNT_OFFSET)
    expect(positive.printed).toEqual(positive.served.users)
    expect(positive.sent.some((p) => p.command === PREPARE_BUFFER)).toBe(true)

    const negative = JSON.parse(
      readFileSync(path.join(DIR, 'E5-free-sizes-count-at-20-udp.json'), 'utf8'),
    ) as SweepFixture
    expect(negative.served.freeSizesReply.userCountOffset).toBe(20)
    expect(negative.printed).toEqual([])
    expect(negative.sent.some((p) => p.command === PREPARE_BUFFER)).toBe(false)
  })
})

/** CMD_ATTLOG_RRQ: the attendance log. Hardcoded for the reason below. */
const ATTLOG_RRQ = 13

/**
 * The offset `src/commands/info.ts` reads for the record count, and the one
 * E6 set out to test.
 *
 * Hardcoded rather than imported from `FREE_SIZES_OFFSET`, deliberately and
 * for the same reason `LIBRARY_USER_COUNT_OFFSET` above is. These fixtures are
 * a fact about pyzk, not about this library. Importing the constant would let
 * an edit to the library move the test's expectation with it, and the
 * corroboration claim in PROVENANCE.md would keep passing while quietly coming
 * to mean something else.
 */
const LIBRARY_RECORD_COUNT_OFFSET = 32

interface RecordSweepFixture extends Fixture {
  mode: string
  served: {
    users: string[]
    records: { size: number; rows: number; rowsHex: string[] }
    freeSizesReply: { recordCount: number; recordCountOffset: number }
  }
  sent: { command: number; data?: string }[]
}

function recordSweepFixture(offset: number, transport: 'tcp' | 'udp' = 'tcp'): RecordSweepFixture {
  const file = path.join(DIR, `E6-free-sizes-records-at-${offset}-${transport}.json`)
  expect(existsSync(file)).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as RecordSweepFixture
}

/** The commands PREPARE_BUFFER was sent for, read out of its request body. */
function preparedFor(fixture: RecordSweepFixture): number[] {
  return fixture.sent
    .filter((p) => p.command === PREPARE_BUFFER)
    // Request body: <int8 1><int16 command><int32 fct><int32 ext>.
    .map((p) => Buffer.from(p.data as string, 'hex').readUInt16LE(1))
}

// E6 asks E5's question about the OTHER counter: which word of the free-sizes
// reply does pyzk read its RECORD count from?
//
// It matters for the same reason and fails more quietly. `detectRecordSize`
// divides the attendance body by that count, and 8, 16 and 40 are multiples of
// one another, so a count wrong by a divisor of the true size misframes the
// log instead of refusing it.
//
// Same shape as E5: exactly one nonzero word per run, all twenty swept, so a
// run that reads must have read THAT word. Three users and three attendance
// rows are served, and both candidate counts are therefore 3 — a run is
// explained by the offset it read at, never by the value it found there.
//
// What it does NOT establish: where a real device puts the field. This is a
// fact about pyzk's parser, exactly as E5 is. PROVENANCE.md keeps that
// distinction.
describe('free-sizes record-count offset sweep (E6)', () => {
  it('sweeps every word of the 80-byte reply, so no offset is silently untested', () => {
    expect(SWEEP_OFFSETS).toHaveLength(20)
    expect(SWEEP_OFFSETS[SWEEP_OFFSETS.length - 1]! + 4).toBe(80)
    for (const offset of SWEEP_OFFSETS) {
      const fixture = recordSweepFixture(offset)
      expect(fixture.served.freeSizesReply.recordCountOffset).toBe(offset)
      // A run captured under the user-reading mode would answer a different
      // question while filing its answer here.
      expect(fixture.mode).toBe('read-attendance')
    }
  })

  it('exactly one word triggers the attendance read, and it is the offset the library reads', () => {
    // Computed from the fixtures, never asserted per-offset from a hardcoded
    // list: a table saying "32 reads, the rest do not" would restate the
    // conclusion instead of deriving it, and would still pass if a
    // regeneration turned a second offset positive.
    const positives = SWEEP_OFFSETS.filter((offset) => recordSweepFixture(offset).printed.length > 0)
    expect(positives).toEqual([LIBRARY_RECORD_COUNT_OFFSET])
  })

  it('every other word leaves pyzk stopping before it prepares a read', () => {
    // The negative half, pinned as its own outcome rather than inferred from
    // an empty `printed`: E2 and E3 show that printing nothing is also what a
    // read that STARTED and failed looks like, so "no PREPARE_BUFFER" is the
    // claim that separates "never began" from "began and broke".
    for (const offset of SWEEP_OFFSETS.filter((o) => o !== LIBRARY_RECORD_COUNT_OFFSET)) {
      const fixture = recordSweepFixture(offset)
      expect(fixture.completed).toBe(true)
      expect(fixture.printed).toEqual([])
      expect(preparedFor(fixture)).toEqual([])
    }
  })

  it('the word that gates the attendance read is not the word that gates the user read', () => {
    // The finding this experiment exists for, stated as its own assertion
    // rather than left implicit across two separate sweeps. Offset 16 is where
    // pyzk reads the USER count (E5); asking it for attendance with only that
    // word nonzero produces no read at all. So the two counters are read from
    // two different words, and E6's positive is not just "pyzk noticed a
    // nonzero number somewhere in the reply".
    expect(LIBRARY_RECORD_COUNT_OFFSET).not.toBe(LIBRARY_USER_COUNT_OFFSET)
    const atUserCountWord = recordSweepFixture(LIBRARY_USER_COUNT_OFFSET)
    expect(atUserCountWord.printed).toEqual([])
    expect(preparedFor(atUserCountWord)).toEqual([])
    // And the converse, from E5's sweep: with only word 32 nonzero, the USER
    // read does not happen either. Without this half, "the words are
    // different" would rest on one direction.
    expect(sweepFixture(LIBRARY_RECORD_COUNT_OFFSET).printed).toEqual([])
  })

  it('the positive offset reads the served rows back, as attendance', () => {
    const fixture = recordSweepFixture(LIBRARY_RECORD_COUNT_OFFSET)
    expect(fixture.completed).toBe(true)
    expect(fixture.served.records.size).toBe(40)
    expect(fixture.served.records.rows).toBe(3)
    // The buffered read was prepared for the ATTENDANCE log specifically, not
    // merely for something. Without this, a run that read the user list would
    // satisfy every other assertion here.
    expect(preparedFor(fixture)).toEqual([ATTLOG_RRQ])
    // What pyzk decoded out of the three 40-byte rows the emulator served.
    //
    // Two of the four fields are discriminating and two are not. The user ids
    // are read from bytes 2..25 and the timestamps from the packed uint32 at
    // byte 27; both are distinct per row, so a parser reading either at any
    // other offset would print NULs or a wildly different date. `status` and
    // `punch` are NOT evidence of anything here — the emulator served both
    // bytes as zero, so `0|0` is what a parser reading the right byte and a
    // parser reading any other zero byte would equally print. E6 says nothing
    // about the status/punch mapping, and this list must not be cited as if it
    // did.
    expect(fixture.printed).toEqual([
      '100001|2000-01-01 00:00:00|0|0',
      '100002|2000-01-02 00:00:00|0|0',
      '100003|2000-01-03 00:00:00|0|0',
    ])
  })

  // The sweep runs over TCP, and "the answer does not depend on the transport"
  // is an assumption until something checks it — so the result is re-run over
  // UDP as a PAIR, as E5's is. A UDP positive alone would show only that UDP
  // reads some count, not that it reads the SAME word.
  it('holds over UDP too, positive and negative', () => {
    const positive = recordSweepFixture(LIBRARY_RECORD_COUNT_OFFSET, 'udp')
    expect(positive.served.freeSizesReply.recordCountOffset).toBe(LIBRARY_RECORD_COUNT_OFFSET)
    expect(positive.printed).toEqual(recordSweepFixture(LIBRARY_RECORD_COUNT_OFFSET).printed)
    expect(preparedFor(positive)).toEqual([ATTLOG_RRQ])

    const negative = recordSweepFixture(LIBRARY_RECORD_COUNT_OFFSET + 4, 'udp')
    expect(negative.served.freeSizesReply.recordCountOffset).toBe(LIBRARY_RECORD_COUNT_OFFSET + 4)
    expect(negative.printed).toEqual([])
    expect(preparedFor(negative)).toEqual([])
  })
})
