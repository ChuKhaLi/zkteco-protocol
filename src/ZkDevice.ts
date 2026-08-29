import { getAttendanceLogs, type GetAttendanceOptions } from './commands/attendance.js'
import { getInfo } from './commands/info.js'
import { getUsers } from './commands/users.js'
import { EVENT_FLAG } from './codec/events.js'
import { ZkConnectionError } from './errors.js'
import { DEFAULT_BUFFER_LIMIT, Subscription, type SubscribeOptions, type ZkEventStream } from './realtime/Subscription.js'
import { Session } from './session/Session.js'
import { TcpTransport } from './transport/tcp.js'
import { UdpTransport } from './transport/udp.js'
import type { Transport } from './transport/Transport.js'
import type { ZkAttendanceLog, ZkDeviceInfo, ZkUser } from './types.js'

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
   * Safe to call again on an already-connected instance: any existing session
   * is closed first, so a second connect() cannot leak the first socket.
   */
  async connect(): Promise<void> {
    this.stream = null
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
   */
  async subscribe(opts?: SubscribeOptions): Promise<ZkEventStream> {
    const session = this.requireIdleSession()
    const resolved = {
      events: opts?.events ?? EVENT_FLAG.ATTENDANCE,
      bufferLimit: opts?.bufferLimit ?? DEFAULT_BUFFER_LIMIT,
      idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
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
