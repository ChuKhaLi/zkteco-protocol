import { decodePayload } from '../codec/packet.js'
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

  private record(direction: TraceDirection, payload?: Buffer, err?: Error): void {
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
    if (err) {
      event.errorClass = err.constructor.name
      event.errorMessage = err.message
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
    this.record('send', payload)
    try {
      await this.inner.send(payload)
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
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
