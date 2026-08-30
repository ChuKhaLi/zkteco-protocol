import { ZkAuthError, ZkConnectionError, ZkError, ZkTimeoutError } from '../errors.js'
import type { StepOutcome, StepResult } from './types.js'

/**
 * Classifies a thrown error into the outcome the report records.
 *
 * ZkAuthError is tested FIRST and this ordering is load-bearing: it and
 * ZkProtocolError are siblings under ZkError, neither extending the other, so
 * a `ZkError` catch-all placed earlier would report every unauthorized device
 * as malformed and answer the wrong checklist item.
 *
 * Anything unrecognised is 'malformed' rather than a stop condition. A bug in
 * this tool must not masquerade as a device that went silent.
 */
export function classifyError(err: unknown): Exclude<StepOutcome, 'ok'> {
  if (err instanceof ZkAuthError) return 'unauthorized'
  if (err instanceof ZkTimeoutError) return 'silent'
  if (err instanceof ZkConnectionError) return 'dropped'
  return 'malformed'
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
 * object bearing this key, so `isRefused` below can never mistake an
 * ordinary `T` for a `Refused<T>` — no matter what shape `T` itself takes.
 */
const REFUSED = Symbol('refused')

/**
 * Returned from a `run()` callback to record `'refused'` instead of `'ok'`,
 * without throwing.
 *
 * `classifyError` only ever sees thrown errors, but some steps decode
 * `ACK_ERROR` inline rather than letting `session.execute` throw for them
 * (`session.tryExecute` never throws on ACK_ERROR — see its doc comment).
 * Those steps still need to record a refusal as a refusal rather than as
 * `'ok'`, and "throw a value just so `run()`'s catch block can classify it"
 * would be using an exception for control flow. This is the smaller thing:
 * a plain, unambiguous return value.
 */
export interface Refused<T> {
  readonly [REFUSED]: true
  readonly value: T | undefined
}

/** Builds a `Refused<T>` to return from a `run()` callback. */
export function refused<T>(value?: T): Refused<T> {
  return { [REFUSED]: true, value }
}

function isRefused<T>(x: T | Refused<T>): x is Refused<T> {
  return typeof x === 'object' && x !== null && REFUSED in x
}

/** Runs probe steps, isolating each and stopping only when the device stops answering. */
export class StepRunner {
  private readonly results: StepResult<unknown>[] = []
  private stopped: { after: string; reason: StepOutcome } | null = null

  get steps(): readonly StepResult<unknown>[] {
    return this.results
  }

  get truncated(): { after: string; reason: string } | null {
    return this.stopped
  }

  /**
   * Runs one step. Returns its value, or undefined if it did not produce one
   * (including when the callback reports `refused(value)`).
   *
   * Once the run is truncated, later steps are NOT executed — returning
   * undefined without touching the socket. Recording them as skipped would be
   * a lie by omission; they are simply absent, and `truncated` says why.
   */
  async run<T>(name: string, fn: () => Promise<T | Refused<T>>): Promise<T | undefined> {
    if (this.stopped) return undefined
    try {
      const outcome = await fn()
      if (isRefused(outcome)) {
        this.results.push({ name, outcome: 'refused', value: outcome.value })
        return outcome.value
      }
      this.results.push({ name, outcome: 'ok', value: outcome })
      return outcome
    } catch (err) {
      const outcome = classifyError(err)
      const result: StepResult<unknown> = { name, outcome }
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
}
