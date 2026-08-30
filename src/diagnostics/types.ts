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
