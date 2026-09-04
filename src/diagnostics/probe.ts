import { CMD } from '../codec/commands.js'
import { checksum16 } from '../codec/checksum.js'
import { EVENT_FLAG, isEventPacket, readEventType } from '../codec/events.js'
import { decodePayload } from '../codec/packet.js'
import { DEVICE_PARAM } from '../codec/params.js'
import { readNulTerminated } from '../codec/records/shared.js'
import { decodeZkTime } from '../codec/time.js'
import { FREE_SIZES_OFFSET } from '../commands/info.js'
import { getUsers } from '../commands/users.js'
import { getAttendanceLogs } from '../commands/attendance.js'
import { ZkProtocolError } from '../errors.js'
import { Session } from '../session/Session.js'
import { TcpTransport } from '../transport/tcp.js'
import { UdpTransport } from '../transport/udp.js'
import type { ZkNaiveTime, ZkUser } from '../types.js'
import { declined, refused, replyOutcome, type StepRunner } from './step.js'
import type { TraceEvent } from './types.js'

/** Which CMD_OPTIONS_RRQ request shapes the device accepted. */
export type KeywordFormVerdict = 'both' | 'nul-only' | 'bare-only' | 'neither'

export interface ParameterFinding {
  key: string
  /**
   * What the device did with this keyword.
   *
   * 'mismatched-echo' is its own outcome because item 15 asks whether the
   * device echoes the keyword it was asked for. Collapsing it into "not
   * answered" made a device that answers without echoing indistinguishable
   * from one that refuses — on the row whose whole subject is the difference.
   * ACK_UNAUTH is not here: the step records it as `unauthorized` and the key
   * stays out of this array, so `parameterSummary`'s "tried" count comes from
   * the steps.
   */
  outcome: 'answered' | 'refused' | 'mismatched-echo'
  /** It answered with an empty value. Distinct from not answering — item 16. */
  empty: boolean
}

/**
 * Strips control characters from a string the DEVICE chose.
 *
 * Device name, platform, OS and firmware are latin1-decoded device bytes that
 * stop only at NUL, so a name carrying a newline and pipes inserts a fabricated
 * row into the checklist table of a report meant to be pasted into a public
 * issue. Redaction and sanitisation both happen where the value is produced,
 * so every renderer can trust `Findings` (CLAUDE.md).
 *
 * C0 (0x00-0x1F), DEL and C1 (0x7F-0x9F) become U+FFFD. Everything at 0xA0 and
 * above is KEPT: item 7 needs the model name as the device spells it, and item
 * 20's evidence is exactly those high bytes.
 */
