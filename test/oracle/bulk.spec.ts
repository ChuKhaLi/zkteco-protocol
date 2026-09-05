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
})
