import { CMD } from '../codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../codec/packet.js'
import { ZkAuthError, ZkProtocolError } from '../errors.js'
import type { Transport } from '../transport/Transport.js'

export interface SessionOptions {
  timeoutMs: number
}

/**
 * One request-response conversation with a device: session id acquisition,
 * reply-id sequencing, and per-request deadlines.
 */
export class Session {
  private currentSessionId = 0
  private replyId = 0
  private open_ = false

  constructor(
    private readonly transport: Transport,
    private readonly opts: SessionOptions,
  ) {}

  get sessionId(): number {
    return this.currentSessionId
  }

  /**
   * Handshakes and stores the session id the device issues.
   *
   * On any failure — refused handshake, auth demand, or timeout — the
   * transport is torn down before the error propagates. Nothing above this
   * call ever manages to close a session that never finished opening, so
   * leaving that to the caller would leak the socket.
   */
  async open(): Promise<void> {
    await this.transport.connect()
    this.open_ = true
    try {
      const res = await this.send(CMD.CONNECT, undefined, { sessionId: 0 })
      if (res.command === CMD.ACK_UNAUTH) {
        throw new ZkAuthError('device requires a comm key')
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
    const sessionId = override?.sessionId ?? this.currentSessionId
    const payload = encodePayload({ command, sessionId, replyId: this.replyId, data })
    this.replyId = (this.replyId + 1) & 0xffff
    await this.transport.send(payload)
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  /** Receives one further packet in an ongoing multi-packet exchange. */
  async receiveMore(): Promise<DecodedPacket> {
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  async close(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close()
  }
}
