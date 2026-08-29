import dgram from 'node:dgram'
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'
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
  private queue: Buffer[] = []
  private waiter: ((payload: Buffer) => void) | null = null
  private failWaiter: ((err: Error) => void) | null = null
  private failure: Error | null = null
  private listener: ((payload: Buffer) => void) | null = null
  private listenerError: ((err: Error) => void) | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      let connectSettled = false
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
        sock.close()
        reject(failure)
      })
      sock.on('message', (msg) => {
        const payload = Buffer.from(msg)
        const listener = this.listener
        if (listener) { listener(payload); return }
        const waiter = this.waiter
        if (waiter) { this.waiter = null; this.failWaiter = null; waiter(payload) }
        else { this.queue.push(payload) }
      })
      sock.bind(0, () => { this.socket = sock; connectSettled = true; resolve() })
    })
  }

  /**
   * Records a socket failure and tells whoever is waiting on this transport.
   *
   * The socket is deliberately not closed here, mirroring TcpTransport: the
   * owner closes it, and a transport that closed itself would turn a reported
   * failure back into a silent one for anything that looked afterwards.
   */
  private fail(err: Error): void {
    this.failure = err
    const failWaiter = this.failWaiter
    if (failWaiter) {
      this.waiter = null
      this.failWaiter = null
      failWaiter(err)
    }
    const listenerError = this.listenerError
    if (listenerError) listenerError(err)
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
    if (this.listener) {
      return Promise.reject(
        new ZkConnectionError('this transport is listening for events; receive() is not available'),
      )
    }
    if (this.waiter) {
      return Promise.reject(
        new ZkConnectionError(
          'a receive() is already pending; this transport does not support concurrent receives',
        ),
      )
    }
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        this.failWaiter = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiter = (payload) => { clearTimeout(timer); resolve(payload) }
      this.failWaiter = (err) => { clearTimeout(timer); reject(err) }
    })
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    if (this.listener) {
      throw new ZkConnectionError('this transport is already listening')
    }
    if (this.waiter) {
      throw new ZkConnectionError('cannot listen while a receive() is pending')
    }
    this.listener = onPacket
    // Called on a socket-level failure — a send that the OS refuses, the
    // socket erroring after bind. UDP still has no connection to lose, so a
    // dead DEVICE remains indistinguishable from a quiet one and is what
    // SubscribeOptions.idleTimeoutMs exists for; a dead SOCKET is not the
    // same thing and must not be silence.
    this.listenerError = onError
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
    // A failure recorded before listen() would otherwise never be reported:
    // a listener attached over a dead socket that then waits forever is a
    // hang, not a failure.
    if (this.failure) onError(this.failure)
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
