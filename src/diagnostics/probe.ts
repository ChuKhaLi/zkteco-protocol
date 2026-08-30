import { CMD } from '../codec/commands.js'
import { checksum16 } from '../codec/checksum.js'
import { DEVICE_PARAM } from '../codec/params.js'
import { readNulTerminated } from '../codec/records/shared.js'
import { decodeZkTime } from '../codec/time.js'
import { FREE_SIZES_OFFSET } from '../commands/info.js'
import type { Session } from '../session/Session.js'
import type { ZkNaiveTime } from '../types.js'
import type { StepRunner } from './step.js'
import type { TraceEvent } from './types.js'

/** Which CMD_OPTIONS_RRQ request shapes the device accepted. */
export type KeywordFormVerdict = 'both' | 'nul-only' | 'bare-only' | 'neither'

export interface ParameterFinding {
  key: string
  /** The device answered rather than refusing with ACK_ERROR. */
  answered: boolean
  /** It answered with an empty value. Distinct from not answering — item 16. */
  empty: boolean
}

export interface Findings {
  identity: {
    deviceName: string | null
    platform: string | null
    os: string | null
    firmwareVersion: string | null
    /**
     * Presence only, never the value. The serial identifies one unit and no
     * checklist item needs it — item 17 needs only that the key answered.
     */
    serialNumberPresent: boolean
  }
  keywordForm: KeywordFormVerdict | null
  parameters: ParameterFinding[]
  clock: {
    deviceLocal: string
    hostLocal: string
    /**
     * Null when the device's packed timestamp decoded to a day that does not
     * exist on a real calendar (decodeZkTime's pseudo-calendar allows e.g.
     * 2026-02-31). deviceLocal and hostLocal are still recorded verbatim in
     * that case; only the derived skew is withheld, because a Date.parse of
     * an impossible date silently rolls forward and would report a skew of
     * days as though it were a fact.
     */
    skewSeconds: number | null
  } | null
  freeSizes: {
    userCount: number
    recordCount: number
    recordCapacity: number
    /** The whole body. FREE_SIZES_OFFSET is unverified; this is how item 4 gets checked. */
    rawHex: string
  } | null
  checksum: { packetsChecked: number; mismatches: number }
}

export function emptyFindings(): Findings {
  return {
    identity: {
      deviceName: null,
      platform: null,
      os: null,
      firmwareVersion: null,
      serialNumberPresent: false,
    },
    keywordForm: null,
    parameters: [],
    clock: null,
    freeSizes: null,
    checksum: { packetsChecked: 0, mismatches: 0 },
  }
}

/** The keyword used for the A/B. Any exposed key would do; this one is near-universal. */
const AB_KEYWORD = DEVICE_PARAM.SERIAL_NUMBER

const nulTerminated = (keyword: string): Buffer => Buffer.from(`${keyword}\0`, 'latin1')
const bare = (keyword: string): Buffer => Buffer.from(keyword, 'latin1')

/**
 * Did this reply answer the keyword, as opposed to refusing it?
 *
 * Deliberately does NOT reuse decodeParamReply: that throws on an echo
 * mismatch, and here a mismatched echo is an observation to record rather than
 * an error to raise. The test is only "did the device come back with this
 * keyword and an '='".
 */
function answeredKeyword(command: number, body: Buffer, keyword: string): boolean {
  if (command === CMD.ACK_ERROR || command === CMD.ACK_UNAUTH) return false
  return body.toString('latin1').startsWith(`${keyword}=`)
}

/**
 * Resolves first-hardware checklist item 18 — the library's one shipped
 * protocol guess.
 *
 * pyzk sends the CMD_OPTIONS_RRQ keyword NUL-terminated; zkteco-js sends it
 * bare; encodeParamRequest ships pyzk's form because a device tolerating
 * either would accept it. PROVENANCE.md records that superset-ness rests on
 * parser speculation and that the losing case is real. Two round trips settle
 * it.
 *
 * 'neither' is a keyword question, not a shape question — the key may simply
 * be unsupported. The report must say so, or the first real result will be
 * logged as an item-18 answer when it is an item-17 one.
 */
async function requestShapeAb(session: Session, keyword: string): Promise<KeywordFormVerdict> {
  const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(keyword))
  const nulOk = answeredKeyword(withNul.command, withNul.data, keyword)
  const without = await session.tryExecute(CMD.OPTIONS_RRQ, bare(keyword))
  const bareOk = answeredKeyword(without.command, without.data, keyword)
  if (nulOk && bareOk) return 'both'
  if (nulOk) return 'nul-only'
  if (bareOk) return 'bare-only'
  return 'neither'
}

/** Splits a parameter body at the first '=', stopping at the first NUL. */
function paramValue(body: Buffer): string | null {
  const text = readNulTerminated(body, 0, body.length)
  const eq = text.indexOf('=')
  return eq === -1 ? null : text.slice(eq + 1)
}

/**
 * Steps 2 to 4 of the probe: the firmware control read, the request-shape A/B,
 * then a parameter sweep one key at a time.
 *
 * Per key rather than a single getParameters call: that function abandons the
 * remaining reads on a hard failure, which is right for the library and wrong
 * for a diagnostic. One refusal must not end the sweep.
 */
