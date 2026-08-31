import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyChecksum, fixtureInventory, type OracleFixture } from '../../tools/oracle/analyze.js'
import { START_MARKER } from '../../src/codec/framing.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')
// Every captured fixture, handshake and auth alike. This used to be filtered
// to `handshake-*` only, on the theory that comm-key mixing had its own
// separate oracle story -- but that filter meant only 6 of the 14
// discriminating packets PROVENANCE.md claims were ever actually classified.
// The `auth-*` fixtures are well-formed CMD_AUTH exchanges with their own
// reply-id checksums, and belong in this adjudication like everything else.
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as OracleFixture)

// Hand-derived by reading the eight files in test/fixtures/oracle: 18 packets
// in total, of which pyzk's four initial CMD_CONNECTs carry replyId === 0 and
// are therefore arithmetically ambiguous. Pinned as a whole rather than as the
// discriminating count alone -- see the blind-spot test at the bottom of this
// file for why that count on its own could not do the job.
const EXPECTED_FILES = [
  'auth-tcp-pyzk.json',
  'auth-tcp-zkteco-js.json',
  'auth-udp-pyzk.json',
  'auth-udp-zkteco-js.json',
  'handshake-tcp-pyzk.json',
  'handshake-tcp-zkteco-js.json',
  'handshake-udp-pyzk.json',
  'handshake-udp-zkteco-js.json',
]
const EXPECTED_INVENTORY = { fixtures: 8, packets: 18, ambiguous: 4, discriminating: 14 }

