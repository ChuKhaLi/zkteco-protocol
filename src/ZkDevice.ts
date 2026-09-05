import { getAttendanceLogs, type GetAttendanceOptions } from './commands/attendance.js'
import { getIdentity, getParameters, getTime } from './commands/device.js'
import { getInfo } from './commands/info.js'
import { readUserStream } from './commands/users.js'
import { EVENT_FLAG } from './codec/events.js'
import { parseUserData } from './codec/records/user.js'
import { ZkConnectionError, ZkError } from './errors.js'
import { DEFAULT_BUFFER_LIMIT, Subscription, type SubscribeOptions, type ZkEventStream } from './realtime/Subscription.js'
import { Session } from './session/Session.js'
import { createTransport } from './transport/createTransport.js'
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
  private connecting: Promise<void> | null = null
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
    return createTransport(this.transportKind, { host: this.host, port: this.port })
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
   * earlier stream awaiting an event that will never arrive. Safe to call
   * again while a previous call — or any number of them — is still in
   * flight, too: every connect() chains on the one before it, so
   * overlapping calls run strictly in order and each closes what the
   * previous one opened rather than racing it or leaking it. A
   * disconnect() issued at any point during a connect() — including during
   * this cleanup — closes whatever that connect() opened rather than
   * letting it install after disconnect() has already returned.
   */
  async connect(): Promise<void> {
    // Every connect() chains on the one before it, so any number of
    // overlapping calls run strictly in order and each closes what the
    // previous one opened. Tracked from the first statement, before any
    // await: a disconnect() issued at any point sees the latest connect.
    const prior = this.connecting
    const opening = (async () => {
      if (prior) await prior.catch(() => {})
      await this.connectSequence()
    })()
    this.connecting = opening
    try {
      await opening
    } finally {
      if (this.connecting === opening) this.connecting = null
    }
  }

  private async connectSequence(): Promise<void> {
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
   *
   * Returns a null-prototype object, so `key in result` is correct even for a
   * key that collides with an Object.prototype member name (e.g. 'toString')
   * — a plain object would report `true` there via the prototype chain even
   * though the device never answered. The cost: `result.hasOwnProperty(key)`
   * throws, because there is no `hasOwnProperty` on the prototype chain to
   * call. Use `key in result`, or `Object.hasOwn(result, key)`.
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

  /**
   * Reads the enrolled user list.
   *
   * The list is transferred FIRST and the device's user count asked for
   * afterwards, even though the count is what decides the record width
   * (codec/records/user.ts). The count is what lets a legitimate 72-byte
   * device with a multiple of seven users be read at all, since 7 x 72 and
   * 18 x 28 are the same 504 bytes — but asking for it first meant a device
   * that would not answer CMD_GET_FREE_SIZES lost the user list too, because
   * the failed count had already taken the session down. Bytes in hand cannot
   * be lost to a count that never arrives.
   *
   * `getAttendanceLogs` is NOT the same shape, though an earlier draft of this
   * comment said it was: it reads the count before its own transfer and again
   * after, and the value it hands to getUsers is read before the USER transfer,
   * not after it. It also has no swallow — a failed getInfo aborts the whole
   * call — so it offers no degradation guarantee to compare against. The
   * ordering below is this method's own.
   */
  async getUsers(): Promise<ZkUser[]> {
    const session = this.requireIdleSession()
    const stream = await readUserStream(session, this.transportKind)
    // Swallowed deliberately, and only here. "No count" is a defined
    // behaviour, not a guess: the parse falls back to 72-byte records for
    // every body length that is not ambiguous, so a device whose free-sizes
    // reply is broken keeps a working user list.
    //
    // Two things this swallow does NOT do, both worth stating because the
    // comment here once claimed otherwise:
    //
    // 1. It does not keep the session alive. ZkTimeoutError, ZkFramingError
    //    and ZkConnectionError each end the session in Session.exchange (spec
    //    v0.5 section 5.2), and that happens before this catch runs. Only
    //    ZkAuthError and ZkProtocolError -- the device ANSWERED, with
    //    ACK_UNAUTH or ACK_ERROR -- leave a session that still works. So this
    //    call can return a full user list and leave the session dead behind
    //    it, and the caller's next ZkDevice call fails with "this session is
    //    not open". That is the deliberate trade: the list is worth more than
    //    the session, and connect() restores the session. It does mean the
    //    swallow hides a state change from the caller.
    // 2. It does not make the count trustworthy, only optional. A count that
    //    arrives from a wrong FREE_SIZES_OFFSET is used as-is; see
    //    PROVENANCE.md, "What deriving it cost".
    // 3. It does not swallow everything. Only a ZkError degrades. Every
    //    failure Session.exchange can produce is one, so this narrowing moves
    //    no device-facing behaviour at all -- points 1 and 2 above are as true
    //    after it as before. What it stops is a TypeError or RangeError raised
    //    inside getInfo, which is a bug in this library rather than a device
    //    declining to answer, being turned into "no count" and handed back as
    //    a user list nobody knows was assembled under a broken read.
    let userCount: number | null = null
    try {
      userCount = (await getInfo(session)).userCount
    } catch (err) {
      if (!(err instanceof ZkError)) throw err
      userCount = null
    }
    return parseUserData(stream, userCount)
  }

  /**
   * Reads the attendance log.
   *
   * The device is never disabled first. Many implementations send
   * CMD_DISABLEDEVICE before a bulk read so the buffer cannot shift
   * mid-transfer; on a polling schedule that locks employees out of badging
   * every cycle. The interleaved-write risk is met by reading the record
   * count on both sides of the transfer and refusing if it moved; the
   * framing guard on its own cannot see a count that is stale by a divisor.
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
    subscription.start()
    this.stream = subscription
    return subscription
  }

  /** Closes the session. Safe to call twice, before connect(), and during it. */
  async disconnect(): Promise<void> {
    // A connect() still opening finishes first, so the session it installs
    // is the one closed here rather than one installed after this returns.
    const connecting = this.connecting
    if (connecting) await connecting.catch(() => {})
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
    const session = this.session
    this.session = null
    if (session) await session.close()
  }
}
