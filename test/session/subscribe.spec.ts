import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkConnectionError, ZkProtocolError } from '../../src/errors.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import type { DecodedPacket } from '../../src/codec/packet.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const kind of ['tcp', 'udp'] as const) {
  const make = (port: number) =>
    kind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Session.subscribe over ${kind}`, () => {
    it('registers with the four-byte mask and reports itself subscribed', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})

      const registration = running.received.find((p) => p.command === CMD.REG_EVENT)
      expect(registration?.data.toString('hex')).toBe('01000000')
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE)
      expect(session.subscribed).toBe(true)
    })

    it('delivers pushed events to the packet handler', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      const seen: DecodedPacket[] = []
      let settle: () => void = () => {}
      const arrived = new Promise<void>((r) => { settle = r })
      await session.subscribe(
        EVENT_FLAG.ATTENDANCE,
        (pkt) => { seen.push(pkt); settle() },
        () => {},
      )
      running.pushEvent(EVENT_FLAG.ATTENDANCE, Buffer.from([0x42]))
      await arrived
      expect(seen[0]?.command).toBe(CMD.REG_EVENT)
      expect(seen[0]?.sessionId).toBe(EVENT_FLAG.ATTENDANCE)
    })

    // The queued-before-listen race is NOT constructible at this level. What
    // stood here was a test that pushed events alongside the registration ack
    // and asserted they came back through listen()'s queue drain. It passed on
    // Windows and failed on all three Ubuntu jobs in CI.
    //
    // The window it aims at is the microtask boundary between the ack
    // resolving and Session.subscribe calling transport.listen(), and nothing
    // on the far side of a socket can target that. On Windows the emulator's
    // writes happened to coalesce into one TCP segment, so absorb() consumed
    // the ack and parked the events in a single synchronous pass; on Linux
    // they arrived as separate reads and the events took the live-listener
    // path instead. The comment that used to sit here blamed the transport,
    // TCP versus UDP, for what is really kernel write coalescing — the same
    // mistake this library calls out zkteco-js for elsewhere, of attributing
    // to the transport something that belongs to another cause entirely.
    //
    // The drain is proven where it can be proven deterministically:
    // test/transport/listen.spec.ts, "drains packets that were queued before
    // listen()", over both transports, which gets its determinism from calling
    // listen() itself at a chosen moment rather than from arrival timing. The
    // end-to-end delivery claim is covered by test/realtime/scenarios.spec.ts
    // scenario 2, which waits for delivery and says in its own comment that
    // waiting is what it proves.

    // A device that does not support realtime must cost one call, not the
    // connection: the caller can still poll with it.
    it('throws on a refused registration and leaves the session usable', async () => {
      running = await startEmulator({
        transport: kind,
        handlers: { [CMD.REG_EVENT]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})).rejects.toThrow(
        ZkProtocolError,
      )
      expect(session.subscribed).toBe(false)
      await expect(session.execute(CMD.GET_FREE_SIZES)).resolves.toBeDefined()
    })

    // The deliberate asymmetry with the test above. A device that pushes an
    // event before writing its registration ack hands that event to the
    // waiter the registration is holding and leaves the real ACK_OK in the
    // queue, so the NEXT request would collect a reply belonging to this one
    // and every reply after it would be off by one. A refusal costs one call;
    // a desync must cost the connection, because nothing downstream could
    // tell that its answers had shifted.
    it('fails and tears the session down when an event beats the registration ack', async () => {
      running = await startEmulator({
        transport: kind,
        pushBeforeAck: [{ eventType: EVENT_FLAG.ATTENDANCE, data: Buffer.from([0x42]) }],
      })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()

      const err = await session
        .subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})
        .then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ZkProtocolError)
      // Named as the race it is, NOT as a refusal — the device refused nothing.
      expect((err as Error).message).toMatch(/out of step/)
      expect((err as Error).message).not.toMatch(/refused/)

      // Torn down: a desynced session must not still be pollable. The message
      // is asserted, not just the class, because over a real transport the
      // destroyed socket raises ZkConnectionError too -- and that is exactly
      // the confusion this used to rest on. Session.assertOpen is what refuses
      // here; test/session/session.spec.ts proves it against a transport that
      // would have answered.
      expect(session.subscribed).toBe(false)
      const refusal = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e)
      expect(refusal).toBeInstanceOf(ZkConnectionError)
      expect((refusal as Error).message).toMatch(/this session is not open/)
    })

    // A subscribed session's socket is listening: a request's reply would
    // land at the listener, not at a receive(), and the transport itself
    // would refuse the receive() with its own "listening" message -- which
    // is not the transport being dead, so exchange()'s ZkConnectionError
    // branch must never see it. The guard belongs in Session, before
    // anything reaches the transport.
    it('refuses a request while subscribed before transmitting, and can still be closed', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})

      const refusal = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e as Error)
      expect(refusal).toBeInstanceOf(ZkConnectionError)
      expect(refusal!.message).toMatch(/subscribed to realtime events/)
      // Nothing was transmitted: the guard fired before transmit().
      expect(running.received.map((p) => p.command)).not.toContain(CMD.GET_FREE_SIZES)

      await session.close()
      // The write is flushed locally before the socket closes, but the
      // emulator only sees it on its own event loop tick -- close() resolving
      // does not mean the peer has processed EXIT yet (same reasoning as
      // test/realtime/scenarios.spec.ts's pollUntil for CMD.EXIT), so this
      // polls rather than racing a synchronous check.
      const deadline = Date.now() + 2000
      while (!running.received.some((p) => p.command === CMD.EXIT)) {
        if (Date.now() >= deadline) throw new Error('CMD.EXIT was never received by the emulator')
        await new Promise((r) => setTimeout(r, 5))
      }
      if (kind === 'tcp') {
        await new Promise((r) => setTimeout(r, 100))
        expect(running.sockets.size).toBe(0)
      }
      session = null
    })
  })
}
