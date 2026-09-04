import { FREE_SIZES_RAW_MAX_BYTES } from './probe.js'
import type { Findings, KeywordFormVerdict } from './probe.js'
import type { StepResult, TraceEvent } from './types.js'

/**
 * The complete result of one probe run, and the sole input to every renderer
 * in this file. The CLI (Task 8) is the only place that constructs one — it
 * owns the clock, the filesystem and `process.argv`, none of which belong
 * here (see the "no clock reads" constraint on every function below).
 */
export interface ProbeResult {
  libraryVersion: string
  host: string
  transport: 'tcp' | 'udp'
  startedAt: string
  durationMs: number
  truncated: { after: string; reason: string } | null
  /**
   * Where this run is writing its raw capture, or null when `--raw-capture`
   * was not passed.
   *
   * Checklist item 1 is answered by that file and by nothing else (design spec
   * §4.5), and `steps` cannot stand in for it: a default run traces every byte
   * in memory and then drops it when the process exits. Only the CLI knows
   * whether a capture was asked for, so only the CLI can fill this in — which
   * costs the purity boundary nothing, since it already owns every path.
   */
  rawCapture: string | null
  steps: readonly StepResult[]
  findings: Findings
}

/**
 * The four states a first-hardware checklist item can be reported in.
 *
 * 'not requested' is not a synonym for 'not answered'. The device declining
 * to answer and the operator never asking are different claims, and
 * collapsing them would make a default (unattended) run look like it probed
 * six items it never touched (design spec §4.5, items 8-10 and 12-14).
 */
type ChecklistState = 'answered' | 'not answered' | 'not testable by this tool' | 'not requested'

interface ChecklistRow {
  item: number
  question: string
  state: ChecklistState
  observation: string
}

/**
 * Expands a keyword-shape verdict into its consequence for the library,
 * rather than leaving a reader to work out what 'bare-only' implies. The text
 * is pinned exactly as given in the task brief.
 */
const KEYWORD_FORM_NOTE: Record<KeywordFormVerdict, string> = {
  both: 'Device tolerates either request shape. The assumption encodeParamRequest rests on is confirmed.',
  'nul-only': 'Device requires the trailing NUL. encodeParamRequest is correct and item 18 is settled.',
  'bare-only':
    'Device REFUSES the trailing NUL. encodeParamRequest is wrong: send the bare keyword. One line in src/codec/params.ts plus two dependent test edits.',
  neither:
    'The keyword was refused in BOTH shapes, so this is a keyword question (item 17), not a shape question. Re-run the A/B against a keyword this firmware exposes before recording any item-18 answer.',
}

/** `answered` when the evidence is there, `not answered` when it is not. */
function answeredIf(ok: boolean): ChecklistState {
  return ok ? 'answered' : 'not answered'
}

/**
 * The message behind a failure the producer always records.
 *
 * Unreachable through `probeRealtime` and `probeConcurrent` — both set `error`
 * on every path that clears the flag beside it — and present only because the
 * field's type allows null. One named helper rather than three inline
 * `(no message)` strings, so a reader meets it once.
 */
function reason(message: string | null): string {
  return message ?? 'no message was recorded'
}

/** 'not requested' when the probe never ran, otherwise `ok`'s verdict. */
function realtimeState(f: Findings, ok: (r: NonNullable<Findings['realtime']>) => boolean): ChecklistState {
  if (f.realtime === null) return 'not requested'
  return answeredIf(ok(f.realtime))
}

const REALTIME_NOT_REQUESTED = 'the realtime probe was not requested (pass --realtime=<seconds> to run it).'

/**
 * Item 8: does the device require an acknowledgment for each realtime event?
 *
 * Always 'not testable by this tool', like items 12 and 22. This library never
 * sends one — `ackEvent` (src/codec/events.ts) is implemented, tested, and
 * called from nowhere, by the v0.2 design's ruling — so no run of this probe
 * can distinguish a device that requires an acknowledgment from one that does
 * not. A completed window used to read 'answered' here, which was the window's
 * evidence borrowed for a question it cannot address. The symptom is named
 * instead, because a reader with hardware in front of them can recognise it.
 */
function item8Observation(f: Findings): string {
  const r = f.realtime
  const symptom =
    'if a terminal delivers one event and then goes silent, that is the symptom of a device waiting for one — record it by hand.'
  if (r === null) return `this library never acknowledges an event, so this cannot be answered here; ${symptom} The realtime probe was not requested on this run.`
  // A refused registration gets its own sentence. "None was sent for any of
  // the 0 event(s) observed, so a device that requires one would look exactly
  // like a quiet device" describes a window that was held open; there was no
  // quiet device here to be mistaken for, because there was no window.
  if (!r.registered) return `this library never acknowledges an event, and this run never reached the point of needing to: the subscription did not complete (${reason(r.error)}). ${symptom}`
  return `this library never acknowledges an event: none was sent for any of the ${r.eventsObserved} event(s) observed, so a device that requires one would look exactly like a quiet device. ${symptom}`
}

/** Item 9: does a subscription survive an idle period, or does the device drop it? */
function item9Observation(f: Findings): string {
  const r = f.realtime
  if (r === null) return REALTIME_NOT_REQUESTED
  if (!r.registered) return `the subscription did not complete: ${reason(r.error)}.`
  return r.heldOpen
    ? `registered and still alive when the ${r.windowSeconds}s window ended.`
    : `registered, then the device dropped it after ${r.endedAfterMs}ms of a ${r.windowSeconds}s window: ${reason(r.error)}. A drop answers this item as decisively as surviving does.`
}

