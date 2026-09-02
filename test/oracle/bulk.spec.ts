import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join('test', 'fixtures', 'oracle', 'bulk')
const VARIANTS = [
  'E1-no-reply-id-echo-tcp', 'E1-wrong-session-id-tcp',
  'E2-size-at-1-tcp', 'E2-size-at-0-tcp',
  'E3-chunk-transfer-tcp', 'E3-chunk-single-packet-tcp',
  'E4-users-72-udp', 'E4-users-28-udp',
]

// These fixtures are evidence for PROVENANCE.md, not tests of the library.
// What is asserted is that the evidence is present and says whether it ran:
// a deleted fixture, or one recorded as not completed, must be noticed.
describe('buffered-read experiments (spec v0.5 §12)', () => {
  it.each(VARIANTS)('%s is recorded', (name) => {
    const file = path.join(DIR, `${name}.json`)
    expect(existsSync(file)).toBe(true)
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as { completed: boolean; exitCode: number | null; sent: unknown[] }
    expect(typeof fixture.completed).toBe('boolean')
    expect(fixture.sent.length).toBeGreaterThan(0)
  })
})
