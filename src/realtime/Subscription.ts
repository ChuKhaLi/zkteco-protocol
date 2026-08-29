import { decodeRealtimeEvent, isEventPacket } from '../codec/events.js'
import { ZkProtocolError, ZkTimeoutError } from '../errors.js'
import type { DecodedPacket } from '../codec/packet.js'
import type { Session } from '../session/Session.js'
import type { ZkRealtimeEvent } from '../types.js'

/** Events held while the consumer is behind, before the stream gives up. */
export const DEFAULT_BUFFER_LIMIT = 256

export interface SubscribeOptions {
  /** Bitmask of EVENT_FLAG values. Defaults to EVENT_FLAG.ATTENDANCE. */
  events?: number
  /** Events buffered while the consumer is behind. Defaults to 256. */
  bufferLimit?: number
  /**
   * Ends the stream when no event arrives for this long. Off by default, and
   * that default is deliberate: nobody badges at 03:00, so a default idle
   * timeout would kill healthy subscriptions nightly and teach consumers to
   * ignore the error.
   */
  idleTimeoutMs?: number
}

/**
 * A live subscription to a device's events.
 *
 * An async iterable rather than an event emitter, so a lost connection cannot
 * be ignored: it throws out of the `for await`. An emitter's 'error' needs one
 * stray listener anywhere to become silence.
 *
 * The stream does NOT reconnect and does NOT backfill. Realtime complements
 * polling rather than replacing it, so the next poll is the recovery; a silent
 * reconnect would claim a completeness guarantee that cannot be honoured,
 * since a device buffers nothing for a subscriber that went away.
 */
export interface ZkEventStream extends AsyncIterable<ZkRealtimeEvent> {
  close(): Promise<void>
}

/**
 * Exported because it appears in `Subscription`'s constructor signature —
 * TypeScript refuses to emit a declaration naming a type it cannot reach.
 * Exported from this module only; it is not part of the published API.
 */
export interface ResolvedOptions {
  events: number
  bufferLimit: number
  idleTimeoutMs: number
}

export class Subscription implements ZkEventStream {
  private readonly queue: ZkRealtimeEvent[] = []
  private waiter: ((result: IteratorResult<ZkRealtimeEvent>) => void) | null = null
  private rejectWaiter: ((err: Error) => void) | null = null
  private failure: Error | null = null
  private ended = false
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly session: Session,
    private readonly opts: ResolvedOptions,
  ) {
    this.armIdleTimer()
  }

  /** Accepts one packet the transport pushed. Never throws. */
  push(pkt: DecodedPacket): void {
    if (this.ended) return
    if (!isEventPacket(pkt)) {
      // Deliberately strict: while listening, nothing else should arrive. If
      // something does, this library's model of the connection is wrong, and
      // continuing means guessing which packets mean what.
      this.fail(
        new ZkProtocolError(
          `a non-event packet (command ${pkt.command}) arrived on a listening connection`,
        ),
      )
      return
    }
    this.armIdleTimer()
    const event = decodeRealtimeEvent(pkt)
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      this.rejectWaiter = null
      waiter({ value: event, done: false })
      return
    }
    this.queue.push(event)
    if (this.queue.length > this.opts.bufferLimit) {
      this.fail(
        new ZkProtocolError(
          `event buffer of ${this.opts.bufferLimit} overflowed; the consumer is not keeping up`,
        ),
      )
    }
  }

  /**
   * Ends the stream with an error.
   *
   * Events already queued are still delivered first — losing readings that
   * arrived intact, because the connection died afterwards, would be worse
   * than reporting the failure a few iterations later.
   */
  fail(err: Error): void {
    if (this.ended) return
    this.ended = true
    this.clearIdleTimer()
    this.failure = err
    const waiter = this.waiter
    const reject = this.rejectWaiter
    if (waiter && this.queue.length === 0) {
      // A waiting consumer has nothing queued to drain, so it fails now.
      this.waiter = null
      this.rejectWaiter = null
      reject?.(err)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ZkRealtimeEvent> {
    return {
      next: (): Promise<IteratorResult<ZkRealtimeEvent>> => {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        if (this.failure) return Promise.reject(this.failure)
        if (this.ended || this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<ZkRealtimeEvent>>((resolve, reject) => {
          this.waiter = resolve
          this.rejectWaiter = reject
        })
      },
    }
  }

  /** Ends the subscription and the connection it rides on. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.ended = true
    this.clearIdleTimer()
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      this.rejectWaiter = null
      waiter({ value: undefined, done: true })
    }
    await this.session.close()
  }

  private armIdleTimer(): void {
    if (this.opts.idleTimeoutMs <= 0) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.fail(new ZkTimeoutError(`no event within ${this.opts.idleTimeoutMs}ms`))
    }, this.opts.idleTimeoutMs)
    // Never hold the process open for a timer whose only job is to give up.
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
