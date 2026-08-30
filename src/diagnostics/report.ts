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

/**
 * Items 8, 9 and 13: what a completed subscription window shows.
 *
 * 'not requested' when the operator never passed --realtime (the device was
 * never asked) — a different claim from 'not answered', which means the
 * probe ran and the subscription did not complete (refused, or torn down by
 * a desync — see `realtimeDesyncState` for that case's OWN, positive answer
 * to item 14). Collapsing 'not requested' into 'not answered' would make a
 * default, unattended run look like it had probed items it never touched
 * (design spec §4.5, items 8-10 and 12-14).
 *
 * Item 12 does NOT share this function — see `realtimeCancelState` below. Fix
 * round 1 (F11): 'answered' here would have meant "a window completed", which
 * is evidence about whether events arrive, not about whether a subscription
 * can be CANCELLED. This library has no unsubscribe/cancel primitive at all
 * and the probe never attempts one, in any branch — so item 12 was a false
 * 'answered' before this fix, borrowing a flag with zero supporting mechanism
 * behind it.
 */
function realtimeGeneralState(f: Findings): ChecklistState {
  if (f.realtime === null) return 'not requested'
  return f.realtime.registered ? 'answered' : 'not answered'
}

function realtimeGeneralObservation(f: Findings): string {
  const r = f.realtime
  if (r === null) return 'the realtime probe was not requested (pass --realtime=<seconds> to run it).'
  if (!r.registered) {
    return `the subscription did not complete: ${r.error ?? '(no message)'}.`
  }
  return `registered and held open for a ${r.windowSeconds}s window; ${r.eventsObserved} event(s) observed, event type(s) seen: ${r.eventTypes.length > 0 ? r.eventTypes.join(', ') : '(none)'}.`
}

/**
 * Item 14 alone: does the device ever push an event before acknowledging
 * CMD_REG_EVENT?
 *
 * This is an anomaly-detection item, like item 5's framing cap: a desync
 * observed is a positive, decisive answer ('answered') even though it means
 * `registered` stayed false and the OTHER realtime items above stay 'not
 * answered' for this same run — the session was torn down before a window
 * could be held open (v0.2 RULING R11), but item 14 already has its answer
 * the moment the race is caught. No desync is 'not answered': the race not
 * firing on one run is not evidence it cannot happen.
 */
function realtimeDesyncState(f: Findings): ChecklistState {
  if (f.realtime === null) return 'not requested'
  return f.realtime.desyncOnRegister ? 'answered' : 'not answered'
}

function realtimeDesyncObservation(f: Findings): string {
  const r = f.realtime
  if (r === null) return 'the realtime probe was not requested (pass --realtime=<seconds> to run it).'
  if (r.desyncOnRegister) {
    return `yes — the device pushed an event before acknowledging CMD_REG_EVENT: ${r.error ?? '(no message)'}. The session was torn down, as designed (v0.2 RULING R11).`
  }
  return 'no desync was observed on this run — inconclusive, since the race is only caught if the device happens to lose it, not provoked deliberately.'
}

/**
 * Item 12 alone: is there a way to cancel a subscription without dropping
 * the connection?
 *
 * Always 'not testable by this tool' (Fix round 1, F11) — the same state
 * item 22 uses, and for the same reason: this library ships no unsubscribe
 * or cancel primitive (`Transport.listen` is documented one-way, once per
 * socket, and `Session` has nothing that reverses it), so no branch of
 * `probeRealtime`, success or failure, ever attempts one. There is no
 * outcome this probe could observe that would answer the question either
 * way, unlike items 8/9/13, which at least a completed window weakly informs.
 */
function realtimeCancelState(): ChecklistState {
  return 'not testable by this tool'
}

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
    : `a second connection was refused: ${c.error ?? '(no message)'}.`
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
 * `src/codec/framing.ts`. That cap throws `ZkProtocolError` (framing.ts:49).
 * It does NOT throw `ZkFramingError` — that class is thrown only by the two
 * record parsers (`codec/records/user.ts`, `codec/records/attendance.ts`),
 * which have nothing to do with framing.ts, and the two classes are siblings
 * under `ZkError` so no subtype relation blurs them.
 *
 * The class alone is not enough either: `ZkProtocolError` covers most of the
 * protocol surface (a start-marker mismatch, a short decode, an ACK_ERROR),
 * and any of those would otherwise answer item 5 with an unrelated event.
 * Hence class AND the cap's own message.
 *
 * Matching on prose is a real coupling and it is deliberate. The alternative —
 * exporting a predicate from framing.ts — would change the library this
 * diagnostic exists to falsify, and a read-only tool does not get to do that.
 * The coupling is pinned instead by a test that produces the error from the
 * real `tryUnframeTcp`, so a reworded throw site reddens that test rather than
 * silently switching this row off.
 */