/**
 * Item 13: event types outside the mask, or a request-response packet
 * interleaved into a listening connection.
 *
 * Two questions in one row, and either one alone answers it — which is why the
 * state reads `eventsObserved > 0 || nonEventPackets > 0` rather than the event
 * count alone. `nonEventPackets` exists for the second half (spec §4.4: "item
 * 13 asks whether a device interleaves a request-response packet into a
 * subscription"), so a window that saw no event and two stray packets observed
 * the interleave ON THE WIRE. Gating on events alone printed 'not answered'
 * over a fact the trace holds — the same defect as answering item 9 only when
 * a subscription survived, when a drop answers it just as decisively.
 *
 * The prose says WHICH half was answered, because a row reading 'answered'
 * beside a sentence beginning "nothing can be said" tells a reader nothing.
 *
 * The state also carries `registered`, symmetrically with item 9, though no
 * producer can reach it today: `probeRealtime` sets both counters only after
 * registration succeeds, so an unregistered run has them at 0. It is defence,
 * not a live fix — a future producer that counted strays arriving BEFORE the
 * CMD_REG_EVENT ack would otherwise print 'answered' beside this function's
 * "the subscription did not complete".
 */
function item13Observation(f: Findings): string {
  const r = f.realtime
  if (r === null) return REALTIME_NOT_REQUESTED
  if (!r.registered) return `the subscription did not complete: ${reason(r.error)}.`
  const strays = `${r.nonEventPackets} non-event packet(s) arrived on the listening connection`
  const noTypes = `no event arrived in the ${r.windowSeconds}s window, so nothing can be said about which types this device emits`
  if (r.eventsObserved === 0) {
    return r.nonEventPackets === 0
      ? `${noTypes}; ${strays}, so neither half of this item was exercised.`
      : `${noTypes} — but ${strays}, which answers the interleave half of this item on its own.`
  }
  return `${r.eventsObserved} event(s) observed, type(s) seen: ${r.eventTypes.join(', ')}; ${strays}.`
}

/**
 * Item 14 alone: does the device ever push an event before acknowledging
 * CMD_REG_EVENT?
 *
 * This is an anomaly-detection item, like item 5's framing cap: a desync
 * observed is a positive, decisive answer ('answered') even though it means
 * `registered` stayed false and items 9 and 13 stay 'not answered' for this
 * same run — the session was torn down before a window could be held open
 * (v0.2 RULING R11), but item 14 already has its answer the moment the race is
 * caught. No desync is 'not answered': the race not firing on one run is not
 * evidence it cannot happen.
 */
function realtimeDesyncState(f: Findings): ChecklistState {
  if (f.realtime === null) return 'not requested'
  return answeredIf(f.realtime.desyncOnRegister)
}

function realtimeDesyncObservation(f: Findings): string {
  const r = f.realtime
  if (r === null) return REALTIME_NOT_REQUESTED
  if (r.desyncOnRegister) {
    return `yes — the device pushed an event before acknowledging CMD_REG_EVENT: ${reason(r.error)}. The session was torn down, as designed (v0.2 RULING R11).`
  }
  return 'no desync was observed on this run — inconclusive, since the race is only caught if the device happens to lose it, not provoked deliberately.'
}

/**
 * Item 12's observation: is there a way to cancel a subscription without
 * dropping the connection?
 *
 * The row is written inline as 'not testable by this tool' (Fix round 1, F11)
 * — the same state items 8 and 22 use, and for the same reason: this library
 * ships no unsubscribe or cancel primitive (`Transport.listen` is documented
 * one-way, once per socket, and `Session` has nothing that reverses it), so no
 * branch of `probeRealtime`, success or failure, ever attempts one.
 */
const REALTIME_CANCEL_OBSERVATION =
  'this library has no unsubscribe/cancel primitive (Transport.listen is one-way, once per socket) and the probe never attempts one; not answerable from a probe run.'

/**
 * Item 10: does the device accept a second concurrent connection?
 *
 * Unlike the realtime items above, a refusal here is just as decisive an
 * answer as an acceptance — see `probeConcurrent`'s own doc comment ("Both
 * outcomes answer the item"). So 'not answered' never applies once the probe
 * has run; only 'not requested' (--concurrent was not passed) precedes an
 * 'answered' result.
 */
function concurrentState(f: Findings): ChecklistState {
  return f.concurrent === null ? 'not requested' : 'answered'
}

function concurrentObservation(f: Findings): string {
  const c = f.concurrent
  if (c === null) return 'the second-connection probe was not requested (pass --concurrent to run it).'
  return c.accepted
    ? 'a second connection was accepted while the first was still open.'
    : `a second connection was refused: ${reason(c.error)}.`
}

/**
 * The message `tryUnframeTcp` throws when MAX_DECLARED_SIZE rejects a packet
 * (`src/codec/framing.ts`), matched loosely enough to survive a reworded
 * sentence but tightly enough not to match anything else in the codebase.
 */
const DECLARED_SIZE_CAP_MESSAGE = /declared payload size \d+ exceeds/