describe('oracle fixtures', () => {
  it('exist for both oracles on both transports', () => {
    // Deduplicated: each combo now has both a handshake-* and an auth-*
    // fixture, so this checks presence, not a fixture count.
    const seen = new Set(fixtures.map((f) => `${f.source}/${f.transport}`))
    expect([...seen].sort()).toEqual([
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
    //
    // Asserting `flattened.size === 1` alone is not enough: a set of size 1
    // is satisfied just as well by { 'previous-reply-id' } as by { 'self' }.
    // A synthetic packet checksummed over `replyId - 1` classifies as
    // 'previous-reply-id' and would pass a size-1 check while asserting the
    // opposite of what Session.send actually does. The set must equal
    // exactly {'self'} -- what it contains, not just how many things it has.
    const verdicts = new Map<string, Set<string>>()
    for (const fixture of fixtures) {
      const classes = fixture.packets.map((p) => classifyChecksum(p))
      // Exclude ambiguous packets; they provide no evidence. 'neither' is NOT
      // excluded -- a packet matching no hypothesis has to reach the set below
      // and fail this loudly rather than be dropped with the uninformative.
      const nonAmbiguous = new Set(classes.filter((c) => c !== 'ambiguous'))
      verdicts.set(`${fixture.source}/${fixture.transport}`, nonAmbiguous)
    }
    const flattened = new Set([...verdicts.values()].flatMap((s) => [...s]))
    // How many packets this verdict rests on is pinned by EXPECTED_INVENTORY
    // and the two tests at the bottom of this file, not counted a second time
    // here: PROVENANCE.md's claim of 14 discriminating packets is an inventory
    // question, and counting it in this test left the corpus itself unguarded.
    expect(flattened, `oracles disagree: ${JSON.stringify([...verdicts])}`).toEqual(new Set(['self']))
  })

  it('data-bearing packets are classified correctly', () => {
    // Read a CMD_AUTH packet from the auth fixture. It carries encrypted comm key
    // data. This test would fail with the old signature (which defaulted
    // dataHexAfterHeader to '') because the checksum would be computed over an
    // empty payload, returning 'neither'.
    const authFixture = JSON.parse(
      readFileSync(path.join(DIR, 'auth-tcp-pyzk.json'), 'utf8'),
    ) as OracleFixture
    // The second packet is CMD_AUTH with 4 bytes of encrypted key data
    const authPacket = authFixture.packets[1]!
    expect(authPacket.command).toBe(1102) // CMD_AUTH
    const result = classifyChecksum(authPacket)
    expect(result).toBe('self')
  })

  it('packets with replyId === 0 are classified as ambiguous', () => {
    // When replyId === 0, one's-complement folding makes a reply-id word of
    // 0x0000 and (0 - 1) & 0xffff = 0xFFFF produce the same checksum, creating
    // an arithmetical tie: both 'self' and 'previous-reply-id' hypotheses are
    // correct. This must be reported as 'ambiguous' to signal that the packet
    // provides no discriminating evidence.
    const handshakeFixture = JSON.parse(
      readFileSync(path.join(DIR, 'handshake-tcp-pyzk.json'), 'utf8'),
    ) as OracleFixture
    // The first packet is CMD_CONNECT with replyId=0
    const connectPacket = handshakeFixture.packets[0]!
    expect(connectPacket.command).toBe(CMD.CONNECT)
    expect(connectPacket.replyId).toBe(0)
    const result = classifyChecksum(connectPacket)
    expect(result).toBe('ambiguous')
  })

  it('a replyId === 0 packet whose checksum matches neither hypothesis is not ambiguous', () => {
    // The arithmetical tie at replyId === 0 says the two hypotheses cannot be
    // told APART. It does not say the packet is sound. A capture whose
    // transmitted checksum survives neither hypothesis is corrupt or foreign,
    // and 'neither' is the class that says so -- "investigate before trusting
    // any of it", per classifyChecksum's own doc comment. Testing the tie
    // before comparing to p.checksum reports that packet as 'ambiguous'
    // instead, which a reader takes as "sound, but carries no evidence".
    const handshakeFixture = JSON.parse(
      readFileSync(path.join(DIR, 'handshake-tcp-pyzk.json'), 'utf8'),
    ) as OracleFixture
    const connectPacket = handshakeFixture.packets[0]!
    expect(connectPacket.replyId).toBe(0)
    // Pins the fixture this test's meaning rests on: 0xFC17 is the checksum
    // pyzk actually transmitted, so the corruption below really is one.
    expect(connectPacket.checksum).toBe(0xfc17)

    expect(classifyChecksum({ ...connectPacket, checksum: 0x0001 })).toBe('neither')
  })

  it('the fixture tree is exactly the eight files this adjudication was counted over', () => {
    // readdirSync is not recursive, so a fixture belonging in commkey/, params/
    // or realtime/ that lands here instead is read as handshake evidence. The
    // presence test above cannot see it either: it deduplicates by
    // source/transport, so a ninth file duplicating an existing combo is
    // invisible there by construction.
    expect(readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()).toEqual(EXPECTED_FILES)
  })

  it('the adjudication covers the whole inventory, not just its discriminating packets', () => {
    expect(fixtureInventory(fixtures)).toEqual(EXPECTED_INVENTORY)
  })

  it('an all-replyId-0 fixture moves the inventory even though it adds no evidence', () => {
    // The blind spot the inventory exists to close, stated as a test rather
    // than as a note in a handoff. Every packet in this fixture classifies as
    // 'ambiguous', so it contributes nothing to the discriminating count --
    // the only number the guard used to check. Filed under a source/transport
    // combo that already exists, it clears the presence test too.
    //
    // The packet is pyzk's real UDP CMD_CONNECT, copied verbatim: a synthetic
    // one could be dismissed as not resembling anything a capture produces.
    const misfiled: OracleFixture = {
      source: 'pyzk',
      transport: 'udp',
      commKey: 0,
      emulatorSessionId: 0,
      packets: [
        { hex: 'e80317fc00000000', command: 1000, checksum: 0xfc17, sessionId: 0, replyId: 0 },
      ],
    }

    const withMisfiled = fixtureInventory([...fixtures, misfiled])

    // What the old guard looked at, unmoved: this is the failure being fixed.
    expect(withMisfiled.discriminating).toBe(EXPECTED_INVENTORY.discriminating)
    // What the new guard looks at, moved.
    expect(withMisfiled.fixtures).toBe(9)
    expect(withMisfiled.packets).toBe(19)
    expect(withMisfiled.ambiguous).toBe(5)
    expect(withMisfiled).not.toEqual(EXPECTED_INVENTORY)
  })
})