export function sanitizeDeviceString(value: string): string {
  return value.replaceAll(/[\x00-\x1f\x7f-\x9f]/g, '�')
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
    /** The host's naive LOCAL wall-clock time, formatted exactly as deviceLocal. */
    hostLocal: string
    /** The host's UTC offset when it read its clock, so a reader can separate zone from drift. */
    hostUtcOffsetMinutes: number
    /**
     * Device naive time minus host naive local time, in seconds. Null when the
     * device's packed timestamp decoded to a day that does not exist on a real
     * calendar (decodeZkTime's pseudo-calendar allows e.g. 2026-02-31);
     * deviceLocal and hostLocal are still recorded verbatim in that case.
     */
    skewSeconds: number | null
  } | null
  freeSizes: {
    userCount: number
    recordCount: number
    recordCapacity: number
    /**
     * The head of the body, capped at `FREE_SIZES_RAW_MAX_BYTES`.
     *
     * FREE_SIZES_OFFSET is unverified, so item 4 needs real bytes to check the
     * offsets against — spec §4.5 names this reply's raw body as its evidence.
     * It is also the ONE verbatim device payload in the always-written JSON
     * sidecar, which is why it is bounded rather than "whatever arrived": no
     * real device has been observed, so nobody knows how long this reply is,
     * and F5's ruling (any payload can carry identifying data) applies here
     * exactly as it did to `StepResult.raw`. The cap is generous against the
     * 68 bytes the offsets actually need. The unbounded bytes live in the
     * opt-in raw capture, where they belong.
     */
    rawHex: string
  } | null
  /**
   * Locally recomputed checksums, split by who sent the packet.
   *
   * Only `received` is evidence about the device. A `sent` payload was built
   * by `checksum16` moments earlier, so recomputing it is guaranteed to agree
   * — counting the two together inflated the one number a reader uses to
   * judge whether §5's formulation survives contact with hardware, by roughly
   * a factor of two, with this tool agreeing with itself. `sent` is kept as
   * the positive control it accidentally is: a nonzero mismatch there means
   * this tool is broken, not the device.
   */
  checksum: {
    received: { packetsChecked: number; mismatches: number }
    sent: { packetsChecked: number; mismatches: number }
  }
  /**
   * The other half of item 2, and of spec §5.1's "checksum AND reply-id
   * verdicts": how many device replies echoed the reply id of the request
   * they answered.
   *
   * Recorded as counts rather than a pass/fail, because whether a device
   * echoes is the quirk item 2 exists to discover. A device that does not
   * echo is data, not a failure.
   */
  replyIds: { repliesChecked: number; echoedRequestId: number }
  /**
   * The third part of item 2: was the comm-key mixing exercised at all, and
   * did the device accept it?
   *
   * Three states a reader has to be able to tell apart, which is why this is
   * not one boolean. `configured` comes from argv; the other two come from the
   * trace, and they are NOT interchangeable with it. `Session.open` sends
   * CMD_AUTH only when the device answers CONNECT with ACK_UNAUTH, so a run
   * given --comm-key against a device that never demands one exercises
   * `mixCommKey` zero times. Reading the flag as the verdict would report an
   * audit that never ran -- this project's recurring defect shape, in the row
   * whose whole subject is what the evidence supports.
   *
   * Booleans only. The key itself never enters `Findings`, per the uniform
   * redaction rule: the report is meant to be pasted into a public issue.
   */
  commKey: { configured: boolean; authSent: boolean; authAccepted: boolean | null }
  bulkPath: 'buffered' | 'legacy' | null
  /**
   * Did CMD_PREPARE_BUFFER's 11-byte (odd-length) request reach the wire?
   *
   * Item 19's real question. `bulkPath` cannot stand in for it: readBulk
   * always attempts the buffered path first, so the odd-length payload is sent
   * on BOTH branches, and `bulkPath` stays null whenever the read fails after
   * that send — leaving item 19 reporting "not answered" about a payload the
   * device had already seen.
   */
  bulkPrepareAttempted: boolean
  attendance: {
    read: boolean
    skippedReason: string | null
    detectedRecordSize: number | null
    rowCount: number
  } | null
  encoding: { namesInspected: number; withHighBytes: number; validUtf8: boolean | null } | null
  concurrent: { attempted: boolean; accepted: boolean; error: string | null } | null
  realtime: {
    windowSeconds: number
    /** CMD_REG_EVENT was acknowledged. */
    registered: boolean
    /** The window elapsed with the subscription still alive. */
    heldOpen: boolean
    /** How long the window actually lasted, by the injected clock. */
    endedAfterMs: number
    eventsObserved: number
    /**
     * Packets pushed on the listening connection that were not events.
     * Counted apart because item 13 asks whether a device interleaves a
     * request-response packet into a subscription — and because counting them
     * as events reported a stray acknowledgment as an event type.
     */
    nonEventPackets: number
    eventTypes: number[]
    desyncOnRegister: boolean
    error: string | null
  } | null
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
    checksum: {
      received: { packetsChecked: 0, mismatches: 0 },
      sent: { packetsChecked: 0, mismatches: 0 },
    },
    replyIds: { repliesChecked: 0, echoedRequestId: 0 },
    commKey: { configured: false, authSent: false, authAccepted: null },
    bulkPath: null,
    bulkPrepareAttempted: false,
    attendance: null,
    encoding: null,
    concurrent: null,
    realtime: null,
  }
}

/** The keyword used for the A/B. Any exposed key would do; this one is near-universal. */
const AB_KEYWORD = DEVICE_PARAM.SERIAL_NUMBER

const nulTerminated = (keyword: string): Buffer => Buffer.from(`${keyword}\0`, 'latin1')
const bare = (keyword: string): Buffer => Buffer.from(keyword, 'latin1')