/**
 * Did this step carry the TCP declared-size cap firing?
 *
 * Item 5 names exactly one constant: `MAX_DECLARED_SIZE` in
 * `src/codec/framing.ts`. Since v0.5 that cap throws `ZkFramingError`
 * (framing.ts:49), the same class the two RECORD parsers throw — so the class
 * alone cannot identify the cap, and the message is matched as well. Both
 * halves are load-bearing: the class keeps a ZkProtocolError whose message
 * happens to mention a size out, and the message keeps a record parser out.
 *
 * Matching on prose is a real coupling and it is deliberate. The alternative —
 * exporting a predicate from framing.ts — would change the library this
 * diagnostic exists to falsify, and a read-only tool does not get to do that.
 * The coupling is pinned instead by a test that produces the error from the
 * real `tryUnframeTcp`, so a reworded throw site reddens that test rather than
 * silently switching this row off.
 */
function isDeclaredSizeCap(step: StepResult): boolean {
  return step.errorClass === 'ZkFramingError' && DECLARED_SIZE_CAP_MESSAGE.test(step.errorMessage ?? '')
}

/**
 * Why no attendance record size is available, as a clause that reads inside a
 * sentence — items 1, 3 and 11 all need it and must not contradict each other.
 *
 * The four cases the data already separates, and used to be collapsed into one
 * false sentence ("attendance was not read"):
 *
 * - `findings.attendance === null` with an `attendance` step present: the read
 *   was attempted and threw. Saying "not read" here also contradicts the step
 *   table one section below, which shows that step and its outcome.
 * - `findings.attendance === null` with no such step: never attempted — the
 *   run was truncated before it, or `probeBulk` never got that far.
 * - `skippedReason !== null`: attempted and deliberately skipped.
 * - `read: true` with `rowCount === 0`: READ, and the device answered zero
 *   records. That is a finding in its own right — an empty log is the
 *   overwhelmingly likely first device — not an absence, and telling the
 *   operator to go read attendance is telling them to redo what they just did.
 */
function attendanceAbsence(result: ProbeResult): string {
  const a = result.findings.attendance
  if (a === null) {
    const step = result.steps.find((s) => s.name === 'attendance')
    return step
      ? `the attendance read did not complete (step 'attendance' came back ${step.outcome})`
      : 'attendance was not read'
  }
  if (a.skippedReason !== null) return `the attendance read was ${a.skippedReason}`
  if (a.rowCount === 0) return 'attendance was read and the device returned 0 records'
  return `attendance was read (${a.rowCount} record(s)) but no record size was reported`
}

/**
 * Item 1's evidence, and whether it exists.
 *
 * Spec §4.5 answers item 1 with `--raw-capture` and with nothing else. The row
 * used to gate on `steps.length > 0`, which says only that bytes moved through
 * memory — on a default run they are gone with the process, and the row still
 * said "see the accompanying raw capture" about a file nobody wrote.
 *
 * `rawCapture` is the path this run is writing the capture to, so "answered"
 * means the bytes were routed to a file rather than that the write has already
 * returned: `writeOutputs` renders the Markdown before it writes the capture.
 * A failed capture write is not silent — it aborts `writeOutputs`, prints on
 * stderr and exits non-zero — so the report can name the path without
 * claiming more than the CLI will admit to.
 *
 * The question has two halves ("a full handshake AND one attendance read"), so
 * an attendance read that never happened leaves it not answered even with a
 * capture on disk.
 */
function item1State(result: ProbeResult): ChecklistState {
  if (result.rawCapture === null || result.steps.length === 0) return 'not answered'
  return result.findings.attendance?.read === true ? 'answered' : 'not answered'
}

function item1Observation(result: ProbeResult): string {
  const { rawCapture, steps, findings } = result
  if (steps.length === 0) return 'no steps ran, so there is nothing to capture.'
  if (rawCapture === null) {
    return `${steps.length} step(s) were traced in memory only and are gone with this process — re-run with --raw-capture <path> to write the bytes.`
  }
  if (findings.attendance?.read !== true) {
    return `${steps.length} step(s) captured to ${rawCapture}, but ${attendanceAbsence(result)}, so the capture holds a handshake without an attendance read.`
  }
  return `${steps.length} step(s) captured to ${rawCapture}, including the attendance read.`
}

/**
 * Item 2, which is three questions in one row: the checksum formulation, the
 * comm-key mixing, and the reply-id quirk.
 *
 * The count is the DEVICE's packets. Counting ours in with them (the old
 * `packetsChecked`) roughly doubled the only number a reader uses to judge
 * whether §5's formulation survives contact with hardware — a `send` payload
 * was built by `checksum16` moments earlier, so recomputing it can never
 * disagree. Ours is still reported, as the positive control it is.
 *
 * The reply-id verdict spec §5.1 asks for is now computed too
 * (`auditReplyIds`), and so is the third part -- see `commKeyObservation`,
 * which replaced a sentence telling the reader to go and check the CMD_AUTH
 * exchange in the raw capture by hand.
 *
 * The row's STATE still keys off the checksum reconciliation alone. Mixing
 * that was never exercised does not retract the two thirds that were answered,
 * and it does not get to claim the row either; the observation carries that
 * distinction, which is what a three-question row in a one-state table needs
 * its prose for.
 */
function item2Observation(f: Findings): string {
  const { received, sent } = f.checksum
  if (received.packetsChecked === 0) return 'no device packets were captured to reconcile.'
  const r = f.replyIds
  return (
    `checksums: ${received.packetsChecked} DEVICE packet(s) reconciled locally, ${received.mismatches} mismatch(es)` +
    ` (our own ${sent.packetsChecked} sent packet(s) re-checked as a positive control, ${sent.mismatches} mismatch(es) — any mismatch there is a bug in this tool, not the device).` +
    ` Reply ids: ${r.echoedRequestId} of ${r.repliesChecked} repl(ies) echoed the request's reply id.` +
    ` ${commKeyObservation(f.commKey)}`
  )
}

