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
   * The first command this step put on the wire, and the code the device
   * answered it with.
   *
   * Design spec §5.1 asks for "per-step outcomes (command, ack code, body
   * length)"; a step used to carry only the last of the three, because these
   * two live on `TraceEvent` and `TraceEvent` reaches only the opt-in raw
   * capture. They are attributed here from the trace span a step produced.
   *
   * FIRST rather than last: a step is named for the command it is about, and
   * `readBulk`'s buffered path ends on FREE_DATA, so the last command would
   * print the cleanup. `exchanges` is what keeps that honest -- one command
   * with no count reads as one round trip, which for the bulk steps it is not.
   *
   * All three are absent, never zero, when a step reached no wire: 0 is a real
   * command number, and a reader cannot tell a fabricated one from a real one.
   * `command` and `ackCode` are absent too when the payload did not decode,
   * while `exchanges` still counts what was sent.
   *
   * Numbers only. Neither carries identity, so this adds nothing to the
   * redaction surface -- see `rawByteLength` below for the rule that governs
   * anything that does.
   */
  command?: number
  ackCode?: number
  exchanges?: number
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
