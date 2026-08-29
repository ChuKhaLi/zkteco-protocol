export interface TransportOptions {
  host: string
  port: number
}

/**
 * The only abstraction that touches a socket.
 *
 * TCP and UDP differ in exactly two ways — whether packets carry the 8-byte
 * length-prefixed header, and how bytes arrive. Both differences live behind
 * this interface, so nothing above it ever learns which transport is in play.
 * `send` and `receive` deal in bare payloads.
 *
 * At most one `receive()` call may be outstanding at a time. Calling it again
 * before the first has settled rejects the second call immediately, rather
 * than risk a reply being routed to the wrong caller.
 */
export interface Transport {
  connect(): Promise<void>
  send(payload: Buffer): Promise<void>
  receive(timeoutMs: number): Promise<Buffer>
  /**
   * Switches this transport to push mode for a realtime subscription.
   *
   * ONE-WAY, ONCE PER SOCKET. After `listen()`, `receive()` rejects and a
   * second `listen()` throws. Ending a subscription closes the connection, so
   * no socket ever returns to request-response mode; one irreversible
   * transition is a state machine that can be enumerated in tests, which a
   * two-way router is not.
   *
   * Any packet already parked in the receive queue is handed to `onPacket`
   * before this returns, and an already-recorded socket failure is handed to
   * `onError` before this returns. Both matter: a packet that lands between a
   * reply and this call is a real event, and a listener attached over a dead
   * socket that then waits forever is a hang rather than a failure.
   */
  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void
  close(): Promise<void>
}