/**
 * The comm-key third of item 2, in the four states a reader must tell apart.
 *
 * "A key was given" is not one of them, deliberately. `Session.open` sends
 * CMD_AUTH only when the device answers CONNECT with ACK_UNAUTH, so a run
 * invoked with --comm-key against a device that never demands one exercises
 * `mixCommKey` zero times -- and that operator is the likeliest of all readers
 * to assume the mixing was checked, because they passed the flag. That state
 * gets the most explicit sentence here for exactly that reason.
 */
function commKeyObservation(c: Findings['commKey']): string {
  if (c.authSent) {
    return c.authAccepted
      ? 'Comm-key mixing: exercised and accepted — the device demanded a key and took the mixed value, so §5 mixing is confirmed against this firmware.'
      : 'Comm-key mixing: exercised and rejected — the device did not take the mixed value. Either §5 mixing is wrong for this firmware or the key is, and this row cannot tell which.'
  }
  return c.configured
    ? 'Comm-key mixing: not exercised — a comm key was given, but the device never demanded one, so no CMD_AUTH was sent and §5 mixing is still unchecked against this firmware.'
    : 'Comm-key mixing: not exercised — no comm key was given. Re-run with --comm-key against a device that demands one to put §5 mixing to the test.'
}

/**
 * Item 19: what the odd-length CMD_PREPARE_BUFFER payload actually showed.
 *
 * The state keys off `bulkPrepareAttempted` rather than `bulkPath` (see that
 * field's doc comment), and the observation says whether the device ACCEPTED
 * the odd-length request or not, instead of printing a path name and leaving a
 * reader to infer which of the two happened.
 *
 * "Did not accept" is deliberately weaker than "rejected the checksum": a
 * device refusing CMD_PREPARE_BUFFER may be refusing the command, not the
 * checksum over its odd-length body. Both outcomes are data for item 19; only
 * one of them is evidence the formulation is wrong, and this row must not
 * conflate them.
 */
function item19Observation(f: Findings): string {
  if (!f.bulkPrepareAttempted) {
    return 'no CMD_PREPARE_BUFFER request reached the wire, so the odd-length payload was never exercised.'
  }
  if (f.bulkPath === 'buffered') {
    return "CMD_PREPARE_BUFFER's 11-byte payload was sent and the device ACCEPTED it (the buffered path served the read), so an odd-length checksum was accepted."
  }
  if (f.bulkPath === 'legacy') {
    return "CMD_PREPARE_BUFFER's 11-byte payload was sent and the device answered ACK_ERROR, which is the only reply that now produces the legacy fallback (v0.5 §6.2). A refusal may be about the command rather than the checksum — see the per-step table for the exact reply."
  }
  return "CMD_PREPARE_BUFFER's 11-byte payload was sent, but the read did not complete, so which path served it is unknown. Since v0.5 a framing failure on the buffered path ends the read as ZkFramingError rather than falling back; see the per-step table."
}

/**
 * Item 4's note about the SECOND CMD_GET_FREE_SIZES, on the runs that made one.
 *
 * `getAttendanceLogs` reads the counters, does the bulk read, then reads them
 * again to bracket it (`src/commands/attendance.ts:66,79`) — but it returns
 * before that second read when the device reports zero records, and the whole
 * function is skipped by `--attendance=never` or the auto threshold. Emitting
 * the sentence unconditionally explained an extra exchange that, on those
 * runs, never happened.
 *
 * `attendance.read === true` is the gate because it is the wire fact: it is
 * set only when a read request actually left the socket (Task 4), which
 * happens only past the zero-record early return. It is sufficient rather than
 * necessary — a read that threw leaves `attendance` null though the second
 * counter read may have happened — and understating is the right direction for
 * a row whose subject is the offsets, not the exchange count.
 */
function freeSizesBracketNote(f: Findings): string {
  return f.attendance?.read === true
    ? ' CMD_GET_FREE_SIZES is also sent a second time after the attendance read, to bracket the record count (v0.5 §7.2), which is why the attendance step counts more exchanges than its command suggests.'
    : ''
}

/**
 * Item 20: what encoding the device uses for strings.
 *
 * Three outcomes, not two. `validUtf8` is `null` for "no name carried a high
 * byte, so there was nothing to test" — which is not `false`, and the ternary
 * that rendered it as "are NOT valid UTF-8" was the null-collapsed-into-false
 * shape this field exists to prevent, in the row that exists to preserve the
 * distinction. `encodingVerdict` pairs null only with `withHighBytes === 0`
 * today, so the third branch below is unreachable through the current
 * producer; it is written out anyway because "unreachable" is a property of
 * that function, not of this type.
 */
function item20Observation(f: Findings): string {
  const e = f.encoding
  if (e === null) return 'the user list was not read, so no names were available to inspect.'
  const preamble = `of ${e.namesInspected} name(s) inspected, ${e.withHighBytes} carried a byte above 0x7F`
  if (e.withHighBytes === 0) return `${preamble} (no evidence either way).`
  if (e.validUtf8 === null) return `${preamble}, but whether they are valid UTF-8 was not determined (no evidence either way).`
  return `${preamble}; those bytes ${e.validUtf8 ? 'ARE' : 'are NOT'} valid UTF-8.`
}

/** The step-name prefix `probeIdentity` gives every key in the parameter sweep. */
const PARAM_STEP_PREFIX = 'param:'