function isDeclaredSizeCap(step: StepResult): boolean {
  return step.errorClass === 'ZkProtocolError' && DECLARED_SIZE_CAP_MESSAGE.test(step.errorMessage ?? '')
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
 * (`auditReplyIds`). The third part, comm-key mixing, is NOT audited here:
 * it is only exercised when a comm key is set, and this row says so rather
 * than letting `answered` quietly cover it.
 */
function item2Observation(f: Findings): string {
  const { received, sent } = f.checksum
  if (received.packetsChecked === 0) return 'no device packets were captured to reconcile.'
  const r = f.replyIds
  return (
    `checksums: ${received.packetsChecked} DEVICE packet(s) reconciled locally, ${received.mismatches} mismatch(es)` +
    ` (our own ${sent.packetsChecked} sent packet(s) re-checked as a positive control, ${sent.mismatches} mismatch(es) — any mismatch there is a bug in this tool, not the device).` +
    ` Reply ids: ${r.echoedRequestId} of ${r.repliesChecked} repl(ies) echoed the request's reply id.` +
    ` Comm-key mixing is NOT reconciled by this row — it is only exercised when a comm key is set; check the CMD_AUTH exchange in the raw capture by hand.`
  )
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
    return "CMD_PREPARE_BUFFER's 11-byte payload was sent and the device did not accept it (the read fell back to the legacy path). A refusal may be about the command rather than the checksum — see the per-step table for the exact reply."
  }
  return "CMD_PREPARE_BUFFER's 11-byte payload was sent, but the read did not complete, so which path served it is unknown; see the per-step table."
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
 */
function parameterSummary(f: Findings, steps: readonly StepResult[]): string {
  const paramSteps = steps.filter((s) => s.name.startsWith(PARAM_STEP_PREFIX))
  if (paramSteps.length === 0) return 'the parameter sweep did not run.'

  const unauthorized = paramSteps.filter((s) => s.outcome === 'unauthorized').length
  if (f.parameters.length === 0) {
    return `the sweep ran: ${paramSteps.length} keyword(s) tried, ${unauthorized} refused authorization (ACK_UNAUTH), and none returned a value to inspect. That is a device profile finding, not an absence — a session holding the device's comm key would see different answers.`
  }
  const answered = f.parameters.filter((p) => p.answered).length
  const empty = f.parameters.filter((p) => p.answered && p.empty).length
  return `${paramSteps.length} keyword(s) tried; ${answered} answered, ${empty} of those empty, ${unauthorized} refused authorization (ACK_UNAUTH).`
}

/**
 * Builds the 23-row first-hardware checklist from one probe result.
 *
 * The mapping from item to evidence follows the bringup-kit design spec §4.5
 * ("Checklist coverage") and §4.6 ("What cannot be probed"): each item is
 * driven by the `Findings`/`steps` field that section names as its answer.
 * Item 22 is 'not testable by this tool' per the design doc's "What cannot be
 * probed" heading; item 12 shares that same state as of Fix round 1 (F11) for
 * an analogous reason the design doc predates — this library has no
 * cancel/unsubscribe primitive for the probe to exercise. No OTHER item
 * borrows either state, even where evidence is thin.
 *
 * Three deliberate departures, named here rather than left for a reader to
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
 */
function buildChecklist(result: ProbeResult): ChecklistRow[] {
  const f = result.findings
  const steps = result.steps

  const capStep = steps.find(isDeclaredSizeCap)
  const recordSize = f.attendance?.detectedRecordSize ?? null

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
    f.checksum.received.packetsChecked > 0 ? 'answered' : 'not answered',
    item2Observation(f),
  )

  push(
    3,
    'Confirm which attendance record size this model actually emits.',
    recordSize !== null ? 'answered' : 'not answered',
    recordSize !== null
      ? `detected record size: ${recordSize} bytes.`
      : `${attendanceAbsence(result)}, so no record size could be detected.`,
  )

  push(
    4,
    'Confirm the CMD_GET_FREE_SIZES field offsets (FREE_SIZES_OFFSET) against a real reply.',
    f.freeSizes !== null ? 'answered' : 'not answered',
    f.freeSizes !== null
      ? `userCount=${f.freeSizes.userCount} recordCount=${f.freeSizes.recordCount} recordCapacity=${f.freeSizes.recordCapacity}; the first ${f.freeSizes.rawHex.length / 2} byte(s) of the raw body are in the JSON sidecar (findings.freeSizes.rawHex) for manual offset review — capped at ${FREE_SIZES_RAW_MAX_BYTES}, with the full reply in the raw capture if one was requested.`
      : 'CMD_GET_FREE_SIZES was not answered.',
  )

  push(
    5,
    'Confirm the TCP declared-size cap in src/codec/framing.ts is not rejecting legitimate traffic.',
    capStep ? 'answered' : 'not answered',
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
    keywordDecided ? 'answered' : 'not answered',
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
    identityComplete ? 'answered' : 'not answered',
    identityComplete
      ? `deviceName=${f.identity.deviceName} firmwareVersion=${f.identity.firmwareVersion} platform=${f.identity.platform ?? '(unset)'} os=${f.identity.os ?? '(unset)'}.`
      : 'the device name and firmware version were not both recovered.',
  )

  push(
    8,
    'Does the device require an acknowledgment for each realtime event?',
    realtimeGeneralState(f),
    realtimeGeneralObservation(f),
  )
  push(
    9,
    'Does a subscription survive an idle period, or does the device drop it?',
    realtimeGeneralState(f),
    realtimeGeneralObservation(f),
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
    recordSize !== null ? 'answered' : 'not answered',
    recordSize !== null
      ? `inferred from the attendance record size (${recordSize} bytes).`
      : `${attendanceAbsence(result)}, so the dialect could not be inferred.`,
  )

  push(
    12,
    'Is there a way to cancel a subscription without dropping the connection?',
    realtimeCancelState(),
    REALTIME_CANCEL_OBSERVATION,
  )
  push(
    13,
    'Does the device emit event types outside the requested mask, or interleave a request-response packet into a listening connection?',
    realtimeGeneralState(f),
    realtimeGeneralObservation(f),
  )
  push(
    14,
    'Does the device ever push an event before acknowledging CMD_REG_EVENT?',
    realtimeDesyncState(f),
    realtimeDesyncObservation(f),
  )

  const paramsAnswered = f.parameters.length > 0
  const paramSummary = parameterSummary(f, steps)
  push(15, 'Does the device echo the requested keyword in a CMD_OPTIONS_RRQ reply?', paramsAnswered ? 'answered' : 'not answered', paramSummary)
  push(16, 'Does an unsupported parameter answer ACK_ERROR or an empty value?', paramsAnswered ? 'answered' : 'not answered', paramSummary)
  push(17, 'Which parameter keywords does this firmware actually expose?', paramsAnswered ? 'answered' : 'not answered', paramSummary)

  push(
    18,
    'Is the keyword payload accepted as a bare string, with no NUL terminator?',
    keywordDecided ? 'answered' : 'not answered',
    f.keywordForm !== null ? KEYWORD_FORM_NOTE[f.keywordForm] : 'the keyword-shape A/B did not complete.',
  )

  push(
    19,
    'Does the device accept a checksum over an odd-length payload?',
    f.bulkPrepareAttempted ? 'answered' : 'not answered',
    item19Observation(f),
  )

  push(
    20,
    'What character encoding does the device use for strings — device name and user name alike?',
    f.encoding !== null ? 'answered' : 'not answered',
    f.encoding !== null
      ? `of ${f.encoding.namesInspected} name(s) inspected, ${f.encoding.withHighBytes} carried a byte above 0x7F` +
        (f.encoding.withHighBytes === 0
          ? ' (no evidence either way).'
          : `; those bytes ${f.encoding.validUtf8 ? 'ARE' : 'are NOT'} valid UTF-8.`)
      : 'the user list was not read, so no names were available to inspect.',
  )

  push(
    21,
    'Does CMD_GET_TIME return the packed uint32 at offset 0, and how far does the device clock drift from the collecting host?',
    f.clock !== null ? 'answered' : 'not answered',
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
    f.bulkPath === 'legacy' ? 'answered' : 'not answered',
    f.bulkPath === 'legacy'
      ? 'the device refused CMD_PREPARE_BUFFER and the read fell back to the legacy path — check that refusal\'s reply command in the per-step table: ACK_UNAUTH there means this firmware uses it for "unsupported".'
      : f.bulkPath === 'buffered'
        ? 'the buffered path was accepted, so no refusal occurred and ACK_UNAUTH\'s meaning on this firmware was not exercised.'
        : 'no decisive bulk-path signal was captured.',
  )

  return rows
}

