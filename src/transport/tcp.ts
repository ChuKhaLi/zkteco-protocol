import net from 'node:net'
import { frameTcp, tryUnframeTcp } from '../codec/framing.js'
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'
import type { Transport, TransportOptions } from './Transport.js'

/** Idle milliseconds before the OS probes a listening connection. */
const KEEPALIVE_DELAY_MS = 30_000

export class TcpTransport implements Transport {
  private socket: net.Socket | null = null
  /** Bytes arrived but not yet consumed as complete packets. */
  private buffered = Buffer.alloc(0)
  /** Complete payloads ready to hand to `receive`. */
  private queue: Buffer[] = []
  private waiter: ((payload: Buffer) => void) | null = null
  private failure: Error | null = null
  private failWaiter: ((err: Error) => void) | null = null
  private listener: ((payload: Buffer) => void) | null = null
  private listenerError: ((err: Error) => void) | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port })
      const onError = (err: Error): void => {
        sock.destroy()
        reject(new ZkConnectionError(`cannot connect to ${this.opts.host}:${this.opts.port}: ${err.message}`))
      }
      sock.once('error', onError)
      sock.once('connect', () => {
        sock.off('error', onError)
        this.socket = sock
        sock.on('data', (chunk) => this.absorb(chunk))
        sock.on('error', (err) => this.fail(new ZkConnectionError(err.message)))
        sock.on('close', () => this.fail(new ZkConnectionError('connection closed by peer')))
        resolve()
      })
    })
  }

  /**
   * TCP splits and coalesces freely, so bytes are accumulated and only
   * surfaced once the length prefix says a whole packet has arrived. Several
   * packets can emerge from one chunk.
   */
  private absorb(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk])
    for (;;) {
      let framed
      try {
        framed = tryUnframeTcp(this.buffered)
      } catch (err) {
        // Release the accumulator along with failing the connection. The
        // bytes cannot be re-parsed — the frame they belong to was rejected —
        // and holding them keeps a rejected oversized length costing memory
        // for the life of the object.
        this.buffered = Buffer.alloc(0)
        this.fail(err as Error)
        return
      }
      if (!framed) return
      this.buffered = this.buffered.subarray(framed.consumed)
      const listener = this.listener
      if (listener) {
        listener(framed.payload)
        continue
      }
      const waiter = this.waiter
      if (waiter) {
        this.waiter = null
        this.failWaiter = null
        waiter(framed.payload)
      } else {
        this.queue.push(framed.payload)
      }
    }
  }

  /**
   * Records a socket failure and tells whoever is waiting on this transport.
   *
   * The failure is kept for the life of the object, deliberately, and this is
   * where TcpTransport and UdpTransport part company. A TCP failure means the
   * connection is gone — 'close' and 'error' both route here — so every later
   * receive() on this transport really is doomed, and answering each one with
   * the reason is the most useful thing it can do.
   *
   * UdpTransport forgets a failure once it has been delivered, because a UDP
   * socket has no connection to lose and stays usable after an error about a
   * single datagram. See the decision rule on UdpTransport.fail; the
   * difference is a considered one, not drift.
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
      sock.write(frameTcp(payload), (err) =>
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
    this.listenerError = onError
    // A dead peer on a listening connection is otherwise indistinguishable
    // from a quiet one, and a quiet one is normal at 03:00.
    this.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS)
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
    if (this.failure) onError(this.failure)
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => {
      sock.removeAllListeners('close')
      sock.end(() => { sock.destroy(); resolve() })
    })
  }
}
