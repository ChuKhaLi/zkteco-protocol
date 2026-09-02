import { CMD } from '../codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../codec/packet.js'
import { mixCommKey } from '../codec/commkey.js'
import { encodeEventMask, isEventPacket } from '../codec/events.js'
import { ZkAuthError, ZkConnectionError, ZkFramingError, ZkProtocolError, ZkTimeoutError } from '../errors.js'
import type { Transport } from '../transport/Transport.js'

export interface SessionOptions {
  timeoutMs: number
  /** Device comm key. 0 means unset. */
  commKey?: number
}

/** The error every request path raises for an ACK_UNAUTH reply, in one place so the wording cannot drift. */
export function unauthorizedReply(command: number, data: Buffer): ZkAuthError {
  return new ZkAuthError(
    `command ${command} answered ACK_UNAUTH: the device did not authorize this request`,
    data,
  )
}

/**
 * One request-response conversation with a device: session id acquisition,
 * reply-id sequencing, and per-request deadlines.
 */
export class Session {
  private currentSessionId = 0
  private replyId = 0
  private open_ = false
  private subscribed_ = false

  constructor(
    private readonly transport: Transport,
    private readonly opts: SessionOptions,
  ) {}

  get sessionId(): number {
    return this.currentSessionId
  }

  /** True once this session has switched its transport to listening. */
  get subscribed(): boolean {
    return this.subscribed_
  }

  /**
   * Handshakes and stores the session id the device issues.
   *
   * If the device answers CONNECT with ACK_UNAUTH, it is demanding a comm
   * key: the configured key is mixed against the session id it just issued
   * (per `mixCommKey`) and sent back as CMD_AUTH. No key configured, or a
   * key the device rejects, both surface as ZkAuthError.
   *
   * On any failure — refused handshake, rejected/missing comm key, or
   * timeout — the transport is torn down before the error propagates.
   * Nothing above this call ever manages to close a session that never
   * finished opening, so leaving that to the caller would leak the socket.
   */
  async open(): Promise<void> {
    await this.transport.connect(this.opts.timeoutMs)
    this.open_ = true
    try {
      const res = await this.send(CMD.CONNECT, undefined, { sessionId: 0 })

      if (res.command === CMD.ACK_UNAUTH) {
        const commKey = this.opts.commKey ?? 0
        if (commKey === 0) {
          throw new ZkAuthError('device requires a comm key but none was configured')
        }
        // The key is mixed against the session id the device just issued.
        this.currentSessionId = res.sessionId
        const auth = await this.send(CMD.AUTH, mixCommKey(commKey, res.sessionId))
        if (auth.command !== CMD.ACK_OK) {
          throw new ZkAuthError('device rejected the comm key')
        }
        this.currentSessionId = auth.sessionId
        return
      }

      if (res.command !== CMD.ACK_OK) {
        throw new ZkProtocolError(`handshake refused with command ${res.command}`)
      }
      this.currentSessionId = res.sessionId
    } catch (err) {
      this.open_ = false
      await this.transport.close().catch(() => {})
      throw err
    }
  }

  /**
   * Sends one command and returns the reply, ACK_ERROR included.
   *
   * For call sites where a device refusing the command is a normal answer
   * rather than a failure — reading a parameter keyword a firmware does not
   * expose, for instance. The alternative, catching ZkProtocolError around
   * execute(), would also swallow a genuine protocol error raised anywhere
   * below and turn it into a "the device said no". That is the defect shape
   * this project has caught nine times in v0.1 and again in v0.2: code that
   * reports success while proving less than it appears to.
   *
   * Only ACK_ERROR becomes readable here. A timeout, a dropped connection and
   * a malformed packet all still propagate.
   */
  async tryExecute(command: number, data?: Buffer): Promise<DecodedPacket> {
    this.assertOpen()
    return this.send(command, data)
  }

