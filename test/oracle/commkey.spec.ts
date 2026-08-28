import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OracleFixture } from '../../tools/oracle/analyze.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')

/** Payload data begins after the TCP prefix (8) plus the packet header (8). */
const dataOffset = (transport: 'tcp' | 'udp'): number => (transport === 'tcp' ? 16 : 8)

function load(name: string): OracleFixture | null {
  const file = path.join(DIR, name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OracleFixture) : null
}

describe('comm-key mixing against the oracles', () => {
  for (const transport of ['tcp', 'udp'] as const) {
    it(`pyzk over ${transport} mixes the key the way this library does`, () => {
      const fixture = load(`auth-${transport}-pyzk.json`)
      expect(fixture, 'run `pnpm oracle:capture` to generate this fixture').not.toBeNull()
      const auth = fixture!.packets.find((p) => p.command === CMD.AUTH)
      expect(auth, 'pyzk sent no CMD_AUTH — check the emulator issued ACK_UNAUTH').toBeDefined()

      const body = Buffer.from(auth!.hex, 'hex').subarray(dataOffset(transport))
      expect(body).toEqual(mixCommKey(fixture!.commKey, fixture!.emulatorSessionId))
    })
  }

  it('records whether zkteco-js offered a second opinion', () => {
    // zkteco-js may not support comm keys. If it does not, its auth fixtures
    // carry no CMD_AUTH and comm-key mixing rests on a single oracle. That is
    // a real weakness, so it is asserted explicitly rather than left implicit:
    // whichever branch holds, note it in PROVENANCE.md under the verification
    // level, and add comm-key mixing to the first-hardware checklist.
    //
    // The absence of a CMD_AUTH packet has two possible causes, and they must
    // not be conflated:
    //   1. zkteco-js genuinely has no comm-key support and never tried to
    //      authenticate — the expected, current state of affairs.
    //   2. The capture driver died before it sent anything (a crashed spawn,
    //      a swallowed error) and the fixture is empty for reasons that have
    //      nothing to do with comm-key support.
    // `fixture!.packets.length > 0` cannot tell these apart: CMD_CONNECT is
    // present in every real capture and in nothing else, so asserting on it
    // specifically is what proves the driver ran at all. Only once that is
    // established does "and no CMD_AUTH among them" mean what it claims to
    // mean — an absence has to be demonstrated, not assumed from a fixture
    // merely being non-empty.
    const fixture = load('auth-tcp-zkteco-js.json')
    expect(fixture).not.toBeNull()
    const auth = fixture!.packets.find((p) => p.command === CMD.AUTH)
    if (auth) {
      const body = Buffer.from(auth.hex, 'hex').subarray(dataOffset('tcp'))
      expect(body).toEqual(mixCommKey(fixture!.commKey, fixture!.emulatorSessionId))
    } else {
      const connect = fixture!.packets.find((p) => p.command === CMD.CONNECT)
      expect(connect, 'no CMD_CONNECT captured — the driver never ran, this proves nothing about comm-key support').toBeDefined()
      expect(fixture!.packets.some((p) => p.command === CMD.AUTH)).toBe(false)
    }
  })
})
