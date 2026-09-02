import dgram from 'node:dgram'
import { ZkConnectionError } from '../errors.js'
import { PacketInbox } from './inbox.js'
import type { Transport, TransportOptions } from './Transport.js'

/**
 * UDP transport.
 *
 * Datagrams carry the bare payload: no start marker, no length prefix. One
 * datagram is one packet, so there is nothing to reassemble.
 *
 * This is the fallback. UDP loses packets and does not recover, and its
 * framing carries no length to validate against, so TCP is the default.
 */
export class UdpTransport implements Transport {
  private socket: dgram.Socket | null = null
  private readonly inbox = new PacketInbox()
  private failure: Error | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      let connectSettled = false
      const where = `${this.opts.host}:${this.opts.port}`
      const timer = setTimeout(() => {
        if (connectSettled) return
        connectSettled = true
        sock.close()
        reject(new ZkConnectionError(`cannot connect to ${where} within ${timeoutMs}ms`))
      }, timeoutMs)
      // Durable, not `once`, and it branches on which half of the socket's
      // life it fired in. The first error before bind IS the connect failure;
      // anything after connect has settled is a live socket dying, and used
      // to run this same body — closing the socket and rejecting an
      // already-settled promise, so the socket vanished with nobody told and
      // a listening subscription waited forever for events that could no
      // longer arrive. The flag also stops a second pre-bind error from
      // closing an already-closed socket, which throws from inside a handler.
      sock.on('error', (err) => {
        const failure = new ZkConnectionError(err.message)
        if (connectSettled) {
          this.fail(failure)
          return
        }
        connectSettled = true
        clearTimeout(timer)
        sock.close()
        reject(failure)
      })
      sock.on('message', (msg) => this.inbox.deliver(Buffer.from(msg)))
      sock.bind(0, () => {
        if (connectSettled) return
        connectSettled = true
        clearTimeout(timer)
        this.socket = sock
        resolve()
      })
    })
  }

  /**
   * Reports a socket failure to whoever is waiting on this transport, or
   * holds it for the next consumer if nobody is waiting yet.
   *
   * DECISION RULE: a UDP socket failure is delivered to exactly one consumer
   * and is then forgotten. It is never replayed.
   *
   * The asymmetry with TcpTransport, which keeps its failure for the life of
   * the object, is the point. A TCP failure means the connection is gone, so
   * every later receive() really is doomed and repeating the reason is the
   * most useful thing the transport can do. UDP has no connection to lose:
   * the socket stays bound and usable, and a post-bind error can be about one
   * datagram rather than about the socket. On Windows an ICMP
   * port-unreachable is delivered as ECONNRESET even on an UNCONNECTED
   * socket, so a single datagram sent to a powered-down terminal used to end
   * this transport for the rest of its life.
   *
   * This does not hide a socket that really is dead. The next operation on it
   * raises a FRESH error, which is a more accurate report than a replayed
   * stale one. The cost is that a receive() issued between the clearing and
   * the next real error waits out its timeout instead of failing fast —
   * accepted, because at that moment this transport genuinely does not know
   * whether the socket is dead.
   *
   * At most one of the two consumers below can exist at a time: receive()
   * refuses while a listener is attached, and listen() refuses while a
   * receive() is pending. So delivering to the first one found is delivering
   * to the only one there is.
   *
   * The socket is deliberately not closed here, mirroring TcpTransport: the
   * owner closes it, and a transport that closed itself would turn a reported
   * failure back into a silent one for anything that looked afterwards.
   */
  private fail(err: Error): void {
    if (this.inbox.notify(err)) return
    // Nobody to tell yet, so hold it for whoever arrives next: a consumer
    // that attaches to a dead socket and then waits forever is a hang, not a
    // failure.
    this.failure = err
  }

  /**
   * Takes the held failure, if there is one, clearing it as it goes.
   *
   * Reading and clearing are one operation on purpose — a caller that read it
   * without clearing would replay it, which is the behaviour the rule on
   * fail() exists to prevent.
   */
  private takeFailure(): Error | null {
    const err = this.failure
    this.failure = null
    return err
  }

  send(payload: Buffer): Promise<void> {
    const sock = this.socket
    if (!sock) return Promise.reject(new ZkConnectionError('transport is not connected'))
    return new Promise((resolve, reject) => {
      sock.send(payload, this.opts.port, this.opts.host, (err) =>
        err ? reject(new ZkConnectionError(err.message)) : resolve(),
      )
    })
  }

  receive(timeoutMs: number): Promise<Buffer> {
    return this.inbox.receive(timeoutMs, () => this.takeFailure())
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    // Called on a socket-level failure — a send that the OS refuses, the
    // socket erroring after bind. UDP still has no connection to lose, so a
    // dead DEVICE remains indistinguishable from a quiet one and is what
    // SubscribeOptions.idleTimeoutMs exists for; a dead SOCKET is not the
    // same thing and must not be silence.
    this.inbox.listen(onPacket, onError, () => this.takeFailure())
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
