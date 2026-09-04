import { decodePayload } from '../codec/packet.js'
import { ZkError } from '../errors.js'
import type { Transport } from '../transport/Transport.js'
import type { TraceDirection, TraceEvent } from './types.js'

/**
 * Records every payload this library sends and receives.
 *
 * A decorator over `Transport` rather than a hook inside the transports: it
 * changes neither the published surface nor the two most delicate files in
 * this repository (design spec §3.3). It observes payloads, not wire bytes —
 * TCP framing is applied inside TcpTransport.send — which costs nothing,
 * because checksums are computed over payloads and both throw sites in
 * tryUnframeTcp already attach the rejected 8-byte prefix as the error's raw
 * hex.
 *
 * It holds no policy. It records; deciding what is interesting is the probe's
 * job.
 *
 * `now` is injected rather than read from Date.now() so that offsets are
 * deterministic under test and so that clock access stays confined to
 * src/cli.ts.
 */
export class TracingTransport implements Transport {
  private readonly log: TraceEvent[] = []
  private seq = 0
  private readonly start: number

  constructor(
    private readonly inner: Transport,
    private readonly now: () => number,
  ) {
    this.start = now()
  }

  get events(): readonly TraceEvent[] {
    return this.log
  }

  /**
   * Builds a complete `error` event, including the rejected framing prefix
   * when the error carried one.
   *
   * A framing failure attaches the rejected 8-byte prefix as err.raw. The raw
   * capture is unredacted by contract (kit spec §5.4) and TraceEvent reaches
   * nothing else, so the prefix goes into the record here — this is the file
   * item 5's observation points the operator at.
   */
  private errorEvent(err: Error): TraceEvent {
    const event: TraceEvent = {
      seq: this.seq++,
      direction: 'error',
      offsetMs: this.now() - this.start,
      errorClass: err.constructor.name,
      errorMessage: err.message,
    }
    if (err instanceof ZkError && err.raw) event.hex = err.raw
    return event
  }

  private record(direction: TraceDirection, payload?: Buffer, err?: Error): void {
    if (err) {
      this.log.push(this.errorEvent(err))
      return
    }
    const event: TraceEvent = {
      seq: this.seq++,
      direction,
      offsetMs: this.now() - this.start,
    }
    if (payload) {
      event.hex = payload.toString('hex')
      // A payload too short or malformed to decode is still evidence, so a
      // decode failure must not lose the bytes or throw out of a socket
      // handler. The hex above is already recorded either way.
      try {
        const pkt = decodePayload(payload)
        event.command = pkt.command
        event.sessionId = pkt.sessionId
        event.replyId = pkt.replyId
      } catch {
        // Intentionally empty: hex is the record that matters.
      }
    }
    this.log.push(event)
  }

  async connect(timeoutMs: number): Promise<void> {
    try {
      await this.inner.connect(timeoutMs)
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  async send(payload: Buffer): Promise<void> {
    try {
      await this.inner.send(payload)
    } catch (err) {
      // Recorded as an error and NOT as a send: nothing moved. bulkPrepareAttempted
      // (item 19) reads `send` events, and a write the socket refused is not
      // evidence the device saw an odd-length payload.
      const event = this.errorEvent(err as Error)
      try {
        event.attemptedCommand = decodePayload(payload).command
      } catch {
        // an undecodable payload is still an attempt; the class and message say so
      }
      this.log.push(event)
      throw err
    }
    this.record('send', payload)
  }

  async receive(timeoutMs: number): Promise<Buffer> {
    try {
      const payload = await this.inner.receive(timeoutMs)
      this.record('recv', payload)
      return payload
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    try {
      this.inner.listen(
        (payload) => {
          this.record('push', payload)
          onPacket(payload)
        },
        (err) => {
          this.record('error', undefined, err)
          onError(err)
        },
      )
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
