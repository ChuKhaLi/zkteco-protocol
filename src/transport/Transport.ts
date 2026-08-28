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
  close(): Promise<void>
}
