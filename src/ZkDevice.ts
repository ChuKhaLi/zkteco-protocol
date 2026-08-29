import { getAttendanceLogs, type GetAttendanceOptions } from './commands/attendance.js'
import { getIdentity, getParameters, getTime } from './commands/device.js'
import { getInfo } from './commands/info.js'
import { getUsers } from './commands/users.js'
import { EVENT_FLAG } from './codec/events.js'
import { ZkConnectionError } from './errors.js'
import { DEFAULT_BUFFER_LIMIT, Subscription, type SubscribeOptions, type ZkEventStream } from './realtime/Subscription.js'
import { Session } from './session/Session.js'
import { TcpTransport } from './transport/tcp.js'
import { UdpTransport } from './transport/udp.js'
import type { Transport } from './transport/Transport.js'
import type { ZkAttendanceLog, ZkDeviceInfo, ZkDeviceIdentity, ZkNaiveTime, ZkUser } from './types.js'

export interface ZkDeviceOptions {
  host: string
  /** Defaults to 4370. */
  port?: number
  /**
   * Defaults to 'tcp'. TCP frames packets with a length prefix, so it is the
   * more reliable of the two; UDP is a fallback for firmware that needs it.
   */
  transport?: 'tcp' | 'udp'
  /** Device comm key. 0, the default, means unset. */
  commKey?: number
  /** Per-request deadline. Defaults to 5000ms. */
  timeoutMs?: number
}

export class ZkDevice {
  private session: Session | null = null
  private stream: Subscription | null = null
  private readonly host: string
  private readonly port: number
  private readonly transportKind: 'tcp' | 'udp'
  private readonly commKey: number
  private readonly timeoutMs: number

  constructor(opts: ZkDeviceOptions) {
    this.host = opts.host
    this.port = opts.port ?? 4370
    this.transportKind = opts.transport ?? 'tcp'
    this.commKey = opts.commKey ?? 0
    this.timeoutMs = opts.timeoutMs ?? 5_000
  }

  private makeTransport(): Transport {
    const opts = { host: this.host, port: this.port }
    return this.transportKind === 'tcp' ? new TcpTransport(opts) : new UdpTransport(opts)
  }

  private requireSession(): Session {
    if (!this.session) throw new ZkConnectionError('not connected — call connect() first')
    return this.session
  }

  /**
   * A session that can still answer requests.
   *
   * One ZkDevice owns one connection and is in exactly one mode. A consumer
   * that needs to poll and listen at once constructs two instances, which
   * makes "open a second connection to this device" a visible decision rather
   * than an assumption buried here — the number of concurrent connections a
   * device accepts has never been observed.
   */
  private requireIdleSession(): Session {
    const session = this.requireSession()
    if (session.subscribed) {
      throw new ZkConnectionError(
        'this device is subscribed to realtime events; close the stream, or use a separate ZkDevice to read',
      )
    }
    return session
  }

  /**
   * Handshakes, authenticating with the comm key when the device asks.
   *
   * Safe to call again on an already-connected instance: any existing
   * subscription is ended and any existing session is closed first, so a
   * second connect() cannot leak the first socket, nor leave a caller's
   * earlier stream awaiting an event that will never arrive.
   */
  async connect(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
    if (this.session) {
      await this.session.close()
      this.session = null
    }
    const session = new Session(this.makeTransport(), {
      timeoutMs: this.timeoutMs,
      commKey: this.commKey,
    })
    await session.open()
    this.session = session
  }

  async getInfo(): Promise<ZkDeviceInfo> {
    return getInfo(this.requireIdleSession())
  }

  /**
   * Reads what the device says about itself: serial number, name, platform,
   * OS and firmware version.
   *
   * Five sequential round trips. A field is `null` when the device REFUSED
   * that keyword — never when the read failed, which throws instead. Which
   * keywords a given firmware exposes is model-dependent and unverified.
   *
   * Named getIdentity rather than getDeviceInfo because ZkDeviceInfo already
   * means the storage counters that getInfo() returns.
   */
  async getIdentity(): Promise<ZkDeviceIdentity> {
    return getIdentity(this.requireIdleSession())
  }