/**
 * Items 15-17's shared summary sentence.
 *
 * The count comes from the STEPS, not from `findings.parameters`. Since Task
 * 7's F6, a key answering ACK_UNAUTH throws `ZkAuthError` and is never pushed
 * into `findings.parameters` — so counting that array reported the survivors
 * as though they were the attempts ("9 keyword(s) tried" when 12 were), in a
 * report whose whole purpose is to be shared and compared. One `param:` step
 * exists per key the sweep actually reached, including every refused one, and
 * including none at all if the run was truncated first.
 *
 * "The parameter sweep did not run" is likewise reserved for the case where it
 * genuinely did not: a device that demands a comm key it did not get sweeps
 * all 12 keys and has all 12 refused, which is a device profile finding and
 * not an absence. The two used to be indistinguishable.
 *
 * The three `ParameterFinding` outcomes are counted apart rather than summed
 * into "answered", because items 15, 16 and 17 ask three different questions
 * of them: 15 is about the echo, 16 about a refusal or a blank, 17 about which
 * keys exist. "None returned a value to inspect" is the state where no key
 * echoed AND none answered without echoing — not merely the state where
 * `parameters` is empty, which a sweep of nothing but refusals also produces.
 */
function parameterSummary(f: Findings, steps: readonly StepResult[]): string {
  const paramSteps = steps.filter((s) => s.name.startsWith(PARAM_STEP_PREFIX))
  if (paramSteps.length === 0) return 'the parameter sweep did not run.'
  const unauthorized = paramSteps.filter((s) => s.outcome === 'unauthorized').length
  const echoed = f.parameters.filter((p) => p.outcome === 'answered').length
  const mismatched = f.parameters.filter((p) => p.outcome === 'mismatched-echo').length
  const refusedCount = f.parameters.filter((p) => p.outcome === 'refused').length
  const empty = f.parameters.filter((p) => p.outcome === 'answered' && p.empty).length
  if (echoed === 0 && mismatched === 0) {
    return `the sweep ran: ${paramSteps.length} keyword(s) tried, ${refusedCount} refused (ACK_ERROR), ${unauthorized} refused authorization (ACK_UNAUTH), and none returned a value to inspect. That is a device profile finding, not an absence — a session holding the device's comm key would see different answers.`
  }
  return `${paramSteps.length} keyword(s) tried; ${echoed} echoed the keyword back (${empty} of those empty), ${mismatched} answered WITHOUT echoing it, ${refusedCount} refused (ACK_ERROR), ${unauthorized} refused authorization (ACK_UNAUTH).`
}

/** Item 17 lists the keys, which are this library's own constants, never device data. */
function item17Observation(f: Findings, steps: readonly StepResult[]): string {
  const answered = f.parameters
    .filter((p) => p.outcome === 'answered' || p.outcome === 'mismatched-echo')
    .map((p) => p.key)
  const summary = parameterSummary(f, steps)
  return answered.length === 0 ? summary : `keyword(s) that answered: ${answered.join(', ')}. ${summary}`
}

/**
 * Builds the 23-row first-hardware checklist from one probe result.
 *
 * The mapping from item to evidence follows the bringup-kit design spec §4.5
 * ("Checklist coverage") and §4.6 ("What cannot be probed"): each item is
 * driven by the `Findings`/`steps` field that section names as its answer.
 * Item 22 is 'not testable by this tool' per the design doc's "What cannot be
 * probed" heading; items 8 and 12 share that same state for an analogous
 * reason the design doc predates — this library never sends an event
 * acknowledgment and has no cancel/unsubscribe primitive, so the probe cannot
 * exercise either one in any branch. No OTHER item borrows that state, even
 * where evidence is thin.
 *
 * Four deliberate departures, named here rather than left for a reader to
 * discover by diffing against §4.5. This comment previously claimed the
 * mapping was "verbatim" while sitting directly above two rows that were not:
 *
 * - **Item 5.** §4.5 names "framing error's `raw`, if it fires". `raw` no
 *   longer exists on `StepResult` (Fix round 1, F5 — it could carry
 *   unredacted device bytes into the sidecar), so the evidence here is the
 *   cap's message plus a byte count, and the observation points at the opt-in
 *   raw capture for the bytes themselves. See `isDeclaredSizeCap` for why the
 *   error is matched the way it is.
 * - **Item 19.** §4.5 says "`PREPARE_BUFFER`, unavoidably". True of the SEND
 *   in both branches, so this row keys off whether that send reached the wire
 *   (`findings.bulkPrepareAttempted`), not off `bulkPath` — which stays null
 *   when the read fails after PREPARE_BUFFER was already exercised.
 * - **Item 23.** §4.5 says "which bulk path was taken". That names the input,
 *   not the state: only the `legacy` path carries a refusal to reason from, so
 *   `buffered` is 'not answered' here. See the row itself.
 * - **Items 15-17.** §4.5 names `findings.parameters` for all three, which was
 *   read as one boolean ("did any key answer?") for all three. They are three
 *   questions: 15 is about the ECHO, 16 about a refusal or a blank, 17 about
 *   which keys exist. `ParameterFinding.outcome` separates them, so 16 no
 *   longer rides on 15's evidence.
 */
