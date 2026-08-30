import { decodeRealtimeEvent, isEventPacket } from '../codec/events.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../errors.js'
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
  /**
   * Stored, and deliberately never read here: the DEVICE filters by the mask
   * registered with CMD_REG_EVENT, and this library does not filter again
   * client-side. An event outside the requested mask is a real observation
   * about the device — it is on the first-hardware checklist — and dropping
   * it here would hide the answer.
   */
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
        if (this.waiter) {
          // There is one waiter slot. A second concurrent next() would
          // overwrite the first and orphan its promise forever, so it is
          // refused instead — the same choice, and the same error, the
          // transports make for a concurrent receive().
          return Promise.reject(
            new ZkConnectionError(
              'a next() is already pending; this stream does not support concurrent iteration',
            ),
          )
        }
        return new Promise<IteratorResult<ZkRealtimeEvent>>((resolve, reject) => {
          this.waiter = resolve
          this.rejectWaiter = reject
        })
      },

      /**
       * Called by `for await` when the consumer leaves the loop early — a
       * break, a return, or an exception raised in the loop BODY. Without it,
       * the obvious consumer loop (take a few events, then break) leaves the
       * subscription registered and the socket under it open, with the device
       * still pushing events to nobody.
       *
       * Ending the stream here means ending the connection it rides on, and
       * that is the right scope rather than an overreach: this stream does not
       * reconnect and a device buffers nothing for a subscriber that went
       * away, so there is no resumable state to preserve. close() is
       * idempotent, so a consumer that breaks and then calls close() anyway
       * pays nothing.
       *
       * A rejection from next() does NOT route here — the language calls
       * return() only for an early exit from a loop that is otherwise healthy.
       * That is correct: fail() has already ended the stream by then.
       *
       * No throw(). `for await` never calls it; only explicit generator
       * delegation does, and this iterator is not written by a generator.
       */
      return: async (): Promise<IteratorResult<ZkRealtimeEvent>> => {
        await this.close()
        return { value: undefined, done: true }
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