  /**
   * Reads named device parameters.
   *
   * A key the device refused is absent from the result; a key it answered
   * with no value is present as ''. Use DEVICE_PARAM for the keywords that
   * have been observed, or pass any string.
   */
  async getParameters(keys: readonly string[]): Promise<Record<string, string>> {
    return getParameters(this.requireIdleSession(), keys)
  }

  /**
   * Reads the device's own clock, as naive local time with no offset.
   *
   * Useful mainly for detecting drift: a device whose clock has slipped
   * produces attendance timestamps that look wrong for no visible reason.
   * Setting the clock is a write path and is deliberately not implemented.
   */
  async getTime(): Promise<ZkNaiveTime> {
    return getTime(this.requireIdleSession())
  }

  async getUsers(): Promise<ZkUser[]> {
    return getUsers(this.requireIdleSession(), this.transportKind)
  }

  /**
   * Reads the attendance log.
   *
   * The device is never disabled first. Many implementations send
   * CMD_DISABLEDEVICE before a bulk read so the buffer cannot shift
   * mid-transfer; on a polling schedule that locks employees out of badging
   * every cycle. The interleaved-write risk is accepted instead, and the
   * framing guard refuses anything that does not add up.
   */
  async getAttendanceLogs(opts?: GetAttendanceOptions): Promise<ZkAttendanceLog[]> {
    return getAttendanceLogs(this.requireIdleSession(), this.transportKind, opts)
  }

  /**
   * Subscribes to the events the device pushes.
   *
   * The stream does not reconnect and does not backfill: realtime complements
   * polling rather than replacing it, so a dropped connection ends the stream
   * loudly and the next poll recovers whatever was missed.
   *
   * While subscribed this device answers no read commands. Closing the stream
   * closes the connection; call connect() again to read.
   *
   * Always close the stream — `try { for await ... } finally { close() }`.
   * That includes the error path: a stream that ended with an error stops
   * delivering but does NOT release the connection, which stays open with a
   * listener attached until close() or disconnect() is called.
   */
  async subscribe(opts?: SubscribeOptions): Promise<ZkEventStream> {
    const session = this.requireIdleSession()
    const resolved = {
      events: opts?.events ?? EVENT_FLAG.ATTENDANCE,
      bufferLimit: opts?.bufferLimit ?? DEFAULT_BUFFER_LIMIT,
      idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
    }
    // Checked before anything is sent, so a rejected option costs no
    // registration on the device. `??` only fills in null and undefined, so
    // `bufferLimit: 0` survives it intact and then overflows the stream on
    // the very first event — a bound of zero bounds nothing, it just breaks.
    // Negative and non-finite go the same way, and NaN would slip past a bare
    // `<= 0` because every comparison against it is false, so the finiteness
    // test comes first. RangeError, not a Zk* class: these are bad arguments
    // from the caller, not anything the device did, and the published error
    // taxonomy stays as v0.1 shipped it.
    if (!Number.isFinite(resolved.bufferLimit) || resolved.bufferLimit <= 0) {
      throw new RangeError(`bufferLimit must be a positive number, got ${String(opts?.bufferLimit)}`)
    }
    if (!Number.isFinite(resolved.idleTimeoutMs) || resolved.idleTimeoutMs < 0) {
      throw new RangeError(
        `idleTimeoutMs must be a non-negative number, got ${String(opts?.idleTimeoutMs)}`,
      )
    }
    const subscription = new Subscription(session, resolved)
    await session.subscribe(
      resolved.events,
      (pkt) => subscription.push(pkt),
      (err) => subscription.fail(err),
    )
    this.stream = subscription
    return subscription
  }

  /** Closes the session. Safe to call twice, and safe before connect(). */
  async disconnect(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
    const session = this.session
    this.session = null
    if (session) await session.close()
  }
}