function buildChecklist(result: ProbeResult): ChecklistRow[] {
  const f = result.findings
  const steps = result.steps

  const capStep = steps.find(isDeclaredSizeCap)
  const recordSize = f.attendance?.detectedRecordSize ?? null
  const answeredKeys = f.parameters.filter((p) => p.outcome === 'answered' || p.outcome === 'mismatched-echo').length
  const refusedOrEmpty =
    f.parameters.some((p) => p.outcome === 'refused') || f.parameters.some((p) => p.outcome === 'answered' && p.empty)
  const encodingDecided = f.encoding !== null && f.encoding.validUtf8 !== null

  const rows: ChecklistRow[] = []
  const push = (item: number, question: string, state: ChecklistState, observation: string): void => {
    rows.push({ item, question, state, observation })
  }

  push(
    1,
    'Capture a raw byte dump of a full handshake and one attendance read.',
    item1State(result),
    item1Observation(result),
  )

  push(
    2,
    'Reconcile the checksum formulation, comm-key mixing and reply-id quirk against §5.',
    answeredIf(f.checksum.received.packetsChecked > 0),
    item2Observation(f),
  )

  push(
    3,
    'Confirm which attendance record size this model actually emits.',
    answeredIf(recordSize !== null),
    recordSize !== null
      ? `detected record size: ${recordSize} bytes.`
      : `${attendanceAbsence(result)}, so no record size could be detected.`,
  )

  push(
    4,
    'Confirm the CMD_GET_FREE_SIZES field offsets (FREE_SIZES_OFFSET) against a real reply.',
    answeredIf(f.freeSizes !== null),
    f.freeSizes !== null
      ? `userCount=${f.freeSizes.userCount} recordCount=${f.freeSizes.recordCount} recordCapacity=${f.freeSizes.recordCapacity}; the first ${f.freeSizes.rawHex.length / 2} byte(s) of the raw body are in the JSON sidecar (findings.freeSizes.rawHex) for manual offset review — capped at ${FREE_SIZES_RAW_MAX_BYTES}, with the full reply in the raw capture if one was requested.${freeSizesBracketNote(f)}`
      : 'CMD_GET_FREE_SIZES was not answered.',
  )

  push(
    5,
    'Confirm the TCP declared-size cap in src/codec/framing.ts is not rejecting legitimate traffic.',
    answeredIf(capStep !== undefined),
    capStep
      ? `the cap REJECTED a packet on step '${capStep.name}': ${capStep.errorMessage ?? '(no message)'}. MAX_DECLARED_SIZE is an unverified local guess, so treat this as evidence the cap is too tight until the packet says otherwise. The rejected ${capStep.rawByteLength ?? 0}-byte prefix is in the raw capture (--raw-capture), not in this report.`
      : 'the cap did not fire on this run — inconclusive, since it is only exercised if a device happens to declare an oversized packet. A record-parser framing error is NOT this cap and does not answer this item.',
  )

  // 'neither' is a non-null verdict, and it settles nothing about the request
  // SHAPE: the A/B ran against ~SerialNumber, and a firmware that does not
  // expose that key (or a session without the comm key it wants) refuses both
  // shapes. KEYWORD_FORM_NOTE.neither says so in as many words -- "Re-run the
  // A/B ... before recording any item-18 answer" -- so `answered` in the
  // column beside it was the report contradicting itself.
  const keywordDecided = f.keywordForm !== null && f.keywordForm !== 'neither'
  push(
    6,
    'Resolve any oracle divergence recorded under §7.3.',
    answeredIf(keywordDecided),
    f.keywordForm === null
      ? 'the keyword-shape A/B did not complete, so this remains open.'
      : keywordDecided
        ? "resolved for item 18's part of it via the keyword-shape A/B; see item 18."
        : 'the A/B ran but the device refused BOTH shapes, so item 18 is unresolved and so is this; see item 18.',
  )

  const identityComplete = f.identity.deviceName !== null && f.identity.firmwareVersion !== null
  push(
    7,
    'Add the model to the compatibility table.',
    answeredIf(identityComplete),
    identityComplete
      ? `deviceName=${deviceValue(f.identity.deviceName)} firmwareVersion=${deviceValue(f.identity.firmwareVersion)} platform=${deviceValue(f.identity.platform)} os=${deviceValue(f.identity.os)}.`
      : 'the device name and firmware version were not both recovered.',
  )

  push(
    8,
    'Does the device require an acknowledgment for each realtime event?',
    'not testable by this tool',
    item8Observation(f),
  )
  push(
    9,
    'Does a subscription survive an idle period, or does the device drop it?',
    realtimeState(f, (r) => r.registered),
    item9Observation(f),
  )
  push(
    10,
    'Does the device accept a second concurrent connection on 4370?',
    concurrentState(f),
    concurrentObservation(f),
  )

  push(
    11,
    "Is the small dialect's uid one byte or two?",
    answeredIf(recordSize !== null),
    recordSize !== null
      ? `inferred from the attendance record size (${recordSize} bytes).`
      : `${attendanceAbsence(result)}, so the dialect could not be inferred.`,
  )

  push(
    12,
    'Is there a way to cancel a subscription without dropping the connection?',
    'not testable by this tool',
    REALTIME_CANCEL_OBSERVATION,
  )
  push(
    13,
    'Does the device emit event types outside the requested mask, or interleave a request-response packet into a listening connection?',
    realtimeState(f, (r) => r.registered && (r.eventsObserved > 0 || r.nonEventPackets > 0)),
    item13Observation(f),
  )
  push(
    14,
    'Does the device ever push an event before acknowledging CMD_REG_EVENT?',
    realtimeDesyncState(f),
    realtimeDesyncObservation(f),
  )

  const paramSummary = parameterSummary(f, steps)
  push(15, 'Does the device echo the requested keyword in a CMD_OPTIONS_RRQ reply?', answeredIf(answeredKeys > 0), paramSummary)
  push(16, 'Does an unsupported parameter answer ACK_ERROR or an empty value?', answeredIf(refusedOrEmpty), paramSummary)
  push(17, 'Which parameter keywords does this firmware actually expose?', answeredIf(answeredKeys > 0), item17Observation(f, steps))

  push(
    18,
    'Is the keyword payload accepted as a bare string, with no NUL terminator?',
    answeredIf(keywordDecided),
    f.keywordForm !== null ? KEYWORD_FORM_NOTE[f.keywordForm] : 'the keyword-shape A/B did not complete.',
  )

  push(
    19,
    'Does the device accept a checksum over an odd-length payload?',
    answeredIf(f.bulkPrepareAttempted),
    item19Observation(f),
  )

  push(
    20,
    'What character encoding does the device use for strings — device name and user name alike?',
    answeredIf(encodingDecided),
    item20Observation(f),
  )

  push(
    21,
    'Does CMD_GET_TIME return the packed uint32 at offset 0, and how far does the device clock drift from the collecting host?',
    answeredIf(f.clock !== null),
    f.clock !== null
      ? `device=${f.clock.deviceLocal} host=${f.clock.hostLocal} skew=${f.clock.skewSeconds === null ? 'undetermined (decoded date does not exist on a real calendar)' : `${f.clock.skewSeconds}s`}.`
      : 'CMD_GET_TIME was not answered.',
  )

  push(
    22,
    "Does a terminal ever answer after this library's per-request deadline has already expired?",
    'not testable by this tool',
    'a late reply racing the next request is not deterministically provokable (design spec §4.6); record this by hand if observed.',
  )

  // Only the LEGACY path carries a refusal to reason about. On a buffered run
  // nothing was refused, no ACK_UNAUTH was seen, and nothing whatsoever was
  // learned about what ACK_UNAUTH means on this firmware -- the row used to
  // print `answered` beside an observation describing, in the subjunctive, the
  // evidence that would have answered it.
  push(
    23,
    'Does any firmware answer ACK_UNAUTH to mean "this command is not supported" rather than "you are not authorized"?',
    answeredIf(f.bulkPath === 'legacy'),
    f.bulkPath === 'legacy'
      ? 'the device refused CMD_PREPARE_BUFFER with ACK_ERROR and the read fell back to the legacy path. Since v0.5 that is the ONLY reply that falls back: an ACK_UNAUTH to CMD_PREPARE_BUFFER ends the read as unauthorized and never reaches the legacy path, so a firmware using ACK_UNAUTH for "unsupported" shows up as an unauthorized step outcome, not as a fallback.'
      : f.bulkPath === 'buffered'
        ? 'the buffered path was accepted, so no refusal occurred and ACK_UNAUTH\'s meaning on this firmware was not exercised.'
        : 'no decisive bulk-path signal was captured.',
  )

  return rows
}

