/** Which way a traced payload moved, or that no payload moved at all. */
export type TraceDirection = 'send' | 'recv' | 'push' | 'error'

/**
 * One observation from the wire.
 *
 * `hex` carries the whole payload because first-hardware checklist item 2
 * reconciles a checksum over exact bytes; a decoded header alone cannot be
 * re-checksummed, so recording only the parsed fields would answer none of the
 * questions this trace exists for.
 */
export interface TraceEvent {
  seq: number
  direction: TraceDirection
  offsetMs: number
  hex?: string
  command?: number
  checksum?: number
  sessionId?: number
  replyId?: number
  errorClass?: string
  errorMessage?: string
}

/**
 * What one probe step observed.
 *
 * The outcome and the decision to continue are two independent axes, and
 * conflating them is the mistake this type exists to prevent — see
 * `stopsTheRun`. A reader must be able to tell "the device rejected this" from
 * "the device sent something we could not parse" without inferring it from a
 * message string, because those answer different checklist items.
 */
export type StepOutcome =
  | 'ok'
  | 'refused'
  | 'unauthorized'
  | 'malformed'
  | 'silent'
  | 'dropped'

export interface StepResult<T = unknown> {
  name: string
  outcome: StepOutcome
  value?: T
  errorClass?: string
  errorMessage?: string
  /**
   * How many bytes the error already carried, when it carried any — never the
   * bytes themselves.
   *
   * `ZkError.raw` can be an arbitrary slice of a device reply: a mismatched
   * parameter echo carries `keyword=value` verbatim, and a malformed bulk-read
   * body can carry a slice of real user or attendance record bytes (see
   * `parseUserData` / `parseAttendanceData`). None of that has passed through
   * `Findings`, so it has never had the chance to be redacted the way
   * `Findings` is. A count answers "how much evidence is there" without
   * repeating the evidence — the raw capture (opt-in, and unredacted by
   * design) is where the bytes themselves belong.
   */
  rawByteLength?: number
}