/** Did the reply echo this keyword back with an '='? Item 15's test, and only that. */
function answeredKeyword(body: Buffer, keyword: string): boolean {
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
  const nulOk = replyOutcome(withNul.command) === null && answeredKeyword(withNul.data, keyword)
  const without = await session.tryExecute(CMD.OPTIONS_RRQ, bare(keyword))
  const bareOk = replyOutcome(without.command) === null && answeredKeyword(without.data, keyword)
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
    // Must be checked before the decode below: this is the read in the
    // library with no other validation of any kind (no echo, no length
    // check), so an ACK_ERROR or ACK_UNAUTH reply is the case with nothing
    // else to catch it — readNulTerminated would otherwise decode its
    // (usually empty) body as if it were a genuine firmware string,
    // indistinguishable from a device that truly answered with no value.
    // Mirrors src/commands/device.ts's readFirmware() exactly.
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    const value = sanitizeDeviceString(readNulTerminated(res.data, 0, res.data.length))
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
      const outcome = replyOutcome(res.command)
      if (outcome === 'unauthorized') return declined('unauthorized', null)
      if (outcome === 'refused') {
        findings.parameters.push({ key, outcome: 'refused', empty: false })
        return declined('refused', null)
      }
      if (!answeredKeyword(res.data, key)) {
        // The device answered — it simply did not echo the keyword. Item 15's
        // whole question. The step stays 'ok' because a reply arrived.
        findings.parameters.push({ key, outcome: 'mismatched-echo', empty: false })
        return null
      }
      const value = sanitizeDeviceString(paramValue(res.data) ?? '')
      findings.parameters.push({ key, outcome: 'answered', empty: value === '' })
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
 * How much of the CMD_GET_FREE_SIZES body `Findings` keeps.
 *
 * Item 4 checks FREE_SIZES_OFFSET against a real reply, and the highest offset
 * it names ends at byte 68 — so 128 bytes is generous room to see the fields
 * around it, and still a bound. See `Findings.freeSizes.rawHex` for why a
 * bound is required at all.
 */
export const FREE_SIZES_RAW_MAX_BYTES = 128

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
export function auditChecksums(events: readonly TraceEvent[]): Findings['checksum'] {
  const received = { packetsChecked: 0, mismatches: 0 }
  const sent = { packetsChecked: 0, mismatches: 0 }
  for (const event of events) {
    if (!event.hex) continue
    const buf = Buffer.from(event.hex, 'hex')
    if (buf.length < 8) continue
    const transmitted = buf.readUInt16LE(2)
    const zeroed = Buffer.from(buf)
    zeroed.writeUInt16LE(0, 2)
    // 'push' is the device too -- an unsolicited realtime event is as much a
    // device packet as a reply. Only 'send' is ours.
    const into = event.direction === 'send' ? sent : received
    into.packetsChecked += 1
    if (checksum16(zeroed) !== transmitted) into.mismatches += 1
  }
  return { received, sent }
}

/**
 * The reply-id half of first-hardware checklist item 2, and of spec §5.1's
 * content list.
 *
 * `Session` increments a counter per request and transmits the packet exactly
 * as encoded (no reply-id quirk applied — see `Session.send`'s doc comment and
 * the oracle evidence behind it). Whether a device echoes that id back on the
 * reply is therefore observable, and it is the quirk item 2 names. This counts
 * it rather than judging it: a device that does not echo is a finding about
 * that firmware, not a failure of anything here.
 *
 * A reply is compared against the most recent request that preceded it, which
 * is exactly the pairing this library's request/response loop enforces. A
 * 'push' event has no request to pair with — an unsolicited realtime event
 * answers nothing — so it is skipped rather than compared against whatever
 * request happened to come last.
 */
export function auditReplyIds(events: readonly TraceEvent[]): Findings['replyIds'] {
  let repliesChecked = 0
  let echoedRequestId = 0
  let lastRequestId: number | undefined
  for (const event of events) {
    if (event.direction === 'send') {
      lastRequestId = event.replyId
      continue
    }
    if (event.direction !== 'recv' || event.replyId === undefined) continue
    if (lastRequestId === undefined) continue
    repliesChecked += 1
    if (event.replyId === lastRequestId) echoedRequestId += 1
  }
  return { repliesChecked, echoedRequestId }
}

/**
 * The third part of item 2, read from the wire rather than from argv.
 *
 * `configured` is the one thing the trace cannot show: no CMD_AUTH on the wire
 * is produced both by a run with no key and by a run whose key the device
 * never asked for, and those are different answers for a reader deciding
 * whether §5's mixing has been checked against this firmware.
 *
 * The reply taken is the first `recv` after the CMD_AUTH, which is the pairing
 * `Session.open` enforces -- it awaits exactly one reply there. A CMD_AUTH with
 * no reply at all reports `authAccepted: false`: the device did not accept it,
 * and defaulting an absence to the flattering answer is how item 12 came to
 * report 'answered' for a primitive this library does not have.
 */
export function auditCommKey(
  events: readonly TraceEvent[],
  configured: boolean,
): Findings['commKey'] {
  const sentAt = events.findIndex((e) => e.direction === 'send' && e.command === CMD.AUTH)
  if (sentAt === -1) return { configured, authSent: false, authAccepted: null }
  const reply = events.slice(sentAt + 1).find((e) => e.direction === 'recv')
  return { configured, authSent: true, authAccepted: reply?.command === CMD.ACK_OK }
}

/** The host clock as the CLI read it: the only module allowed to read one. */
export interface HostClock {
  epochSeconds: number
  /** `-new Date().getTimezoneOffset()` — positive east of UTC. */
  utcOffsetMinutes: number
}

/** The host's naive local time, formatted like decodeZkTime's `local` (a `T` separator). */
function hostLocalString(host: HostClock): string {
  return new Date((host.epochSeconds + host.utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 19)
}

/**
 * Steps 5 and 6 of the probe: the device clock, then its storage counters.
 *
 * `host` is passed in rather than read here. Clock access lives only in
 * src/cli.ts, which is what keeps every test above deterministic.
 */
export async function probeState(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  host: HostClock,
): Promise<void> {
  await runner.run('clock', async () => {
    const res = await session.tryExecute(CMD.GET_TIME)
    // Checked BEFORE the length: an ACK_UNAUTH carrying four bytes is not a
    // clock, and decoding it as one answered item 21 from a reply that
    // acknowledged nothing.
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    if (res.data.length < 4) throw new ZkProtocolError(`CMD_GET_TIME answered with ${res.data.length} byte(s), not a packed time`)
    const device = decodeZkTime(res.data.readUInt32LE(0))
    // Naive against naive. The device stores wall-clock time with no zone
    // (ZkNaiveTime), so the only like-for-like comparison is the host's own
    // wall clock; the host's UTC offset is recorded so a reader can tell a
    // zone difference from drift. Recorded side by side and NOT judged.
    const hostLocal = hostLocalString(host)
    const deviceEpoch = deviceEpochSeconds(device)
    findings.clock = {
      deviceLocal: device.local,
      hostLocal,
      hostUtcOffsetMinutes: host.utcOffsetMinutes,
      skewSeconds: deviceEpoch === null ? null : deviceEpoch - (host.epochSeconds + host.utcOffsetMinutes * 60),
    }
    return findings.clock
  })

  await runner.run('free-sizes', async () => {
    const res = await session.tryExecute(CMD.GET_FREE_SIZES)
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    if (res.data.length < REQUIRED_FREE_SIZES) {
      throw new ZkProtocolError(`CMD_GET_FREE_SIZES answered with ${res.data.length} byte(s); ${REQUIRED_FREE_SIZES} are needed for the offsets`)
    }
    findings.freeSizes = {
      userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
      recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
      recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
      rawHex: res.data.subarray(0, FREE_SIZES_RAW_MAX_BYTES).toString('hex'),
    }
    return findings.freeSizes
  })
}

/**
 * Read the attendance log automatically below this many records.
 *
 * A guess about politeness and nothing more. The protocol has no "read N
 * records" — the device returns its whole buffer — so on a large terminal this
 * is slow and keeps the device busy while people are badging at it. No device
 * has been observed, so no count is KNOWN to be slow. The first real device
 * should be treated as evidence about this number (design spec §8, risk 3).
 */
export const ATTENDANCE_AUTO_THRESHOLD = 10_000

/**
 * Answers first-hardware checklist item 20 without ever shipping a name.
 *
 * The discriminating signal is structural, not semantic: UTF-8 has a strict
 * continuation-byte grammar and GB2312 does not. So the bytes are tested and a
 * verdict is returned; the names never leave this function.
 *
 * Names arrive decoded as latin1, which is byte-preserving, so re-encoding to
 * latin1 recovers exactly what the device sent. Under the `ascii` decoding
 * this library used before v0.3 the high bit was already gone and this
 * question could not have been asked at all.
 *
 * `validUtf8` is null when nothing carried a high byte — that is "no evidence
 * either way", which is a different answer from "not UTF-8" and must not be
 * collapsed into it.
 */
export function encodingVerdict(
  names: readonly string[],
): { namesInspected: number; withHighBytes: number; validUtf8: boolean | null } {
  const high = names.filter((n) => [...n].some((c) => c.charCodeAt(0) >= 0x80))
  if (high.length === 0) {
    return { namesInspected: names.length, withHighBytes: 0, validUtf8: null }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const allValid = high.every((n) => {
    try {
      decoder.decode(Buffer.from(n, 'latin1'))
      return true
    } catch {
      return false
    }
  })
  return { namesInspected: names.length, withHighBytes: high.length, validUtf8: allValid }
}

/**
 * Infers which bulk-read path answered the user list, from the wire trace.
 *
 * `readBulk` dispatches through the library's own PREPARE_BUFFER/READ_BUFFER
 * commands and falls back to the legacy exchange transparently when the
 * device refuses them — it gives its caller no signal of its own about which
 * path actually delivered the data. This reconstructs that from what went
 * out on the wire, using the same direct-versus-wrapped distinction
 * `probeBulk`'s own attendance-guard tests use to check a request reached (or
 * didn't reach) the socket.
 *
 * A direct send of CMD_USERTEMP_RRQ is checked FIRST and unconditionally,
 * because it is decisive proof the legacy exchange ran — and it is the ONLY
 * shape that can appear as a fallback after an earlier, failed buffered
 * attempt. "First match in trace order" would get this backwards: a refused
 * PREPARE_BUFFER send is still recorded before the legacy fallback that
 * follows it, so scanning forward and stopping at the first recognised shape
 * would report 'buffered' for a read that buffered never actually served.
 * Only once no legacy send is found does a PREPARE_BUFFER send wrapping
 * CMD_USERTEMP_RRQ count as buffered.
 *
 * Neither shape recognised (e.g. no trace was supplied) is null — honest
 * beats confidently wrong, the same principle `encodingVerdict` applies to
 * an all-ASCII name list.
 */
export function inferBulkPath(events: readonly TraceEvent[]): 'buffered' | 'legacy' | null {
  const sent = events.filter((e) => e.direction === 'send' && e.command !== undefined)
  if (sent.some((e) => e.command === CMD.USERTEMP_RRQ)) return 'legacy'

  const wrapsUserList = (e: TraceEvent): boolean => {
    if (e.command !== CMD.PREPARE_BUFFER || !e.hex) return false
    // <int8 1><int16 command><int32 fct><int32 ext> -- the target command is
    // the uint16 at offset 1 of the request body, same layout readBulkBuffered
    // writes it in.
    const { data } = decodePayload(Buffer.from(e.hex, 'hex'))
    return data.length >= 3 && data.readUInt16LE(1) === CMD.USERTEMP_RRQ
  }
  if (sent.some(wrapsUserList)) return 'buffered'

  return null
}

/**
 * Was CMD_PREPARE_BUFFER's odd-length request put on the wire at all?
 *
 * Separate from `inferBulkPath` on purpose. That function answers "which path
 * SERVED the read", which is a question about the outcome; this one answers
 * "was the 11-byte payload SENT", which is a question about the attempt — and
 * item 19 asks the second. The send happens on both branches (readBulk always
 * tries buffered first, TCP and UDP alike), including the branch where the
 * read then fails and `inferBulkPath` has to return null.
 */
export function sentPrepareBuffer(events: readonly TraceEvent[]): boolean {
  return events.some((e) => e.direction === 'send' && e.command === CMD.PREPARE_BUFFER)
}

/**
 * Did a request for the attendance log leave the socket?
 *
 * `getAttendanceLogs` returns an empty list WITHOUT issuing a read when the
 * device reports zero records (`src/commands/attendance.ts`), so "the call
 * returned" is not evidence that anything was asked. Item 1's question has two
 * halves — a full handshake AND one attendance read — and this is the half a
 * returned value cannot supply. Recognises both shapes the read can take: the
 * legacy `CMD_ATTLOG_RRQ`, and the buffered `CMD_PREPARE_BUFFER` whose body
 * carries the target command as a uint16 at offset 1.
 */
export function attendanceRequested(events: readonly TraceEvent[]): boolean {
  return events.some((e) => {
    if (e.direction !== 'send') return false
    if (e.command === CMD.ATTLOG_RRQ) return true
    if (e.command !== CMD.PREPARE_BUFFER || !e.hex) return false
    const { data } = decodePayload(Buffer.from(e.hex, 'hex'))
    return data.length >= 3 && data.readUInt16LE(1) === CMD.ATTLOG_RRQ
  })
}

/**
 * Step 7 of the probe: the user list, then the attendance log.
 *
 * Which bulk path the firmware took for the user read is recorded because it
 * answers whether 1503/1504 are implemented, and — since v0.3.1 — checklist
 * item 23 as well. It is inferred from the wire trace the caller supplies —
 * see `inferBulkPath`.
 */
export async function probeBulk(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  opts: { transport: 'tcp' | 'udp'; attendance: 'auto' | 'always' | 'never' },
  events: readonly TraceEvent[],
): Promise<void> {
  // The list is captured in this closure variable rather than returned from
  // the step, deliberately. StepRunner.run stores whatever the callback
  // returns as StepResult.value, which flows into the report independently
  // of `findings` -- the same shape the parameter sweep above guards against
  // for the device serial number, and names and user ids are exactly the
  // sensitive payload that rule exists to keep out. Only a count leaves the
  // callback.
  let users: ZkUser[] | undefined
  await runner.run('users', async () => {
    users = await getUsers(session, opts.transport)
    return { count: users.length }
  })
  // Recorded UNCONDITIONALLY, unlike bulkPath: item 19 asks whether the device
  // was ever sent an odd-length payload, and it was, whether or not the read
  // that followed came back.
  findings.bulkPrepareAttempted = sentPrepareBuffer(events)
  if (users) {
    findings.encoding = encodingVerdict(users.map((u) => u.name))
    findings.bulkPath = inferBulkPath(events)
  }

  const recordCount = findings.freeSizes?.recordCount ?? 0
  const shouldRead =
    opts.attendance === 'always' ||
    (opts.attendance === 'auto' && recordCount <= ATTENDANCE_AUTO_THRESHOLD)

  if (!shouldRead) {
    // Reported as a skip, naming the count and the override. Omitting it
    // silently would be the "reports success while proving less than it
    // appears to" shape this project keeps catching.
    findings.attendance = {
      read: false,
      skippedReason:
        opts.attendance === 'never'
          ? 'skipped: --attendance=never'
          : `skipped: ${recordCount} records exceeds the ${ATTENDANCE_AUTO_THRESHOLD} auto threshold; pass --attendance=always to read anyway`,
      detectedRecordSize: null,
      rowCount: 0,
    }
    return
  }

  await runner.run('attendance', async () => {
    const before = events.length
    const logs = await getAttendanceLogs(session, opts.transport, { resolveUserIds: false })
    // Counts and shapes only. Never a row: those are movement records for
    // named people, and no checklist item needs their contents.
    findings.attendance = attendanceRequested(events.slice(before))
      ? {
          read: true,
          skippedReason: null,
          detectedRecordSize: logs[0]?.recordSize ?? null,
          rowCount: logs.length,
        }
      : {
          read: false,
          skippedReason: 'the device reported 0 records; no read was issued',
          detectedRecordSize: null,
          rowCount: 0,
        }
    return findings.attendance
  })
}

/**
 * Checklist item 10: does the device accept a second concurrent connection?
 *
 * This decides whether a consumer can poll and subscribe at the same time
 * (v0.2 §3.1), which is why ZkDevice makes opening a second connection a
 * visible decision rather than an assumption.
 *
 * Runs on its OWN socket and never touches the caller's session, so a refusal
 * here says nothing about the session the rest of the probe is using — which
 * is why a failure records `accepted: false` instead of truncating the run.
 * Both outcomes answer the item.
 */
export async function probeConcurrent(
  runner: StepRunner,
  findings: Findings,
  opts: { host: string; port: number; transport: 'tcp' | 'udp'; timeoutMs: number },
): Promise<void> {
  await runner.run('second-connection', async () => {
    const transport =
      opts.transport === 'tcp'
        ? new TcpTransport({ host: opts.host, port: opts.port })
        : new UdpTransport({ host: opts.host, port: opts.port })
    const second = new Session(transport, { timeoutMs: opts.timeoutMs })
    try {
      await second.open()
      findings.concurrent = { attempted: true, accepted: true, error: null }
      await second.close().catch(() => {})
      return findings.concurrent
    } catch (err) {
      findings.concurrent = {
        attempted: true,
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      }
      // Ruling R7's argument applies here too: the device (or the network)
      // declined a second connection, which is the checklist item's answer,
      // not a failure of this probe. 'ok' would conflate the two.
      return refused(findings.concurrent)
    }
  })
}

/**
 * Checklist items 8, 9, 12, 13 and 14: what a live subscription actually does.
 *
 * MUST BE LAST. Transport.listen is one-way, once per socket (v0.2 §3.1), so
 * after this the session can never answer a request again. Nothing may follow
 * it, and the CLI runs it only when --realtime is passed.
 *
 * Only event TYPES and a count are recorded. An event payload is a punch by a
 * named person, and no checklist item needs its contents.
 *
 * A desync — the device pushing an event before acknowledging CMD_REG_EVENT —
 * is item 14, and Session.subscribe tears the session down when it happens.
 * That is designed behaviour rather than a bug, so it is recorded as an
 * observation rather than propagated as a failure. If a real terminal does it
 * routinely rather than rarely, v0.2 §3.1's trade-off is worth revisiting with
 * the count this field provides.
 */
export async function probeRealtime(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  opts: { windowSeconds: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
  await runner.run('realtime', async () => {
    const types = new Set<number>()
    let observed = 0
    let strays = 0
    findings.realtime = {
      windowSeconds: opts.windowSeconds,
      registered: false,
      heldOpen: false,
      endedAfterMs: 0,
      eventsObserved: 0,
      nonEventPackets: 0,
      eventTypes: [],
      desyncOnRegister: false,
      error: null,
    }
    // The subscription's own failure, if it has one. A no-op error handler
    // meant a connection that died one second into a sixty-second window was
    // reported as held open for sixty.
    let markFailed: (err: Error) => void = () => {}
    const died = new Promise<Error>((resolve) => { markFailed = resolve })
    try {
      await session.subscribe(
        EVENT_FLAG.ATTENDANCE,
        (pkt) => {
          if (isEventPacket(pkt)) {
            observed += 1
            // The event type occupies the session-id slot (v0.2 §5.1) — itself
            // a checklist item, which is why the raw type is recorded.
            types.add(readEventType(pkt))
          } else {
            strays += 1
          }
        },
        (err) => markFailed(err),
      )
      findings.realtime.registered = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      findings.realtime.error = message
      findings.realtime.desyncOnRegister = /out of step/.test(message)
      // A refused registration or a desync is the device declining, which is
      // the data the checklist items want — not this probe failing.
      return declined('refused', findings.realtime)
    }

    const startedAt = opts.now()
    const ended = await Promise.race([
      opts.sleep(opts.windowSeconds * 1000).then(() => null),
      died.then((err) => err),
    ])
    findings.realtime.endedAfterMs = opts.now() - startedAt
    findings.realtime.heldOpen = ended === null
    if (ended !== null) findings.realtime.error = ended.message
    findings.realtime.eventsObserved = observed
    findings.realtime.nonEventPackets = strays
    findings.realtime.eventTypes = [...types].sort((a, b) => a - b)
    // The step stays 'ok': the probe registered and produced its observation.
    // WHAT it observed — held open, or dropped after endedAfterMs — is the
    // finding, and items 9 and 13 read it from there.
    return findings.realtime
  })
}