/**
 * Escapes a value going into a pipe-delimited table cell.
 *
 * Two characters break a Markdown table: `|` shifts every cell after it, and a
 * newline ends the row, so text after it is parsed as a new row — a device
 * name of `MB360\n| 3 | … | answered |` inserted a fabricated checklist row
 * into a report meant to be pasted into a public issue. Device strings are
 * sanitised at the source (`sanitizeDeviceString`), which is where redaction
 * belongs; this covers `errorMessage`, the one column fed from an `Error` whose
 * text can originate outside this codebase (`ZkConnectionError(err.message)`
 * wraps the OS's).
 *
 * A `|` already inside a `codeSpan` gets escaped again here, and that visible
 * backslash is intentional and structurally required: GFM splits table cells
 * on `|` before it parses inline code, so an unescaped pipe shifts the row
 * whether or not it sits between backticks. Do not "fix" the cosmetics —
 * doing so reopens the row-injection this pair closes.
 */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ')
}

/**
 * Renders a device-controlled value as an inert Markdown code span.
 *
 * The device chooses these bytes; a report reader must see them as text, not
 * as markup — `[MB360](https://evil.example)` renders as a link otherwise. The
 * fence is one backtick longer than the longest backtick run inside the value,
 * and a value that starts or ends with a backtick gets a padding space, which
 * is CommonMark's own rule for exactly this.
 */
