import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OracleFixture } from '../../tools/oracle/analyze.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')
// The low-byte/high-byte/different-key characterisation fixtures live in
// their own subdirectory, not DIR itself — test/oracle/fixtures.spec.ts scans
// every *.json directly under DIR for the reply-id checksum adjudication and
// asserts an exact count of discriminating packets across that corpus; these
// captures answer a different question (the comm-key low-byte invariance)
// and must not silently change that count.
const COMMKEY_DIR = path.join(DIR, 'commkey')

/** Payload data begins after the TCP prefix (8) plus the packet header (8). */
const dataOffset = (transport: 'tcp' | 'udp'): number => (transport === 'tcp' ? 16 : 8)

function load(name: string, dir = DIR): OracleFixture | null {
  const file = path.join(dir, name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OracleFixture) : null
}

/** The CMD_AUTH payload data of a captured fixture, or null if none was sent. */
function authBody(fixture: OracleFixture, transport: 'tcp' | 'udp'): Buffer | null {
  const auth = fixture.packets.find((p) => p.command === CMD.AUTH)
  return auth ? Buffer.from(auth.hex, 'hex').subarray(dataOffset(transport)) : null
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
      // The absence of CMD_AUTH is what put us in this branch, so the fixture
      // proves zkteco-js did not attempt authentication.
    }
  })

  describe('the low-byte-discard invariance, against real external data', () => {
    // The single (ORACLE_COMM_KEY, EMULATOR_SESSION_ID) pair above vindicates
    // mixCommKey's output at one point, but pyzk was never asked to mix two
    // session ids differing only in the low byte -- EMULATOR_SESSION_ID's low
    // byte never varied across any of the fixtures loaded above. So the
    // low-byte-discard invariance itself rested solely on this library's own
    // code (test/codec/commkey.spec.ts), not on pyzk. These fixtures close
    // that gap: `tools/oracle/capture.ts` drove pyzk against three additional
    // (commKey, sessionId) pairs specifically to test it.

    it('pyzk emits byte-identical CMD_AUTH payloads for two session ids differing only in the low byte', () => {
      const baseline = load('auth-tcp-pyzk.json')
      const lowbyte = load('auth-lowbyte-tcp-pyzk.json', COMMKEY_DIR)
      expect(baseline, 'run `pnpm oracle:capture`').not.toBeNull()
      expect(lowbyte, 'run `pnpm oracle:capture` to generate auth-lowbyte-tcp-pyzk.json').not.toBeNull()

      // Sanity check on the fixtures themselves: if these two session ids
      // didn't actually differ only in the low byte, a passing assertion
      // below would prove nothing about the invariance under test.
      expect(baseline!.emulatorSessionId >> 8).toBe(lowbyte!.emulatorSessionId >> 8)
      expect(baseline!.emulatorSessionId & 0xff).not.toBe(lowbyte!.emulatorSessionId & 0xff)
      expect(baseline!.commKey).toBe(lowbyte!.commKey)

      const baselineAuth = authBody(baseline!, 'tcp')
      const lowbyteAuth = authBody(lowbyte!, 'tcp')
      expect(baselineAuth, 'pyzk sent no CMD_AUTH for the baseline pair').not.toBeNull()
      expect(lowbyteAuth, 'pyzk sent no CMD_AUTH for the low-byte variant').not.toBeNull()
      // This is the assertion that actually tests the invariance: two
      // different session ids, external computation, identical bytes out.
      expect(lowbyteAuth).toEqual(baselineAuth)
    })

    it('a high-byte-differing session id is not similarly discarded — the CMD_AUTH bytes actually change', () => {
      // Guards against a vacuous invariance: if mixCommKey (and pyzk) simply
      // ignored the session id entirely, the low-byte test above would still
      // pass for the wrong reason. This confirms the high byte is not
      // erased the same way.
      const baseline = load('auth-tcp-pyzk.json')
      const highbyte = load('auth-highbyte-tcp-pyzk.json', COMMKEY_DIR)
      expect(highbyte, 'run `pnpm oracle:capture` to generate auth-highbyte-tcp-pyzk.json').not.toBeNull()
      expect(baseline!.emulatorSessionId & 0xff).toBe(highbyte!.emulatorSessionId & 0xff)
      expect(baseline!.emulatorSessionId >> 8).not.toBe(highbyte!.emulatorSessionId >> 8)

      expect(authBody(highbyte!, 'tcp')).not.toEqual(authBody(baseline!, 'tcp'))
    })

    it('mixCommKey matches pyzk on the low-byte variant, the high-byte variant, and a different comm key', () => {
      for (const name of [
        'auth-lowbyte-tcp-pyzk.json',
        'auth-highbyte-tcp-pyzk.json',
        'auth-keydiff-tcp-pyzk.json',
      ]) {
        const fixture = load(name, COMMKEY_DIR)
        expect(fixture, `run \`pnpm oracle:capture\` to generate ${name}`).not.toBeNull()
        const body = authBody(fixture!, 'tcp')
        expect(body, `${name}: pyzk sent no CMD_AUTH`).not.toBeNull()
        expect(body).toEqual(mixCommKey(fixture!.commKey, fixture!.emulatorSessionId))
      }
    })
  })
})
