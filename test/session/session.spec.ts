import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkAuthError, ZkConnectionError, ZkFramingError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import type { Transport } from '../../src/transport/Transport.js'
import type { EventEmitter } from 'node:events'

/**
 * The live socket a transport keeps private — a `net.Socket` or a
 * `dgram.Socket`, both EventEmitters, and both nulled by `close()`.
 *
 * Same cast as `test/transport/listen.spec.ts`'s `socketOf`, widened to cover
 * either transport so one assertion reads "the socket was released" on both.
 */
const socketOf = (t: Transport): EventEmitter | null =>
  (t as unknown as { socket: EventEmitter | null }).socket

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Session over ${transportKind}`, () => {
    it('acquires the session id the device issues', async () => {
      running = await startEmulator({ transport: transportKind, sessionId: 0x4242 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(session.sessionId).toBe(0x4242)
    })

    it('sends the acquired session id on subsequent commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        sessionId: 0x0abc,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      expect(running.received[1]!.sessionId).toBe(0x0abc)
    })

    // The spec (§5.1) asserted a reply-id quirk: the wire packet carries
    // N+1 while its checksum was computed over N. Oracle evidence
    // contradicts that. pyzk and zkteco-js were driven against the emulator
    // as black boxes on both transports and their wire bytes captured; every
    // packet's checksum matched the reply id it actually carried, e.g.:
    //   pyzk      / tcp  cmd 1001 rid 1: observed 56551 | self 56551 | prev 56552 -> SELF
    //   zkteco-js / tcp  cmd 1000 rid 1: observed 64534 | self 64534 | prev 64535 -> SELF
    //   zkteco-js / tcp  cmd 1001 rid 2: observed 56550 | self 56550 | prev 56551 -> SELF
    // ...and identically over UDP. None matched `replyId - 1`, and the two
    // libraries even start their reply-id counters at different values (0
    // and 1), so this is agreement across different data, not coincidence.
    // Session.send() no longer applies the quirk; this test now proves the
    // opposite of what it originally asserted.
    it('transmits a checksum that matches the reply id it actually carries', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)

      const sent = running.received[1]!
      const asTransmitted = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId,
      })
      const asChecksummed = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId - 1,
      })
      expect(sent.checksum).toBe(checksum16(asTransmitted))
      expect(sent.checksum).not.toBe(checksum16(asChecksummed))
    })

    it('increments the reply id across commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      await session.execute(CMD.GET_FREE_SIZES)
      const ids = running.received.map((p) => p.replyId)
      expect(ids[2]).toBe(ids[1]! + 1)
    })

    it('throws ZkProtocolError when the device replies ACK_ERROR', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('returns ACK_DATA replies verbatim rather than treating them as failures', async () => {
      const payload = Buffer.from([1, 2, 3])
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_DATA, payload)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const res = await session.execute(CMD.ATTLOG_RRQ)
      expect(res.command).toBe(CMD.ACK_DATA)
      expect(res.data).toEqual(payload)
    })

    it('throws ZkAuthError when the device demands a comm key', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.CONNECT]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })

    it('times out on a silent device instead of hanging', async () => {
      running = await startEmulator({ transport: transportKind, behavior: 'silent' })
      session = new Session(makeTransport(running.port), { timeoutMs: 200 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkTimeoutError)
      session = null
    })

    it('is safe to close twice', async () => {
      running = await startEmulator({ transport: transportKind })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.close()
      await expect(session.close()).resolves.toBeUndefined()
      session = null
    })

    it('refuses a second request while one is in flight, before it is transmitted', async () => {
      // Answer GET_FREE_SIZES slowly so the first request is still waiting
      // when the second is issued.
      running = await startEmulator({
        transport: transportKind,
        replyDelayMs: 150,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const first = session.execute(CMD.GET_FREE_SIZES)
      const second = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e as Error)
      expect(second).toBeInstanceOf(ZkConnectionError)
      expect(second!.message).toMatch(/already in flight/)
      await expect(first).resolves.toMatchObject({ command: CMD.ACK_OK })
      // Nothing beyond CONNECT and the first request reached the wire.
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT, CMD.GET_FREE_SIZES])
    })

    it('closes the session on a timeout so a late reply is never collected by the next request', async () => {
      running = await startEmulator({
        transport: transportKind,
        replyDelayMs: 400,
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK, Buffer.from('late'))],
        },
      })
      // CONNECT is delayed too, so the open() deadline must clear it.
      session = new Session(makeTransport(running.port), { timeoutMs: 1000 })
      await session.open()
      ;(session as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs = 150
      await expect(session.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkTimeoutError)

      // The late reply lands here. Before v0.5 the next call returned it.
      await new Promise((r) => setTimeout(r, 500))
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      // The goodbye was sent on the way out.
      expect(running.received.map((p) => p.command)).toContain(CMD.EXIT)
      session = null
    })

    it('closes the session when the connection drops, and says so rather than the socket', async () => {
      running = await startEmulator({ transport: transportKind, handlers: { [CMD.GET_FREE_SIZES]: () => null } })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const pending = session.execute(CMD.GET_FREE_SIZES)
      await new Promise((r) => setTimeout(r, 50))
      await running.close() // the peer goes away mid-request
      running = null
      // TCP sees the close; UDP sees nothing and times out. Both end the session.
      await expect(pending).rejects.toBeInstanceOf(transportKind === 'tcp' ? ZkConnectionError : ZkTimeoutError)
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      session = null
    })

    // A connection error used to clear `open_` without closing the transport,
    // on the premise that the transport was already gone. True on TCP, where
    // Node destroys the socket; false on UDP, where a post-connect 'error'
    // only records the failure and leaves the socket bound. close() and
    // abandon() then both returned early on `open_` being false, so nothing
    // ever released it: the descriptor leaked and the process stayed alive.
    // The error is emitted on the private socket rather than provoked from
    // the network, because an ICMP unreachable is neither deterministic nor
    // uniform across platforms; what is under test is everything downstream
    // of the handler, which is where the leak was.
    it('releases the transport socket when a request fails with a connection error', async () => {
      running = await startEmulator({ transport: transportKind, handlers: { [CMD.GET_FREE_SIZES]: () => null } })
      const transport = makeTransport(running.port)
      session = new Session(transport, { timeoutMs: 2000 })
      await session.open()
      const pending = session.execute(CMD.GET_FREE_SIZES)
      await new Promise((r) => setTimeout(r, 50))
      socketOf(transport)!.emit('error', new Error('boom'))

      await expect(pending).rejects.toBeInstanceOf(ZkConnectionError)
      await expect(session.close()).resolves.toBeUndefined()
      expect(socketOf(transport)).toBeNull()
    })

    // Named for what it proves. It used to say "and sends the goodbye", which
    // it never asserted and which cannot happen: rejecting the frame destroys
    // the socket (§4.5) before abandon() gets to transmit, so the EXIT is
    // swallowed. The wire assertion below is that absence, stated as evidence
    // rather than left to the name.
    it.skipIf(transportKind !== 'tcp')('closes the session on a framing failure; the next call is refused by the session', async () => {
      running = await startEmulator({ transport: 'tcp', handlers: { [CMD.GET_FREE_SIZES]: () => null } })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const pending = session.execute(CMD.GET_FREE_SIZES)
      await new Promise((r) => setTimeout(r, 50))
      for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
      await expect(pending).rejects.toBeInstanceOf(ZkFramingError)
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT, CMD.GET_FREE_SIZES])
      session = null
    })

    describe('tryExecute', () => {
      it('returns an ACK_ERROR reply instead of throwing, while execute still throws', async () => {
        running = await startEmulator({
          transport: transportKind,
          handlers: {
            [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_ERROR)],
          },
        })
        session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
        await session.open()

        const res = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1'))
        expect(res.command).toBe(CMD.ACK_ERROR)

        await expect(
          session.execute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1')),
        ).rejects.toBeInstanceOf(ZkProtocolError)
      })

      it('still surfaces a timeout as a timeout, not as a readable reply', async () => {
        // The whole point of tryExecute is that ONLY ACK_ERROR becomes readable.
        // Everything else must keep propagating. The handshake is answered
        // normally here — only CMD.OPTIONS_RRQ goes unanswered — so the
        // timeout is actually reached through tryExecute() itself, not
        // through open()'s own CONNECT exchange.
        running = await startEmulator({
          transport: transportKind,
          handlers: {
            [CMD.OPTIONS_RRQ]: () => [],
          },
        })
        session = new Session(makeTransport(running.port), { timeoutMs: 150 })
        await session.open()

        await expect(
          session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1')),
        ).rejects.toBeInstanceOf(ZkTimeoutError)
      })
    })
  })
}

/**
 * A transport that answers whatever it was scripted to answer and never fails,
 * including after close().
 *
 * That last part is the entire point. Session.subscribe's doc comment says a
 * desynced session "is torn down here ... and cannot be polled afterwards",
 * but nothing on the request path read `open_`: the refusal came from the
 * socket being destroyed, one layer below the promise. Against a real
 * transport a test cannot tell those two apart, because both produce a
 * ZkConnectionError. Against this one, only Session can refuse.
 */
class ScriptedTransport implements Transport {
  readonly sent: Buffer[] = []
  closed = false
  constructor(private readonly replies: Buffer[]) {}
  async connect(): Promise<void> {}
  async send(payload: Buffer): Promise<void> { this.sent.push(payload) }
  async receive(): Promise<Buffer> {
    const next = this.replies.shift()
    if (!next) throw new Error('ScriptedTransport ran out of replies')
    return next
  }
  listen(): void {}
  /** Deliberately inert: a closed transport here still answers. */
  async close(): Promise<void> { this.closed = true }
}

const ackOk = (sessionId = 1, replyId = 0): Buffer =>
  encodePayload({ command: CMD.ACK_OK, sessionId, replyId })

describe('Session refuses requests once it is no longer open', () => {
  it('refuses after a desynced subscribe, with the transport still willing to answer', async () => {
    // The device pushes an event where the CMD_REG_EVENT ack belongs (an
    // event packet IS command REG_EVENT -- see isEventPacket), so the real
    // ACK_OK is stranded and every later reply would be off by one.
    const transport = new ScriptedTransport([
      ackOk(9),
      encodePayload({ command: CMD.REG_EVENT, sessionId: EVENT_FLAG.ATTENDANCE, replyId: 1 }),
      // Scripted and never reached: if Session let this request through, the
      // transport would answer it and the assertion below would fail.
      ackOk(9, 2),
    ])
    const s = new Session(transport, { timeoutMs: 500 })
    await s.open()

    await expect(s.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {}))
      .rejects.toThrow(/out of step/)

    await expect(s.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkConnectionError)
    await expect(s.execute(CMD.GET_FREE_SIZES)).rejects.toThrow(/torn down|not open/i)
  })

  it('refuses a request on a session that was never opened', async () => {
    const transport = new ScriptedTransport([ackOk()])
    const s = new Session(transport, { timeoutMs: 500 })

    await expect(s.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkConnectionError)
    // Nothing reached the wire: the guard refused before transmit().
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses a request after an ordinary close', async () => {
    // Uniform beats special case. The desync teardown and an orderly goodbye
    // leave the session in the same state, and one rule covers both rather
    // than a guard that only the interesting path gets.
    const transport = new ScriptedTransport([ackOk(9), ackOk(9, 1)])
    const s = new Session(transport, { timeoutMs: 500 })
    await s.open()
    await s.close()
    const sentDuringSession = transport.sent.length

    await expect(s.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkConnectionError)
    expect(transport.sent).toHaveLength(sentDuringSession)
  })

  it('refuses receiveMore, which reads a reply without sending anything', async () => {
    // The multi-packet read path does not go through execute(), so a guard
    // placed only there would leave readBulk's continuation able to collect
    // packets belonging to a session that has been torn down.
    const transport = new ScriptedTransport([ackOk(9), ackOk(9, 1)])
    const s = new Session(transport, { timeoutMs: 500 })
    await s.open()
    await s.close()

    await expect(s.receiveMore()).rejects.toBeInstanceOf(ZkConnectionError)
  })
})