function codeSpan(value: string): string {
  const longest = (value.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

/** A device-sourced value for a report line: inert, or a plain marker when absent. */
function deviceValue(value: string | null): string {
  return value === null ? '(not reported)' : codeSpan(value)
}

function formatChecklistTable(rows: readonly ChecklistRow[]): string {
  const lines = ['| # | Item | Status | Observation |', '|---|---|---|---|']
  for (const row of rows) {
    lines.push(
      `| ${row.item} | ${escapeCell(row.question)} | ${row.state} | ${escapeCell(row.observation)} |`,
    )
  }
  return lines.join('\n')
}

function formatStepTable(steps: readonly StepResult[]): string {
  if (steps.length === 0) return '_No steps ran._'
  // Deliberately omits `value` (safe by construction — see the redaction note
  // on renderJson). `rawByteLength` is included: since Fix round 1 it is a
  // count, never the bytes themselves (see StepResult.rawByteLength's doc
  // comment).
  //
  // Design spec §5.1 asks for "per-step outcomes (command, ack code, body
  // length)". All three are here now: `StepResult` carries the command and the
  // ack code as of the trace attribution in `StepRunner.attribute`, and the
  // body length is still the count an error happened to arrive with. This
  // comment used to name the gap instead, which was the honest thing to do
  // while `TraceEvent` -- and so the opt-in raw capture -- was the only place
  // those two numbers existed.
  const lines = [
    '| Step | Command | Ack | Outcome | Error | Message | Raw bytes |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const step of steps) {
    lines.push(
      `| ${escapeCell(step.name)} | ${commandCell(step)} | ${step.ackCode ?? ''} | ${step.outcome} | ${escapeCell(step.errorClass ?? '')} | ${escapeCell(step.errorMessage ?? '')} | ${step.rawByteLength ?? ''} |`,
    )
  }
  return lines.join('\n')
}

/**
 * The command cell, carrying the exchange count when there was more than one.
 *
 * A step is one row, and the bulk steps are three round trips: PREPARE_BUFFER,
 * READ_BUFFER, FREE_DATA. Printing `1503` alone would read as a single
 * exchange, and a reader counting round trips off this table would undercount
 * the run. The suffix appears only where it changes the reading.
 *
 * Empty for a step that reached no wire, never `0` — that is a real command
 * number, and nothing in the cell would tell a reader it was invented.
 */
function commandCell(step: StepResult): string {
  if (step.command === undefined) return ''
  const many = step.exchanges !== undefined && step.exchanges > 1
  return many ? `${step.command} x${step.exchanges}` : String(step.command)
}

/**
 * Renders the shareable Markdown report.
 *
 * Pure: every value it prints comes from `result`. No clock read, no
 * `process.*`, no filesystem access — the CLI supplies `startedAt` and
 * `durationMs` because it is the only layer allowed to read a clock (Task 8).
 */
export function renderMarkdown(result: ProbeResult): string {
  const f = result.findings
  const sections: string[] = []

  sections.push(
    [
      `# ZKTeco bring-up report`,
      ``,
      `- Library version: ${result.libraryVersion}`,
      `- Host: ${result.host}`,
      `- Transport: ${result.transport}`,
      `- Started at: ${result.startedAt}`,
      `- Duration: ${result.durationMs}ms`,
    ].join('\n'),
  )

  if (result.truncated) {
    sections.push(
      `**Run truncated** after step \`${result.truncated.after}\` (reason: ${result.truncated.reason}). Later steps did not run and are not "skipped" — they are simply absent from this report.`,
    )
  }

  sections.push(
    [
      `## Device`,
      ``,
      `- Device name: ${deviceValue(f.identity.deviceName)}`,
      `- Platform: ${deviceValue(f.identity.platform)}`,
      `- OS: ${deviceValue(f.identity.os)}`,
      `- Firmware version: ${deviceValue(f.identity.firmwareVersion)}`,
      `- Serial number: ${f.identity.serialNumberPresent ? 'present (value withheld — it identifies one unit)' : 'not reported'}`,
    ].join('\n'),
  )

  sections.push(['## First-hardware checklist', '', formatChecklistTable(buildChecklist(result))].join('\n'))

  sections.push(['## Steps', '', formatStepTable(result.steps)].join('\n'))

  return sections.join('\n\n') + '\n'
}

/**
 * Renders the JSON sidecar.
 *
 * No filtering here, deliberately: `Findings` is redacted at the source —
 * Tasks 4 and 6 fixed the two leaks that would have put something sensitive
 * there, in the code that produced it, which is the right place. A renderer
 * that stripped secrets would be one edit away from leaking them, and would
 * imply `Findings` cannot be trusted on its own. This function trusts it, and
 * mirrors `result` unmodified.
 *
 * ONE verbatim device payload travels in `Findings`, and this comment used to
 * assert there were none: `freeSizes.rawHex`, the head of the
 * CMD_GET_FREE_SIZES reply. It is sanctioned — spec §4.5 names that body as
 * checklist item 4's evidence, `FREE_SIZES_OFFSET` is unverified, and the
 * reply is a counters struct — and it is bounded to
 * `FREE_SIZES_RAW_MAX_BYTES` precisely because "sanctioned" is a claim about
 * a reply nobody has ever seen. See that field's own doc comment. Nothing
 * else here carries device bytes.
 *
 * `steps` gets the same trust, and for the same reason, as of Fix round 1:
 * `StepResult` no longer has anywhere to carry payload bytes.
 * `StepRunner.run` now stores only `rawByteLength`, a count, never the hex —
 * see `StepResult.rawByteLength`'s doc comment. Before that fix, `StepResult`
 * could carry a slice of real device bytes (a mismatched parameter echo, or a
 * malformed user/attendance record) that had never passed through `Findings`
 * and so had never been redacted; this function rendering `result` unmodified
 * would have carried that straight into the shareable sidecar. The fix is at
 * the source, same as Tasks 4 and 6 — this function still does no filtering
 * of its own.
 */
export function renderJson(result: ProbeResult): object {
  return { ...result, checklist: buildChecklist(result) }
}

/**
 * Renders the raw capture: one JSON object per line, preceded by a header
 * line that says in words what the file holds.
 *
 * Deliberately unredacted — item 2's checksum reconciliation is over exact
 * bytes, and redacting anything inside a payload would destroy the evidence
 * it exists to preserve. The header exists so a stranger deciding whether to
 * attach this to a public issue does not have to already know that.
 */
export function renderRawCapture(events: readonly TraceEvent[]): string {
  const header = {
    kind: 'header',
    warning:
      'UNREDACTED. Contains the mixed comm key from CMD_AUTH, employee names and user ids. Review before sharing.',
    events: events.length,
  }
  const lines = [JSON.stringify(header)]
  for (const event of events) lines.push(JSON.stringify(event))
  return lines.map((line) => `${line}\n`).join('')
}