export async function probeIdentity(
  session: Session,
  runner: StepRunner,
  findings: Findings,
): Promise<void> {
  // FIRST, deliberately. CMD_GET_VERSION carries an empty payload and so is
  // untouched by the keyword-shape question below. If it answers and every
  // parameter refuses, that is item 18's signature — which handoff §3.1 warns
  // is otherwise indistinguishable from the answer item 16 exists to collect.
  await runner.run('firmware', async () => {
    const res = await session.tryExecute(CMD.GET_VERSION)
    if (res.command === CMD.ACK_ERROR) return null
    const value = readNulTerminated(res.data, 0, res.data.length)
    findings.identity.firmwareVersion = value
    return value
  })

  await runner.run('keyword-shape-ab', async () => {
    const verdict = await requestShapeAb(session, AB_KEYWORD)
    findings.keywordForm = verdict
    return verdict
  })

  for (const key of Object.values(DEVICE_PARAM)) {
    await runner.run(`param:${key}`, async () => {
      const res = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(key))
      if (!answeredKeyword(res.command, res.data, key)) {
        findings.parameters.push({ key, answered: false, empty: false })
        return null
      }
      const value = paramValue(res.data) ?? ''
      findings.parameters.push({ key, answered: true, empty: value === '' })
      // The serial is recorded as presence only; every other identity field
      // carries its value, because item 7 cannot build a compatibility table
      // without the model, platform, OS and firmware.
      if (key === DEVICE_PARAM.SERIAL_NUMBER) findings.identity.serialNumberPresent = true
      else if (key === DEVICE_PARAM.DEVICE_NAME) findings.identity.deviceName = value
      else if (key === DEVICE_PARAM.PLATFORM) findings.identity.platform = value
      else if (key === DEVICE_PARAM.OS) findings.identity.os = value
      // Never the raw value: StepRunner.run stores whatever is returned here
      // as StepResult.value, which flows into the report independently of
      // `findings`. The sanctioned fields (device name, platform, OS,
      // firmware) already reach the report through findings.identity; nothing
      // needs them here too. Returning the value only for ~SerialNumber would
      // fix today's leak but not tomorrow's — the next sensitive keyword
      // added to DEVICE_PARAM would reopen it. Null, uniformly, closes the
      // whole class.
      return null
    })
  }
}

/**
 * Epoch seconds (UTC) for a decoded device timestamp, or null when the
 * decoded date does not exist on a real calendar.
 *
 * decodeZkTime unpacks through a pseudo-calendar of 31-day months, so it can
 * legitimately hand back e.g. 2026-02-31. Date.UTC does not reject that; it
 * silently rolls the overflow into March. Round-tripping through
 * getUTC{FullYear,Month,Date} and comparing against the decoded components is
 * how that rollover gets caught rather than reported as a skew of days.
 */
function deviceEpochSeconds(t: ZkNaiveTime): number | null {
  const ms = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)
  const rolled = new Date(ms)
  const roundTrips =
    rolled.getUTCFullYear() === t.year &&
    rolled.getUTCMonth() === t.month - 1 &&
    rolled.getUTCDate() === t.day
  return roundTrips ? Math.round(ms / 1000) : null
}

const REQUIRED_FREE_SIZES = FREE_SIZES_OFFSET.recordCapacity + 4

/**
 * Recomputes each captured packet's checksum and compares it to the one on the
 * wire — first-hardware checklist item 2, for the part a tool can do alone.
 *
 * The checksum field itself is zeroed before recomputing. checksum16's own
 * loop already skips that word (see its "treated as zero" comment), so this
 * is currently a no-op verified by deliberately breaking it and watching the
 * "good packet" test stay green either way — but it costs one Buffer.from and
 * makes this call site correct on its own terms rather than by relying on an
 * implementation detail of checksum16 that could change.
 *
 * A payload too short to hold a header is skipped rather than counted. It is
 * still in the raw capture; counting it as a mismatch would inflate the only
 * number a reader uses to judge whether §5's formulation survives contact.
 */
export function auditChecksums(
  events: readonly TraceEvent[],
): { packetsChecked: number; mismatches: number } {
  let packetsChecked = 0
  let mismatches = 0
  for (const event of events) {
    if (!event.hex) continue
    const buf = Buffer.from(event.hex, 'hex')
    if (buf.length < 8) continue
    const transmitted = buf.readUInt16LE(2)
    const zeroed = Buffer.from(buf)
    zeroed.writeUInt16LE(0, 2)
    packetsChecked += 1
    if (checksum16(zeroed) !== transmitted) mismatches += 1
  }
  return { packetsChecked, mismatches }
}

/**
 * Steps 5 and 6 of the probe: the device clock, then its storage counters.
 *
 * `hostNowSeconds` is passed in rather than read here. Clock access lives only
 * in src/cli.ts, which is what keeps every test above deterministic.
 */
export async function probeState(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  hostNowSeconds: number,
): Promise<void> {
  await runner.run('clock', async () => {
    const res = await session.tryExecute(CMD.GET_TIME)
    if (res.command === CMD.ACK_ERROR || res.data.length < 4) return null
    const device = decodeZkTime(res.data.readUInt32LE(0))
    const hostLocal = new Date(hostNowSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const deviceEpoch = deviceEpochSeconds(device)
    // Recorded side by side and NOT judged. Device clocks drift and reset; the
    // library returns readings verbatim (v0.1 §3) and so does this. Whether a
    // skew is a problem is a human's call with the specs open.
    findings.clock = {
      deviceLocal: device.local,
      hostLocal,
      skewSeconds: deviceEpoch === null ? null : deviceEpoch - hostNowSeconds,
    }
    return findings.clock
  })

  await runner.run('free-sizes', async () => {
    const res = await session.tryExecute(CMD.GET_FREE_SIZES)
    if (res.command === CMD.ACK_ERROR || res.data.length < REQUIRED_FREE_SIZES) return null
    findings.freeSizes = {
      userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
      recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
      recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
      rawHex: res.data.toString('hex'),
    }
    return findings.freeSizes
  })
}
