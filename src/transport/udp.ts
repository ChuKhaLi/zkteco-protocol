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

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
