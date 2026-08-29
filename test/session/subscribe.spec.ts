import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkProtocolError } from '../../src/errors.js'
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

    // TCP-only: this scenario's value is proving the queue-drain path — a
    // packet parked because it lands after the reply but before listen() is
    // attached, then handed over on the drain. The emulator can only make
    // that deterministic on TCP, where the ack and the two events arrive in
    // one chunk and absorb() drains it in a synchronous loop. Over UDP they
    // are three independent OS-scheduled datagrams: by the time the second
    // and third arrive, listen() has typically already run, so the events
    // take the live-listener path instead of the drain — looping this over
    // UDP would go green while exercising a different path than the one the
    // test name claims. The UDP drain path itself is still covered, just by
    // a test built for it: test/transport/listen.spec.ts, "drains packets
    // that were queued before listen()", which runs over both transports and
    // gets its determinism from an explicit wait before listen() rather than
    // from same-tick arrival.
    if (kind === 'tcp') {
      it('delivers events that arrived alongside the registration ack', async () => {
        running = await startEmulator({
          transport: kind,
          pushWithAck: [
            { eventType: EVENT_FLAG.ATTENDANCE, data: Buffer.from([0x01]) },
            { eventType: EVENT_FLAG.ATTENDANCE, data: Buffer.from([0x02]) },
          ],
        })
        session = new Session(make(running.port), { timeoutMs: 2000 })
        await session.open()
        const seen: DecodedPacket[] = []
        await session.subscribe(EVENT_FLAG.ATTENDANCE, (pkt) => seen.push(pkt), () => {})
        expect(seen.map((p) => p.data.toString('hex'))).toEqual(['01', '02'])
      })
    }

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
  })
}