  /**
   * Sends one command and returns the reply.
   *
   * Throws on exactly two reply codes: ACK_ERROR as ZkProtocolError, and
   * ACK_UNAUTH as ZkAuthError. Every other reply is returned for the caller
   * to decode.
   *
   * ACK_UNAUTH acknowledges NOTHING, and every read in this library would
   * otherwise decode its body as an answer: getInfo() reads storage counters
   * out of any body of 68 bytes or more, decodeZkTime() turns any four bytes
   * into a plausible date, and readBulkBuffered() takes bytes 1-4 of a
   * five-byte PREPARE_BUFFER reply as a transfer size. The guard lives here
   * rather than at each call site because the bulk reads reach the device
   * through readBulk()'s internals -- READ_BUFFER, FREE_DATA -- where there
   * is no call site to guard, and because a rule kept in six places drifts.
   * readBulkBuffered()'s own PREPARE_BUFFER call is the one exception: it
   * calls tryExecute() and raises ACK_UNAUTH itself, through the
   * `unauthorizedReply` helper below (same wording, one definition), because
   * it is the one tryExecute caller that must not inherit readBulk()'s
   * catch-based fallback to the legacy path (spec v0.5 §6.2).
   *
   * open() and subscribe() use the private send() directly and are
   * deliberately unaffected: the comm-key handshake must keep reading
   * ACK_UNAUTH as the demand for a key that it is.
   *
   * ZkAuthError rather than ZkProtocolError, and the class carries weight
   * beyond naming. readBulk() falls back from the buffered commands to the
   * legacy exchange on exactly `err instanceof ZkProtocolError`, so an
   * ACK_UNAUTH classed as a protocol error is read as "this firmware does
   * not implement 1503" -- an authentication failure reported as a firmware
   * capability, and then retried down a path whose answer cannot be trusted,
   * because whatever comes back was produced after the device said this
   * session was not authorized. As a sibling class under ZkError it
   * propagates instead, which is what that path needs.
   *
   * Only ACK_UNAUTH is singled out. Tightening this to "only ACK_OK counts
   * as success" is deliberately NOT done: nothing confirms real firmware
   * acknowledges these commands with ACK_OK rather than, say, ACK_DATA, and
   * inventing that constraint would be exactly the kind of unevidenced
   * hypothesis this project avoids.
   */
  async execute(command: number, data?: Buffer): Promise<DecodedPacket> {
    const res = await this.tryExecute(command, data)
    if (res.command === CMD.ACK_ERROR) {
      throw new ZkProtocolError(`device rejected command ${command}`)
    }
    if (res.command === CMD.ACK_UNAUTH) {
      throw unauthorizedReply(command, res.data)
    }
    return res
  }

  /**
   * Registers for realtime events and switches the transport to listening.
   *
   * The registration itself is an ordinary request-response exchange, which
   * is why it runs before the mode flip and over the same socket. A refused
   * registration throws and leaves the session in request mode: firmware
   * without realtime support costs one call, not the connection.
   *
   * A DESYNCED registration is treated differently, and the asymmetry is
   * deliberate. If the device pushes an event in the window between reading
   * this request and writing its ack, that event consumes the pending waiter
   * and the real ACK_OK is stranded in the transport queue — where the NEXT
   * request would collect it as its own reply, and every reply after that
   * would be off by one. A refusal leaves nothing out of step, so the session
   * stays usable (design spec §3.4); a desync makes every later reply
   * silently wrong, which is the exact misroute §3.1 rejected the
   * multiplexing design to avoid. So the session is torn down here, before
   * the error propagates, and cannot be polled afterwards -- enforced by
   * `assertOpen` on this class's own request path, not left to the socket
   * being gone, which is where that guarantee used to actually live.
   *
   * Buffering the early event and replaying it onto the stream was considered
   * and rejected (RULING R11). It would preserve the punch, but only by
   * building a bounded version of that same router, resting on a
   * discrimination rule no device has ever confirmed. Spec §1.1 already
   * answers a lost event: polling is the source of truth, and the next poll
   * recovers it.
   *
   * Guarded before anything is sent: a second subscribe() used to transmit a
   * second REG_EVENT whose acknowledgment then arrived on the listening
   * socket and ended the live stream as "a non-event packet", blaming the
   * device.
   */
  async subscribe(
    mask: number,
    onPacket: (pkt: DecodedPacket) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    this.assertOpen()
    if (this.subscribed_) {
      throw new ZkConnectionError(
        'this session is already subscribed to realtime events; close it and reconnect to subscribe again',
      )
    }
    const res = await this.send(CMD.REG_EVENT, encodeEventMask(mask))
    if (isEventPacket(res)) {
      await this.abandon()
      throw new ZkProtocolError(
        'a realtime event arrived where the CMD_REG_EVENT reply was expected: the device pushed ' +
          'an event before acknowledging the registration, so the reply stream is out of step. ' +
          'This session has been torn down; reconnect before using it again',
      )
    }
    if (res.command === CMD.ACK_UNAUTH) {
      throw new ZkAuthError(
        'CMD_REG_EVENT answered ACK_UNAUTH: the device did not authorize a realtime subscription',
        res.data,
      )
    }
    if (res.command !== CMD.ACK_OK) {
      throw new ZkProtocolError(
        `device refused a realtime subscription with command ${res.command}`,
      )
    }
    this.subscribed_ = true
    this.transport.listen((payload) => {
      // A malformed push must reach the subscription as an error rather than
      // throw inside a socket data handler, where nothing would catch it.
      try {
        onPacket(decodePayload(payload))
      } catch (err) {
        onError(err as Error)
      }
    }, onError)
  }

