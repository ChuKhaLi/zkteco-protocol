import { ZkAuthError, ZkConnectionError, ZkError, ZkProtocolError, ZkTimeoutError } from '../errors.js'
import { CMD } from '../codec/commands.js'
import type { StepOutcome, StepResult, TraceEvent } from './types.js'

/**
 * Classifies a thrown error into the outcome the report records.
 *
 * The three classes tested here are mutually exclusive siblings under ZkError,
 * none extending another, so their RELATIVE order cannot change any outcome —
 * an earlier comment here claimed it was load-bearing, and it is not.
 *
 * What is load-bearing is the ABSENCE of a `ZkError` catch-all before them.
 * ZkError is the base of all four subclasses, so a catch-all placed first
 * would swallow every one of these branches and report every unauthorized
 * device, every timeout and every dropped connection as 'malformed' — three
 * checklist items answered with the wrong evidence, invisibly. ZkProtocolError
 * has no branch at all and reaches the fallthrough, which is why 'malformed'
 * must stay the fallthrough rather than becoming a branch of its own.
 *
 * Anything unrecognised is 'malformed' rather than a stop condition. A bug in
 * this tool must not masquerade as a device that went silent.
 *
 * A `ZkProtocolError` whose message matches `REJECTED_COMMAND_MESSAGE` is the
 * device answering ACK_ERROR -- a refusal, not a malformed body -- and is
 * reported as 'refused' rather than falling through.
 */

/**
 * The message `Session.execute` throws when the device answers ACK_ERROR
 * (`src/session/Session.ts`). Matched here so a refused read is reported as
 * `refused`, which is what it is, rather than as `malformed`. A message
 * coupling of the same kind as report.ts's DECLARED_SIZE_CAP_MESSAGE, pinned
 * the same way: test/diagnostics/step.spec.ts drives the real Session against
 * an emulator answering ACK_ERROR, so a reworded throw site reddens that test
 * instead of silently turning refusals back into 'malformed'.
 */
export const REJECTED_COMMAND_MESSAGE = /^device rejected command \d+/

export function classifyError(err: unknown): Exclude<StepOutcome, 'ok'> {
  if (err instanceof ZkAuthError) return 'unauthorized'
  if (err instanceof ZkTimeoutError) return 'silent'
  if (err instanceof ZkConnectionError) return 'dropped'
  if (err instanceof ZkProtocolError && REJECTED_COMMAND_MESSAGE.test(err.message)) return 'refused'
  return 'malformed'
}

/**
 * The step outcome a `tryExecute` reply code carries, or null when the reply
 * was an answer. Every step that decodes a reply inline checks this first, so
 * an ACK_UNAUTH body is never decoded as if it were the value it stands in
 * for (an ACK_UNAUTH with four bytes used to become the device clock).
 */
export function replyOutcome(command: number): 'refused' | 'unauthorized' | null {
  if (command === CMD.ACK_ERROR) return 'refused'
  if (command === CMD.ACK_UNAUTH) return 'unauthorized'
  return null
}

/**
 * Whether an outcome ends the run.
 *
 * The predicate is the one `freeBuffer` already established: an answer proves
 * the reply was consumed and the session is still in sync. A refusal, an
 * unauthorized reply and a malformed body are all answers, so the probe
 * continues and records them as data.
 *
 * A timeout is not an answer, and continuing past one is the failure this rule
 * exists to prevent. TcpTransport.receive clears its waiter on timeout, so a
 * late reply queues and the NEXT request collects it as its own (first-hardware
 * checklist item 22). Pressing on would produce a report full of real answers
 * attributed to the wrong questions — invisible to the reader, and the worst
 * possible outcome for a tool whose only product is evidence.
 */
export function stopsTheRun(outcome: StepOutcome): boolean {
  return outcome === 'silent' || outcome === 'dropped'
}

/**
 * Unique, unexported brand. Nothing outside this module can construct an
 * object bearing this key, so `isDeclined` below can never mistake an
 * ordinary `T` for a `Declined<T>` — no matter what shape `T` itself takes.
 */
const REFUSED = Symbol('refused')

export type DeclinedOutcome = 'refused' | 'unauthorized'

/**
 * Returned from a `run()` callback to record `'refused'` or `'unauthorized'`
 * instead of `'ok'`, without throwing. `classifyError` only ever sees thrown
 * errors, but steps that decode a `tryExecute` reply inline see the ack code
 * as a value; this is the value-shaped way to say what it was.
 */
export interface Declined<T> {
  readonly [REFUSED]: DeclinedOutcome
  readonly value: T | undefined
}

