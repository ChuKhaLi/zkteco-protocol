import { CMD } from '../codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../codec/packet.js'
import { mixCommKey } from '../codec/commkey.js'
import { encodeEventMask, isEventPacket } from '../codec/events.js'
import { ZkAuthError, ZkProtocolError } from '../errors.js'
import type { Transport } from '../transport/Transport.js'

export interface SessionOptions {
  timeoutMs: number
  /** Device comm key. 0 means unset. */
  commKey?: number
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
    await this.transport.connect()
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

  /** Sends one command and returns the reply. Throws only on ACK_ERROR. */
  async execute(command: number, data?: Buffer): Promise<DecodedPacket> {
    const res = await this.send(command, data)
    if (res.command === CMD.ACK_ERROR) {
      throw new ZkProtocolError(`device rejected command ${command}`)
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
   * the error propagates, and cannot be polled afterwards.
   *
   * Buffering the early event and replaying it onto the stream was considered
   * and rejected (RULING R11). It would preserve the punch, but only by
   * building a bounded version of that same router, resting on a
   * discrimination rule no device has ever confirmed. Spec §1.1 already
   * answers a lost event: polling is the source of truth, and the next poll
   * recovers it.
   */
  async subscribe(
    mask: number,
    onPacket: (pkt: DecodedPacket) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const res = await this.send(CMD.REG_EVENT, encodeEventMask(mask))
    if (isEventPacket(res)) {
      await this.abandon()
      throw new ZkProtocolError(
        'a realtime event arrived where the CMD_REG_EVENT reply was expected: the device pushed ' +
          'an event before acknowledging the registration, so the reply stream is out of step. ' +
          'This session has been torn down; reconnect before using it again',
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
  private async send(
    command: number,
    data?: Buffer,
    override?: { sessionId: number },
  ): Promise<DecodedPacket> {
    await this.transmit(command, data, override)
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  /** Receives one further packet in an ongoing multi-packet exchange. */
  async receiveMore(): Promise<DecodedPacket> {
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  /**
   * Ends a session whose reply stream can no longer be trusted.
   *
   * No reply is awaited for the goodbye: the next packet to arrive belongs to
   * some earlier exchange, so reading one would only deepen the confusion.
   * The goodbye is still sent — on UDP there is no connection close to tell
   * the device the session is over, so skipping it would leave the device
   * holding the session slot. Nothing here throws; the caller is already on
   * its way to reporting a failure of its own.
   */
  private async abandon(): Promise<void> {
    this.open_ = false
    this.subscribed_ = false
    await this.transmit(CMD.EXIT).catch(() => {})
    await this.transport.close().catch(() => {})
  }

  async close(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    if (this.subscribed_) {
      // The socket is listening, so a reply could never be read — the goodbye
      // is sent without awaiting one. It is still sent: on UDP there is no
      // connection close to tell the device the session is over, so skipping
      // it would leave the device holding the session slot.
      await this.transmit(CMD.EXIT).catch(() => {})
      this.subscribed_ = false
      await this.transport.close()
      return
    }
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close()
  }
}
