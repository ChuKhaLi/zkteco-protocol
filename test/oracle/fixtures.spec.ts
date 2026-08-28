import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyChecksum, type OracleFixture } from '../../tools/oracle/analyze.js'
import { START_MARKER } from '../../src/codec/framing.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')
// Only the handshake captures. Task 14 adds `auth-*` fixtures alongside these;
// they are asserted separately because comm-key mixing has its own oracle story.
const fixtures = readdirSync(DIR)
  .filter((f) => f.startsWith('handshake-') && f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as OracleFixture)

describe('oracle fixtures', () => {
  it('exist for both oracles on both transports', () => {
    const seen = fixtures.map((f) => `${f.source}/${f.transport}`).sort()
    expect(seen).toEqual([
      'pyzk/tcp', 'pyzk/udp', 'zkteco-js/tcp', 'zkteco-js/udp',
    ])
  })

  it.each(fixtures.map((f) => [`${f.source} over ${f.transport}`, f] as const))(
    '%s captured a handshake', (_name, fixture) => {
      expect(fixture.packets.length).toBeGreaterThan(0)
      expect(fixture.packets[0]!.command).toBe(CMD.CONNECT)
    },
  )

  it.each(fixtures.filter((f) => f.transport === 'tcp').map((f) => [f.source, f] as const))(
    '%s frames TCP packets with the start marker this library writes', (_src, fixture) => {
      for (const p of fixture.packets) {
        expect(Buffer.from(p.hex, 'hex').subarray(0, 4)).toEqual(START_MARKER)
      }
    },
  )

  it.each(fixtures.filter((f) => f.transport === 'udp').map((f) => [f.source, f] as const))(
    '%s sends UDP payloads bare, with no start marker', (_src, fixture) => {
      for (const p of fixture.packets) {
        expect(Buffer.from(p.hex, 'hex').subarray(0, 4)).not.toEqual(START_MARKER)
      }
    },
  )

  it('both oracles agree on which reply id the checksum covers', () => {
    // This is the adjudication described in spec §5.1. Whatever the two
    // independent implementations agree on is what the library implements. If
    // this test ever fails, do NOT pick a side: record the divergence and
    // leave it for first-hardware verification.
    const verdicts = new Map<string, Set<string>>()
    let discriminatingPackets = 0
    for (const fixture of fixtures) {
      const classes = fixture.packets.map((p) => classifyChecksum(p))
      // Exclude ambiguous packets; they provide no evidence
      const nonAmbiguous = new Set(classes.filter((c) => c !== 'ambiguous'))
      verdicts.set(`${fixture.source}/${fixture.transport}`, nonAmbiguous)
      discriminatingPackets += classes.filter((c) => c !== 'ambiguous').length
    }
    const flattened = new Set([...verdicts.values()].flatMap((s) => [...s]))
    expect(flattened.has('neither')).toBe(false)
    expect(discriminatingPackets, `need at least one discriminating packet; found ${discriminatingPackets}`).toBeGreaterThan(0)
    expect(flattened.size, `oracles disagree: ${JSON.stringify([...verdicts])}`).toBe(1)
  })
})
