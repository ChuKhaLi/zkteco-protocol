import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'

interface Packet { command: number; data: string }
interface Fixture { source: string; transport: string; packets: Packet[] }

const DIR = path.join('test', 'fixtures', 'oracle', 'realtime')
const FILES = ['realtime-tcp-pyzk.json', 'realtime-tcp-zkteco-js.json',
               'realtime-udp-pyzk.json', 'realtime-udp-zkteco-js.json']

const load = (file: string): Fixture =>
  JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as Fixture

describe('realtime oracle fixtures', () => {
  it('captured every oracle and transport combination', () => {
    // A silently empty fixture is the failure mode this guards: a spawn that
    // failed writes zero packets while the suite stays green.
    for (const file of FILES) expect(load(file).packets.length).toBeGreaterThan(0)
  })

  it('registers with a four-byte mask wherever a subscription was registered', () => {
    for (const file of FILES) {
      const registration = load(file).packets.find((p) => p.command === CMD.REG_EVENT)
      if (!registration) continue // contributed no evidence; see PROVENANCE.md
      expect(registration.data).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  // THE ADJUDICATION (design spec §8.1). The rule was fixed before capture:
  // neither acknowledges -> we do not acknowledge; both do -> we do; they
  // disagree -> follow the specification; one never registers -> it
  // contributed nothing and the other decides, scoped to a single source.
  //
  // What was actually captured: pyzk's `live_capture()` never reaches
  // CMD_REG_EVENT at all, on either transport — both realtime-*-pyzk.json
  // fixtures stop at CMD_EXIT (1001) after CMD_CONNECT (1000) and two
  // further request/reply pairs (commands 50, 62, 60), with pyzk printing
  // "Cant Verify" to stderr before giving up. pyzk therefore contributed no
  // evidence on acknowledgment (spec §8.1's fourth branch): a fixture with no
  // CMD_REG_EVENT is skipped below, not read as agreement.
  //
  // zkteco-js registered on both TCP and UDP (mask "01000000", i.e.
  // EVENT_FLAG.ATTENDANCE) and, after registering, sent exactly one further
  // packet: CMD_EXIT. No CMD_ACK_OK — or anything else — was ever sent back
  // for any of the three events the emulator pushed in the same handler
  // return as the registration ack. zkteco-js is therefore the only oracle
  // that decides this question, and it decides against acknowledging.
  it('records what each oracle sent after registering', () => {
    for (const file of FILES) {
      const { packets } = load(file)
      const at = packets.findIndex((p) => p.command === CMD.REG_EVENT)
      if (at === -1) continue
      const after = packets.slice(at + 1)
      expect(after.map((p) => p.command)).toEqual([CMD.EXIT])
    }
  })
})