  /** Encodes and transmits one request without awaiting a reply. */
  private async transmit(
    command: number,
    data?: Buffer,
    override?: { sessionId: number },
  ): Promise<void> {
    const sessionId = override?.sessionId ?? this.currentSessionId
    const payload = encodePayload({ command, sessionId, replyId: this.replyId, data })
    this.replyId = (this.replyId + 1) & 0xffff
    await this.transport.send(payload)
  }

  private inFlight = false

  /**
   * Runs one transmit-and-receive with at most one in flight per session.
   *
   * Refused BEFORE anything is transmitted. Until v0.5 both requests went on
   * the wire and only the second receive() was refused, so the first caller
   * collected whichever reply came first and the other reply sat in the
   * queue for the next request (review R1, second half).
   */
  private async exchange<T>(fn: () => Promise<T>): Promise<T> {
    // A subscribed session's socket is listening, so a request's reply would
    // arrive at the listener rather than at a receive(), and the transport
    // would refuse the receive() itself with its OWN ZkConnectionError --
    // "this transport is listening for events; receive() is not available".
    // That message is about a perfectly healthy socket, not a dead one, and
    // the catch block below cannot tell it apart from a transport that
    // really died -- it would clear open_ and leave abandon() unreached,
    // skipping the goodbye and the transport close (review R2). Refusing
    // here, before transmit(), keeps both of the transport's own refusals
    // ("listening", "already pending") unreachable from Session, so the
    // catch below only ever sees a transport that genuinely failed, and it
    // stops a request being sent onto a listening socket in the first place.
    // subscribe() sends CMD_REG_EVENT through this same path before
    // `subscribed_` is set, so its own registration is unaffected; close()'s
    // non-subscribed goodbye only runs when this guard would not fire; and
    // abandon() transmits its EXIT directly, bypassing exchange() entirely.
    if (this.subscribed_) {
      throw new ZkConnectionError(
        'this session is subscribed to realtime events and cannot make requests; close the stream and reconnect to read',
      )
    }
    if (this.inFlight) {
      throw new ZkConnectionError(
        'a request is already in flight on this session; issue one at a time',
      )
    }
    this.inFlight = true
    try {
      return await fn()
    } catch (err) {
      // A timeout means a reply may still be coming, and the next request
      // would collect it as its own (checklist item 22). A framing failure
      // means the stream is misaligned. A connection error means the socket
      // reported a failure. None can be recovered from without guessing what
      // the device put in its replies, so the session ends — the same rule
      // open() and subscribe() apply to their own failures (spec v0.5 §5.2).
      // The caller still receives the original error.
      //
      // The connection error goes through abandon() like the other two rather
      // than merely clearing open_. Clearing it rested on the transport
      // already being gone, which is true on TCP — Node destroys the socket —
      // and false on UDP, where a post-connect 'error' reaches
      // UdpTransport.fail(), which records the failure and leaves the socket
      // bound. With open_ already false, close() and abandon() both returned
      // early and nothing ever released it. abandon()'s EXIT is
      // best-effort-swallowed, which a dead TCP socket tolerates and a live
      // UDP one can still use, and transport.close() is idempotent.
      if (err instanceof ZkTimeoutError || err instanceof ZkFramingError || err instanceof ZkConnectionError) {
        await this.abandon()
      }
      throw err
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Encodes and transmits one request, then awaits its reply.
   *
   * Transmits the packet exactly as encoded: no reply-id quirk. The spec
   * asserted that the transmitted reply id runs one ahead of the one its
   * checksum covers, but oracle evidence contradicts it — pyzk and
   * zkteco-js, driven against the emulator as black boxes on both TCP and
   * UDP, both emit checksums that match the reply id they actually carry,
   * never `replyId - 1`, even though the two libraries start their reply-id
   * counters at different values (0 and 1). `applyReplyIdQuirk` stays
   * exported and tested in src/codec/packet.ts, one call site away, in case
   * a real device turns out to need it.
   */
  private send(command: number, data?: Buffer, override?: { sessionId: number }): Promise<DecodedPacket> {
    return this.exchange(async () => {
      await this.transmit(command, data, override)
      return decodePayload(await this.transport.receive(this.opts.timeoutMs))
    })
  }

  /**
   * Receives one further packet in an ongoing multi-packet exchange.
   *
   * Guarded like `tryExecute` rather than left to the transport: this path
   * sends nothing, so a torn-down session reaching it would be collecting
   * packets belonging to an exchange that no longer has an owner.
   */
  async receiveMore(): Promise<DecodedPacket> {
    this.assertOpen()
    return this.exchange(async () => decodePayload(await this.transport.receive(this.opts.timeoutMs)))
  }

  /**
   * Refuses a request from a session that is no longer open.
   *
   * The guarantee `subscribe` promises used to be delivered one layer down:
   * `abandon` set `open_ = false` and closed the socket, nothing on the
   * request path ever read `open_`, and what actually refused the next call
   * was the destroyed socket. That worked, and it was untestable -- against a
   * real transport a ZkConnectionError from the guard and one from the socket
   * are indistinguishable, so the docblock's claim rested on a mechanism no
   * test could pin. It also meant a transport that queued, reconnected, or
   * simply had not noticed the close yet would answer, and the reply would be
   * the one this session's teardown existed to stop being read.
   *
   * ZkConnectionError, deliberately: the class callers already handle for a
   * session they can no longer use. Only the message changes, naming this
   * layer as the refuser.
   *
   * Applied to the public request path, NOT to `send`. `close` sets `open_`
   * false and then sends its goodbye through `send`, and on UDP that goodbye
   * is the only thing telling the device to release the session slot.
   */
  private assertOpen(): void {
    if (this.open_) return
    throw new ZkConnectionError(
      'this session is not open: it was closed, or torn down after its reply stream went out of ' +
        'step. Reconnect before using it again',
    )
  }

  /**
   * Ends a session whose reply stream can no longer be trusted.
   *
   * No reply is awaited for the goodbye: the next packet to arrive belongs to
   * some earlier exchange, so reading one would only deepen the confusion.
   * The same is true of a subscribed session — the socket is listening, so a
   * reply could never be read there either — which is why close() defers to
   * this method rather than duplicating it. The goodbye is still sent — on
   * UDP there is no connection close to tell the device the session is over,
   * so skipping it would leave the device holding the session slot. Nothing
   * here throws; the caller is already on its way to reporting a failure of
   * its own.
   *
   * Sent where a socket still exists, which is not everywhere this runs. A
   * framing failure destroys the transport as it rejects the frame (§4.5), so
   * the EXIT has nothing to write to and the swallowed rejection is the whole
   * of it — `test/session/session.spec.ts`'s framing test records the
   * emulator receiving CONNECT and GET_FREE_SIZES and no EXIT. The goodbye
   * actually reaches the device on the timeout teardown, on a connection
   * error where the socket outlived it (UDP), and on close() of a subscribed
   * session.
   */
  private async abandon(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    this.subscribed_ = false
    await this.transmit(CMD.EXIT).catch(() => {})
    await this.transport.close().catch(() => {})
  }

  /**
   * Ends the session. Never throws: a goodbye is best effort, and a device
   * that has already gone away needs none.
   *
   * A subscribed session cannot read a reply — the socket is listening — so
   * it goes through abandon(), which sends EXIT without awaiting one. On UDP
   * that goodbye is the only thing telling the device to release the session
   * slot, which is why it is sent at all. A goodbye that times out runs the
   * §5.2 teardown from inside send(); abandon() and the transport close that
   * follows are both idempotent, so the sequence ends the same way.
   */
  async close(): Promise<void> {
    if (!this.open_) return
    if (this.subscribed_) return this.abandon()
    this.open_ = false
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close().catch(() => {})
  }
}