/**
 * Escapes a value going into a pipe-delimited table cell.
 *
 * `errorMessage` is the one column fed from an `Error` whose message can
 * originate outside this codebase — `ZkConnectionError(err.message)` wraps the
 * OS's text (`tcp.ts:35,111`) — and item 5's observation quotes it verbatim.
 * An unescaped `|` shifts every cell after it, so a Markdown renderer displays
 * the wrong value under a labelled heading: a step whose "Raw bytes" column
 * shows a fragment of an error message. A table that puts a wrong value under
 * a right heading is the exact failure this tool exists to avoid, so this runs
 * on every cell rather than on the one that can reach it today.
 */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
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
  // length)". This table delivers the body length, and only when an error
  // happened to carry `raw`. The command number and the ack code are NOT here
  // and never have been: `StepResult` does not carry them — they live on
  // `TraceEvent`, which reaches only the opt-in raw capture. Naming that gap
  // rather than citing the requirement as though it were met; closing it means
  // threading trace data into `StepResult`, which is a change to what a step
  // records, not to how it is printed.
  const lines = ['| Step | Outcome | Error | Message | Raw bytes |', '|---|---|---|---|---|']
  for (const step of steps) {
    lines.push(
      `| ${escapeCell(step.name)} | ${step.outcome} | ${escapeCell(step.errorClass ?? '')} | ${escapeCell(step.errorMessage ?? '')} | ${step.rawByteLength ?? ''} |`,
    )
  }
  return lines.join('\n')
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
      `- Device name: ${f.identity.deviceName ?? '(not reported)'}`,
      `- Platform: ${f.identity.platform ?? '(not reported)'}`,
      `- OS: ${f.identity.os ?? '(not reported)'}`,
      `- Firmware version: ${f.identity.firmwareVersion ?? '(not reported)'}`,
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
