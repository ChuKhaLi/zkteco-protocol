import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { ZkDevice } from '../../src/ZkDevice.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkEventStream } from '../../src/realtime/Subscription.js'
import type { ZkRealtimeEvent } from '../../src/types.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
let stream: ZkEventStream | null = null
afterEach(async () => {
  await stream?.close().catch(() => {}); stream = null
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

function large(userId: string): Buffer {
  const buf = Buffer.alloc(36)
  buf.write(userId, 0, 9, 'ascii')
  buf.writeUInt16LE(1, 24)
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

function small(uid: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.writeUInt8(uid, 0)
  buf.set([26, 8, 27, 8, 1, 30], 4)
  return buf
}

/** Takes `count` events, or throws whatever the stream throws first. */
async function take(s: ZkEventStream, count: number): Promise<ZkRealtimeEvent[]> {
  const got: ZkRealtimeEvent[] = []
  for await (const ev of s) {
    got.push(ev)
    if (got.length >= count) break
  }
  return got
}

/**
 * Polls `check` until it is true, or throws once `timeoutMs` has elapsed.
 *
 * A bounded poll rather than a fixed sleep: the condition it waits for
 * (a packet the emulator has processed) is normally satisfied within a
 * millisecond or two, so a poll settles fast on the happy path and only
 * burns the full timeout when the thing being proven is actually missing.
 */
async function pollUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

for (const transport of ['tcp', 'udp'] as const) {
  describe(`realtime scenarios over ${transport}`, () => {
    const connect = async (emulator: Emulator): Promise<ZkDevice> => {
      const d = new ZkDevice({ host: '127.0.0.1', port: emulator.port, transport, timeoutMs: 2000 })
      await d.connect()
      return d
    }

    // Scenario 1
    it('decodes both dialects across a run of events', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('0001234'))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, small(7))
      const got = await take(stream, 2)
      expect(got[0]).toMatchObject({ kind: 'attendance', userId: '0001234', userIdSource: 'device', uid: null })
      expect(got[1]).toMatchObject({ kind: 'attendance', userId: null, userIdSource: null, uid: 7 })
      expect(got[0]).toMatchObject({ timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }) })
    })

    // CONTROLLER RULING R4: on UDP the ack and the events are independent
    // datagrams, so the second and third usually land AFTER listen() has
    // attached and are delivered live rather than through the drain. This
    // test stays on both transports because take() waits for delivery and
    // the end-to-end claim holds either way — but on UDP it proves delivery,
    // not the drain. The drain itself is proven on TCP here and, for UDP, by
    // test/transport/listen.spec.ts "drains packets that were queued before
    // listen()". Keep this comment; do not restate the TCP determinism
    // argument as though it applied to UDP.
    // Scenario 2 — the queued-before-listen race, made deterministic by
    // pushWithAck: the events are written in the same handler return as the
    // registration ack, so they land while no listener is attached yet.
    it('delivers events that arrived alongside the registration ack', async () => {
      running = await startEmulator({
        transport,
        pushWithAck: [
          { eventType: EVENT_FLAG.ATTENDANCE, data: large('EARLY1') },
          { eventType: EVENT_FLAG.ATTENDANCE, data: large('EARLY2') },
        ],
      })
      device = await connect(running)
      stream = await device.subscribe()
      const got = await take(stream, 2)
      expect(got.map((e) => (e.kind === 'attendance' ? e.userId : null))).toEqual(['EARLY1', 'EARLY2'])
    })

    // Scenario 3
    it('ends the stream when a burst outruns the buffer', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe({ bufferLimit: 3 })
      for (let i = 0; i < 8; i += 1) running.pushEvent(EVENT_FLAG.ATTENDANCE, large(`U${i}`))
      await new Promise((r) => setTimeout(r, 100))
      await expect(take(stream, 8)).rejects.toThrow(ZkProtocolError)
    })

    // Scenario 4
    it('ends the stream on a packet that is not an event', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushRaw(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 9 }))
      await expect(take(stream, 1)).rejects.toThrow(ZkProtocolError)
    })

    // Scenario 5
    it('surfaces an unknown event type and an unknown payload length, and survives both', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe({ events: EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM })
      running.pushEvent(EVENT_FLAG.ALARM, Buffer.from([0x3a, 0x00]))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, Buffer.alloc(20, 0x11))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('AFTER'))
      const got = await take(stream, 3)
      expect(got[0]).toEqual({ kind: 'unknown', eventType: EVENT_FLAG.ALARM, raw: '3a00' })
      expect(got[1]).toEqual({ kind: 'unknown', eventType: EVENT_FLAG.ATTENDANCE, raw: '11'.repeat(20) })
      expect(got[2]).toMatchObject({ kind: 'attendance', userId: 'AFTER' })
    })

    // Scenario 10 — an event that lands BEFORE the registration ack, which
    // desynchronises the reply stream — lives in test/session/subscribe.spec.ts
    // instead, next to the refused-registration test whose asymmetry it is
    // the point of: a refusal leaves the session usable, a desync must not.
    //
    // Scenario 11 — the try/catch in Session.subscribe, which nothing else in
    // this suite enters. A malformed push must reach the stream as an error rather than
    // throw out of a socket 'data' handler, where nothing would catch it —
    // and scenario 5 above does NOT exercise that: an unknown event type and
    // an unknown payload length both decode perfectly well at the PACKET
    // layer and are rejected later, by the codec. Only bytes too short to be
    // a packet at all reach the guard.
    it('ends the stream when a push cannot be decoded as a packet at all', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushRaw(Buffer.from([0x01, 0x02]))
      await expect(take(stream, 1)).rejects.toThrow(ZkProtocolError)
      await expect(take(stream, 1)).rejects.toThrow(/payload shorter than the 8-byte header/)
    })

    // Scenario 7 — a registration that TIMES OUT, not one that is refused.
    // A refused registration (ACK_ERROR) costs one call and leaves the session
    // usable (design spec v0.2 §3.4). A timeout is different: the ack may
    // still be coming, and the next request would collect it as its own —
    // exactly the desync spec v0.5 §5.2 exists to prevent. So this now ends
    // the session like every other timed-out exchange.
    it('times out and closes the session when the registration is never acked', async () => {
      running = await startEmulator({
        transport,
        handlers: { [CMD.REG_EVENT]: () => null },
      })
      device = await connect(running)
      await expect(device.subscribe()).rejects.toThrow(ZkTimeoutError)
      const refused = await device.getInfo().then(() => null, (e: unknown) => e as Error)
      expect(refused).toBeInstanceOf(ZkConnectionError)
      expect(refused!.message).toMatch(/this session is not open/)
      // Reconnecting recovers: a fresh session answers normally again.
      await device.connect()
      await expect(device.getInfo()).resolves.toBeDefined()
    })

    // Scenario 8
    it('keeps an in-flight event for the stream even when a read is refused', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('INFLIGHT'))
      await expect(device.getInfo()).rejects.toThrow(ZkConnectionError)
      const got = await take(stream, 1)
      expect(got[0]).toMatchObject({ kind: 'attendance', userId: 'INFLIGHT' })
    })

    // Scenario 9
    //
    // "Closes cleanly" means two things (design spec §7.2): no socket left
    // open, and no unhandled rejection. `socketErrors` alone proves neither —
    // isIgnorableSocketError filters exactly the codes an UNCLEAN close
    // produces (ECONNRESET, EPIPE) on the server side, while a genuinely
    // clean close produces no server-side error at all, so both outcomes
    // leave that array empty. What actually distinguishes a clean shutdown is
    // asserted directly below: the emulator sees the CMD_EXIT goodbye, and
    // nothing anywhere rejects unobserved.
    it('closes cleanly while events are still arriving', async () => {
      const unhandledRejections: unknown[] = []
      const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
      process.on('unhandledRejection', onUnhandledRejection)
      try {
        running = await startEmulator({ transport })
        device = await connect(running)
        const open = await device.subscribe()
        for (let i = 0; i < 5; i += 1) running.pushEvent(EVENT_FLAG.ATTENDANCE, large(`C${i}`))
        await open.close()
        stream = null
        await device.disconnect()
        device = null
        // Session.close() on a subscribed session transmits CMD_EXIT without
        // awaiting a reply — the socket is listening, so a reply could never
        // be read — but it is still sent: on UDP there is no connection close
        // to tell the device the session is over, so skipping it would leave
        // the device holding the session slot. The write is flushed before
        // the socket closes, but the emulator processes it on its own event
        // loop, so this polls for it rather than guessing a fixed delay.
        await pollUntil(() => running!.received.some((p) => p.command === CMD.EXIT))
        // "No socket left open" — the other half of §7.2 #9, and TCP-only
        // because `sockets` is always empty on UDP, where asserting it would
        // prove nothing. Polled first for the same reason the goodbye is: the
        // client's FIN and the emulator's 'close' handler run on separate
        // event loops, so a bare assertion would be racing the OS rather than
        // testing the library. The poll is what fails when a socket leaks;
        // the expect states the claim.
        if (transport === 'tcp') {
          await pollUntil(() => running!.sockets.size === 0)
          expect(running.sockets.size).toBe(0)
        }
        // Give a same-tick unhandled rejection a chance to surface before asserting.
        await new Promise((r) => setImmediate(r))
        expect(unhandledRejections).toEqual([])
        expect(running.socketErrors).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandledRejection)
      }
    })
  })
}

// Scenario 6 is TCP-only, and explicitly so rather than by omission: UDP has
// no connection to drop. A device that stops answering over UDP is
// indistinguishable from a quiet one, which is what idleTimeoutMs is for —
// covered by the idle-timeout test below.
describe('realtime scenarios, TCP only', () => {
  it('throws a lost connection out of the iterator', async () => {
    running = await startEmulator({ transport: 'tcp' })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 2000 })
    await device.connect()
    stream = await device.subscribe()
    for (const socket of running.sockets) socket.destroy()
    await expect(take(stream, 1)).rejects.toThrow(ZkConnectionError)
  })
})

describe('realtime scenarios, UDP only', () => {
  it('ends the stream on the idle timeout when a device simply stops answering', async () => {
    running = await startEmulator({ transport: 'udp' })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport: 'udp', timeoutMs: 2000 })
    await device.connect()
    stream = await device.subscribe({ idleTimeoutMs: 100 })
    await expect(take(stream, 1)).rejects.toThrow(ZkTimeoutError)
  })
})
