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
 * Items 8, 9, 12, 13 and 14 (the realtime probe) and item 10 (the second
 * connection probe) — Task 10 has not landed, so `Findings` has no
 * `realtime`/`concurrent` fields to inspect yet. Until it does, every run of
 * this tool leaves these six items unrequested, so they are hard-coded here.
 *
 * TASK 10 TODO: once `Findings.realtime` / `Findings.concurrent` exist,
 * replace this constant with a per-item read of those fields — 'answered'
 * when the corresponding probe ran and produced a finding, 'not answered'
 * when it ran and the device declined, 'not requested' only when the
 * operator did not pass --realtime / --concurrent at all.
 */
const REALTIME_ITEMS = [8, 9, 12, 13, 14] as const
const CONCURRENT_ITEMS = [10] as const

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
    'not requested',
    'the realtime probe was not requested (Task 10 wires --realtime).',
  )
  push(
    9,
    'Does a subscription survive an idle period, or does the device drop it?',
    'not requested',
    'the realtime probe was not requested (Task 10 wires --realtime).',
  )
  push(
    10,
    'Does the device accept a second concurrent connection on 4370?',
    'not requested',
    'the second-connection probe was not requested (Task 10 wires --concurrent).',
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
    'not requested',
    'the realtime probe was not requested (Task 10 wires --realtime).',
  )
  push(
    13,
    'Does the device emit event types outside the requested mask, or interleave a request-response packet into a listening connection?',
    'not requested',
    'the realtime probe was not requested (Task 10 wires --realtime).',
  )
  push(
    14,
    'Does the device ever push an event before acknowledging CMD_REG_EVENT?',
    'not requested',
    'the realtime probe was not requested (Task 10 wires --realtime).',
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
  // Deliberately omits `value` and `raw`. `value` is safe by construction —
  // see the redaction note on renderJson — but `raw` is not: on the 'users'
  // and 'attendance' steps it can carry hex straight out of
  // parseUserData/parseAttendanceData's declared-size-mismatch guard, which
  // is a slice of the actual record bytes (see the redaction finding in the
  // task report). This table sticks to the outcome summary the design spec
  // asks for (§5.1: "per-step outcomes") rather than any payload bytes.
  const lines = ['| Step | Outcome | Error | Message |', '|---|---|---|---|']
  for (const step of steps) {
    lines.push(`| ${step.name} | ${step.outcome} | ${step.errorClass ?? ''} | ${step.errorMessage ?? ''} |`)
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
 * NOTE (reported, not filtered here — see the task report): `steps` is
 * outside that guarantee. `StepResult.raw` is populated from `ZkError.raw`,
 * and on the 'users' and 'attendance' steps that can be a slice of the raw
 * record bytes coming straight out of `parseUserData` /
 * `parseAttendanceData`'s declared-size-mismatch guard — bytes that were
 * never routed through `Findings` and so never had the chance to be
 * redacted. This function still renders `result` as given, per this task's
 * brief; the fix belongs where Tasks 4 and 6 put theirs, at the source.
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
