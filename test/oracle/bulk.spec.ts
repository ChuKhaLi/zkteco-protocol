import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join('test', 'fixtures', 'oracle', 'bulk')

interface Expected {
  name: string
  completed: boolean
  exitCode: number
  /** Whether `printed` should equal `served.users` (a genuine read) or `[]` (no read happened). */
  read: boolean
}

const EXPECTED: Expected[] = [
  { name: 'E0-free-sizes-default-tcp', completed: true, exitCode: 0, read: false },
  { name: 'E1-no-reply-id-echo-tcp', completed: true, exitCode: 0, read: true },
  { name: 'E1-wrong-session-id-tcp', completed: true, exitCode: 0, read: true },
  { name: 'E2-size-at-1-tcp', completed: true, exitCode: 0, read: true },
  { name: 'E2-size-at-0-tcp', completed: false, exitCode: 2, read: false },
  { name: 'E3-chunk-transfer-tcp', completed: true, exitCode: 0, read: true },
  { name: 'E3-chunk-single-packet-tcp', completed: false, exitCode: 2, read: false },
  { name: 'E4-users-72-udp', completed: true, exitCode: 0, read: true },
  { name: 'E4-users-28-udp', completed: true, exitCode: 0, read: true },
]

interface Fixture {
  completed: boolean
  exitCode: number | null
  printed: string[]
  sent: unknown[]
  served: { users: string[] }
}

// These fixtures are evidence for PROVENANCE.md, not tests of the library.
// A boolean-typed `completed` notices nothing on its own — two of these
// fixtures are legitimately `completed: false`, and a regeneration that
// silently flipped ANY of the nine recorded outcomes (E2-size-at-0 starting
// to succeed, E1 starting to fail, etc.) would change what this project
// believes pyzk does without anyone noticing. So each row here pins the
// exact outcome the corresponding fixture was captured with: existence,
// `completed`, `exitCode`, and whether pyzk actually read the served users
// back (`printed` equal to `served.users`) or not (`printed` empty). A
// regeneration that disagrees with any row must fail here, not rewrite the
// project's belief silently.
describe('buffered-read experiments (spec v0.5 §12)', () => {
  it.each(EXPECTED)('$name is recorded', (expected) => {
    const file = path.join(DIR, `${expected.name}.json`)
    expect(existsSync(file)).toBe(true)
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as Fixture
    expect(fixture.sent.length).toBeGreaterThan(0)
    expect(fixture.completed).toBe(expected.completed)
    expect(fixture.exitCode).toBe(expected.exitCode)
    expect(fixture.printed).toEqual(expected.read ? fixture.served.users : [])
  })
})
