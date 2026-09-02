import { ZkConnectionError, ZkTimeoutError } from '../errors.js'

interface Pending {
  resolve: (payload: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface Listener {
  onPacket: (payload: Buffer) => void
  onError: (err: Error) => void
}

/**
 * The receive-side state machine both transports share: complete payloads
 * waiting to be claimed, at most one pending `receive()`, and at most one
 * listener once `listen()` has flipped the socket to push mode.
 *
 * `pending` is one object or null, so a resolve without its reject cannot be
 * expressed. Before this class the two callbacks were separate nullable
 * fields set and cleared together at six sites per transport, and the whole
 * forty-five lines existed twice (spec v0.5 §4.1).
 *
 * `held` is a thunk, not a value: UdpTransport reads AND clears its recorded
 * failure in one step, and that must happen only at the point this inbox
 * would use it — after the guards — or a refused receive() would consume a
 * failure meant for the next consumer.
 */
export class PacketInbox {
  private queue: Buffer[] = []
  private pending: Pending | null = null
  private listener: Listener | null = null

  get listening(): boolean {
    return this.listener !== null
  }

  /** A complete payload arrived: listener first, then a pending receive, then the queue. */
  deliver(payload: Buffer): void {
    if (this.listener) {
      this.listener.onPacket(payload)
      return
    }
    const pending = this.takePending()
    if (pending) {
      pending.resolve(payload)
      return
    }
    this.queue.push(payload)
  }

  receive(timeoutMs: number, held: () => Error | null): Promise<Buffer> {
    if (this.listener) {
      return Promise.reject(
        new ZkConnectionError('this transport is listening for events; receive() is not available'),
      )
    }
    if (this.pending) {
      return Promise.reject(
        new ZkConnectionError(
          'a receive() is already pending; this transport does not support concurrent receives',
        ),
      )
    }
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    const failure = held()
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = { resolve, reject, timer }
    })
  }

  listen(
    onPacket: (payload: Buffer) => void,
    onError: (err: Error) => void,
    held: () => Error | null,
  ): void {
    if (this.listener) throw new ZkConnectionError('this transport is already listening')
    if (this.pending) throw new ZkConnectionError('cannot listen while a receive() is pending')
    this.listener = { onPacket, onError }
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
    const failure = held()
    if (failure) onError(failure)
  }

  /** Tells whoever is waiting. Returns whether anyone was. */
  notify(err: Error): boolean {
    const pending = this.takePending()
    if (pending) {
      pending.reject(err)
      return true
    }
    if (this.listener) {
      this.listener.onError(err)
      return true
    }
    return false
  }

  /** Rejects a pending receive, if any. For close(). */
  settle(err: Error): void {
    const pending = this.takePending()
    if (pending) pending.reject(err)
  }

  /** Drops queued payloads. For a framing failure, after which nothing queued belongs to a live exchange. */
  clear(): void {
    this.queue = []
  }

  private takePending(): Pending | null {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    return pending
  }
}