export function declined<T>(outcome: DeclinedOutcome, value?: T): Declined<T> {
  return { [REFUSED]: outcome, value }
}

/** `declined('refused', value)`, kept under the name every existing step uses. */
export function refused<T>(value?: T): Declined<T> {
  return declined('refused', value)
}

function isDeclined<T>(x: T | Declined<T>): x is Declined<T> {
  return typeof x === 'object' && x !== null && REFUSED in x
}

/** Runs probe steps, isolating each and stopping only when the device stops answering. */
export class StepRunner {
  private readonly results: StepResult<unknown>[] = []
  private stopped: { after: string; reason: StepOutcome } | null = null

  /**
   * @param trace Reads the trace log as it stands now. Optional, and a reader
   *   rather than the array itself: the runner needs the length before a step
   *   and the entries after it, and a `TracingTransport` appends to its own
   *   private log. Without it, a step records what it always did.
   */
  constructor(private readonly trace?: () => readonly TraceEvent[]) {}

  get steps(): readonly StepResult<unknown>[] {
    return this.results
  }

  get truncated(): { after: string; reason: string } | null {
    return this.stopped
  }

  /**
   * Runs one step.
   *
   * Returns the callback's value — including the value inside a
   * `declined(outcome, value)`, which `probeConcurrent` and `probeRealtime`
   * both pass a real one. Returns undefined only when the callback threw, or
   * when the run was already truncated.
   *
   * Once the run is truncated, later steps are NOT executed — returning
   * undefined without touching the socket. Recording them as skipped would be
   * a lie by omission; they are simply absent, and `truncated` says why.
   */
  async run<T>(name: string, fn: () => Promise<T | Declined<T>>): Promise<T | undefined> {
    if (this.stopped) return undefined
    const from = this.trace?.().length ?? 0
    try {
      const outcome = await fn()
      if (isDeclined(outcome)) {
        this.results.push({ name, outcome: outcome[REFUSED], value: outcome.value, ...this.attribute(from, false) })
        return outcome.value
      }
      this.results.push({ name, outcome: 'ok', value: outcome, ...this.attribute(from, true) })
      return outcome
    } catch (err) {
      const outcome = classifyError(err)
      const result: StepResult<unknown> = { name, outcome, ...this.attribute(from, false) }
      if (err instanceof Error) {
        result.errorClass = err.constructor.name
        result.errorMessage = err.message
      }
      // The byte COUNT only — never the bytes. See the doc comment on
      // StepResult.rawByteLength for why `err.raw` itself must not travel any
      // further than this function. `raw` is a hex string, two characters per
      // byte.
      if (err instanceof ZkError && err.raw) result.rawByteLength = err.raw.length / 2
      this.results.push(result)
      if (stopsTheRun(outcome)) this.stopped = { after: name, reason: outcome }
      return undefined
    }
  }

  /**
   * Attributes the trace span a step produced back to that step.
   *
   * The span is everything appended from `from` onward, which is exactly what
   * this step's callback caused: `run` is not re-entrant and the probe awaits
   * each step before starting the next.
   *
   * WHICH exchange depends on how the step ended. A step that ended `ok` is
   * named for the command it is about, which is its first send (readBulk's
   * buffered path ends on FREE_DATA, so the last would print the cleanup). A
   * step that did not end `ok` is decided by its last exchange — the request
   * the device refused, or the one that never came back — and that is the one
   * a reader needs to see beside the outcome: the attendance step used to
   * print `50 x4 | 2000 | refused | device rejected command 13`, attributing a
   * refusal of 13 to a 50 the device had answered. `exchanges` counts every
   * send either way.
   *
   * The reply taken is the first `recv` after the chosen send; a 'push' is
   * skipped, since an unsolicited realtime event acknowledges nothing.
   */
  private attribute(from: number, endedOk: boolean): Pick<StepResult, 'command' | 'ackCode' | 'exchanges'> {
    const span = (this.trace?.() ?? []).slice(from)
    const sends = span.filter((e) => e.direction === 'send')
    const chosen = endedOk ? sends[0] : sends[sends.length - 1]
    if (!chosen) return {}
    const ack = span.slice(span.indexOf(chosen) + 1).find((e) => e.direction === 'recv')
    const attributed: Pick<StepResult, 'command' | 'ackCode' | 'exchanges'> = {
      exchanges: sends.length,
    }
    if (chosen.command !== undefined) attributed.command = chosen.command
    if (ack?.command !== undefined) attributed.ackCode = ack.command
    return attributed
  }
}
