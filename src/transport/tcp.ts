import net from 'node:net'
import { frameTcp, tryUnframeTcp } from '../codec/framing.js'
import { ZkConnectionError } from '../errors.js'
import { PacketInbox } from './inbox.js'
import type { Transport, TransportOptions } from './Transport.js'

/** Idle milliseconds before the OS probes a listening connection. */
const KEEPALIVE_DELAY_MS = 30_000

export class TcpTransport implements Transport {
  private socket: net.Socket | null = null
  /** Bytes arrived but not yet consumed as complete packets. */
  private buffered = Buffer.alloc(0)
  private readonly inbox = new PacketInbox()
  private failure: Error | null = null

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
      this.inbox.deliver(framed.payload)
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
   * The failure kept is the FIRST one: a socket 'error' is followed by a 'close',
   * and the close message says nothing the error did not.
   *
   * UdpTransport forgets a failure once it has been delivered, because a UDP
   * socket has no connection to lose and stays usable after an error about a
   * single datagram. See the decision rule on UdpTransport.fail; the
   * difference is a considered one, not drift.
   */
  private fail(err: Error): void {
    // First failure wins. A socket 'error' is followed by 'close', and a
    // framing failure (Task 5) by the destroy it triggers; the first event
    // is the cause and the second is its consequence.
    this.failure ??= err
    this.inbox.notify(err)
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
    return this.inbox.receive(timeoutMs, () => this.failure)
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    this.inbox.listen(onPacket, onError, () => this.failure)
    // A dead peer on a listening connection is otherwise indistinguishable
    // from a quiet one, and a quiet one is normal at 03:00.
    this.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS)
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
