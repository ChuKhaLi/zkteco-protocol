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
// a zero count. Without this column, that half of the claim rests on nothing.
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
