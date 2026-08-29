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
  private listener: ((payload: Buffer) => void) | null = null
  private listenerError: ((err: Error) => void) | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      sock.once('error', (err) => {
        sock.close()
        reject(new ZkConnectionError(err.message))
      })
      sock.on('message', (msg) => {
        const payload = Buffer.from(msg)
        const listener = this.listener
        if (listener) { listener(payload); return }
        const waiter = this.waiter
        if (waiter) { this.waiter = null; waiter(payload) } else { this.queue.push(payload) }
      })
      sock.bind(0, () => { this.socket = sock; resolve() })
    })
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiter = (payload) => { clearTimeout(timer); resolve(payload) }
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
    // Retained for symmetry with TCP and for a future datagram error path.
    // UDP has no connection to lose, so nothing calls it today: a dead device
    // is indistinguishable from a quiet one here, which is what
    // SubscribeOptions.idleTimeoutMs exists for.
    this.listenerError = onError
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
