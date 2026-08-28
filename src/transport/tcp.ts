import net from 'node:net'
import { frameTcp, tryUnframeTcp } from '../codec/framing.js'
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'
import type { Transport, TransportOptions } from './Transport.js'

export class TcpTransport implements Transport {
  private socket: net.Socket | null = null
  /** Bytes arrived but not yet consumed as complete packets. */
  private buffered = Buffer.alloc(0)
  /** Complete payloads ready to hand to `receive`. */
  private queue: Buffer[] = []
  private waiter: ((payload: Buffer) => void) | null = null
  private failure: Error | null = null
  private failWaiter: ((err: Error) => void) | null = null

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
        this.fail(err as Error)
        return
      }
      if (!framed) return
      this.buffered = this.buffered.subarray(framed.consumed)
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

  private fail(err: Error): void {
    this.failure = err
    const failWaiter = this.failWaiter
    if (failWaiter) {
      this.waiter = null
      this.failWaiter = null
      failWaiter(err)
    }
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
