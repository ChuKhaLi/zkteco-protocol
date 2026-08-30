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
 * Items 8, 9, 12 and 13: what a completed subscription window shows.
 *
 * 'not requested' when the operator never passed --realtime (the device was
 * never asked) — a different claim from 'not answered', which means the
 * probe ran and the subscription did not complete (refused, or torn down by
 * a desync — see `realtimeDesyncState` for that case's OWN, positive answer
 * to item 14). Collapsing 'not requested' into 'not answered' would make a
 * default, unattended run look like it had probed items it never touched
 * (design spec §4.5, items 8-10 and 12-14).
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
 * Builds the 23-row first-hardware checklist from one probe result.
 *
 * The mapping from item to evidence follows the bringup-kit design spec §4.5
 * ("Checklist coverage") and §4.6 ("What cannot be probed") verbatim: each
 * item is driven by the same `Findings`/`steps` field that section names as
 * its answer, and item 22 alone is 'not testable by this tool' — the design
 * doc's "What cannot be probed" heading names only that one item, so no other
 * item borrows that state, even where evidence is thin.
 */
function buildChecklist(result: ProbeResult): ChecklistRow[] {
  const f = result.findings
  const steps = result.steps

  const framingStep = steps.find((s) => s.outcome === 'malformed' && s.errorClass === 'ZkFramingError')
  const recordSize = f.attendance?.detectedRecordSize ?? null

  const rows: ChecklistRow[] = []
  const push = (item: number, question: string, state: ChecklistState, observation: string): void => {
    rows.push({ item, question, state, observation })
  }

  push(
    1,
    'Capture a raw byte dump of a full handshake and one attendance read.',
    steps.length > 0 ? 'answered' : 'not answered',
    steps.length > 0
      ? `${steps.length} step(s) traced; see the accompanying raw capture for the bytes.`
      : 'no steps ran',
  )

  push(
    2,
    'Reconcile the checksum formulation, comm-key mixing and reply-id quirk against §5.',
    f.checksum.packetsChecked > 0 ? 'answered' : 'not answered',
    f.checksum.packetsChecked > 0
      ? `${f.checksum.packetsChecked} packet(s) reconciled locally, ${f.checksum.mismatches} mismatch(es).`
      : 'no packets were captured to reconcile.',
  )

  push(
    3,
    'Confirm which attendance record size this model actually emits.',
    recordSize !== null ? 'answered' : 'not answered',
    recordSize !== null
      ? `detected record size: ${recordSize} bytes.`
      : (f.attendance?.skippedReason ?? 'attendance was not read.'),
  )

  push(
    4,
    'Confirm the CMD_GET_FREE_SIZES field offsets (FREE_SIZES_OFFSET) against a real reply.',
    f.freeSizes !== null ? 'answered' : 'not answered',
    f.freeSizes !== null
      ? `userCount=${f.freeSizes.userCount} recordCount=${f.freeSizes.recordCount} recordCapacity=${f.freeSizes.recordCapacity}; raw body recorded for manual offset review.`
      : 'CMD_GET_FREE_SIZES was not answered.',
  )

  push(
    5,
    'Confirm the TCP declared-size cap in src/codec/framing.ts is not rejecting legitimate traffic.',
    framingStep ? 'answered' : 'not answered',
    framingStep
      ? `a framing error was observed on step '${framingStep.name}': ${framingStep.errorMessage ?? '(no message)'}.`
      : 'no framing error was observed on this run — inconclusive, since the cap is only exercised if a device happens to send an oversized packet.',
  )

  push(
    6,
    'Resolve any oracle divergence recorded under §7.3.',
    f.keywordForm !== null ? 'answered' : 'not answered',
    f.keywordForm !== null
      ? "resolved for item 18's part of it via the keyword-shape A/B; see item 18."
      : 'the keyword-shape A/B did not complete, so this remains open.',
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
      : 'attendance was not read, so the dialect could not be inferred.',
  )

  push(
    12,
    'Is there a way to cancel a subscription without dropping the connection?',
    realtimeGeneralState(f),
    realtimeGeneralObservation(f),
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
  const paramSummary = paramsAnswered
    ? `${f.parameters.length} keyword(s) tried; ${f.parameters.filter((p) => p.answered).length} answered, ${f.parameters.filter((p) => p.answered && p.empty).length} of those empty.`
    : 'the parameter sweep did not run.'
  push(15, 'Does the device echo the requested keyword in a CMD_OPTIONS_RRQ reply?', paramsAnswered ? 'answered' : 'not answered', paramSummary)
  push(16, 'Does an unsupported parameter answer ACK_ERROR or an empty value?', paramsAnswered ? 'answered' : 'not answered', paramSummary)
  push(17, 'Which parameter keywords does this firmware actually expose?', paramsAnswered ? 'answered' : 'not answered', paramSummary)

  push(
    18,
    'Is the keyword payload accepted as a bare string, with no NUL terminator?',
    f.keywordForm !== null ? 'answered' : 'not answered',
    f.keywordForm !== null ? KEYWORD_FORM_NOTE[f.keywordForm] : 'the keyword-shape A/B did not complete.',
  )

  push(
    19,
    'Does the device accept a checksum over an odd-length payload?',
    f.bulkPath !== null ? 'answered' : 'not answered',
    f.bulkPath !== null
      ? `exercised unavoidably by CMD_PREPARE_BUFFER's 11-byte payload; bulk path observed: ${f.bulkPath}.`
      : 'no decisive bulk-path signal was captured.',
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

  push(
    23,
    'Does any firmware answer ACK_UNAUTH to mean "this command is not supported" rather than "you are not authorized"?',
    f.bulkPath !== null ? 'answered' : 'not answered',
    f.bulkPath !== null
      ? `bulk path observed: ${f.bulkPath} — a 'legacy' path after a refused CMD_PREPARE_BUFFER is evidence for this; see the per-step table for the exact outcome.`
      : 'no decisive bulk-path signal was captured.',
  )

  return rows
}

function formatChecklistTable(rows: readonly ChecklistRow[]): string {
  const lines = ['| # | Item | Status | Observation |', '|---|---|---|---|']
  for (const row of rows) {
    lines.push(`| ${row.item} | ${row.question} | ${row.state} | ${row.observation} |`)
  }
  return lines.join('\n')
}

function formatStepTable(steps: readonly StepResult[]): string {
  if (steps.length === 0) return '_No steps ran._'
  // Deliberately omits `value` (safe by construction — see the redaction note
  // on renderJson). `rawByteLength` is included: since Fix round 1 it is a
  // count, never the bytes themselves (see StepResult.rawByteLength's doc
  // comment), which is exactly what the design spec's §5.1 "per-step
  // outcomes (command, ack code, body length)" content list asks for.
  const lines = ['| Step | Outcome | Error | Message | Raw bytes |', '|---|---|---|---|---|']
  for (const step of steps) {
    lines.push(
      `| ${step.name} | ${step.outcome} | ${step.errorClass ?? ''} | ${step.errorMessage ?? ''} | ${step.rawByteLength ?? ''} |`,
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
 * No filtering here, deliberately: nothing sensitive was ever put into
 * `Findings` — Tasks 4 and 6 fixed the two leaks that would have put
 * something there, at the source, which is the right place. A renderer that
 * stripped secrets would be one edit away from leaking them, and would imply
 * `Findings` cannot be trusted on its own. This function trusts it, and
 * mirrors `result` unmodified.
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
