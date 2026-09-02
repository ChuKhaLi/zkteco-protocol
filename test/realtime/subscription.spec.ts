import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { Subscription } from '../../src/realtime/Subscription.js'
import type { Session } from '../../src/session/Session.js'
import type { ZkRealtimeEvent } from '../../src/types.js'

/** A Session stand-in: the subscription only ever closes it. */
function fakeSession(): { session: Session; closed: () => number } {
  let closes = 0
  const session = { close: async () => { closes += 1 } } as unknown as Session
  return { session, closed: () => closes }
}

function attendancePayload(userId: string): Buffer {
  const buf = Buffer.alloc(32)
  buf.write(userId, 0, 9, 'ascii')
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

const pushed = (eventType: number, data: Buffer) =>
  decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

const opts = { events: EVENT_FLAG.ATTENDANCE, bufferLimit: 4, idleTimeoutMs: 0 }

async function drain(stream: AsyncIterable<ZkRealtimeEvent>, count: number): Promise<ZkRealtimeEvent[]> {
  const got: ZkRealtimeEvent[] = []
  for await (const ev of stream) {
    got.push(ev)
    if (got.length >= count) break
  }
  return got
}

describe('Subscription', () => {
  it('yields decoded events in the order they arrived', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('A1')))
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('B2')))
    const got = await drain(sub, 2)
    expect(got.map((e) => (e.kind === 'attendance' ? e.userId : null))).toEqual(['A1', 'B2'])
    await sub.close()
  })

  it('delivers an event that arrives while a consumer is already waiting', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    const pending = drain(sub, 1)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('C3')))
    const got = await pending
    expect(got[0]).toMatchObject({ kind: 'attendance', userId: 'C3' })
    await sub.close()
  })

  it('throws a lost connection out of the iterator', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.fail(new ZkConnectionError('peer went away'))
    await expect(drain(sub, 1)).rejects.toThrow(ZkConnectionError)
  })

  // Events already received are worth more than a prompt error.
  it('drains queued events before reporting a failure', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('D4')))
    sub.fail(new ZkConnectionError('peer went away'))
    const iterator = sub[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'attendance', userId: 'D4' },
    })
    await expect(iterator.next()).rejects.toThrow(ZkConnectionError)
  })

  it('ends the stream when the consumer falls further behind than the buffer allows', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    for (let i = 0; i < 5; i += 1) {
      sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload(`U${i}`)))
    }
    const iterator = sub[Symbol.asyncIterator]()
    // CONTROLLER RULING R2: five events are queued before the bound trips,
    // so five must be drained before the sixth next() can reject. The plan
    // said four, which would resolve with the fifth event instead. The
    // implementation is right; this loop bound was off by one.
    for (let i = 0; i < 5; i += 1) await iterator.next()
    await expect(iterator.next()).rejects.toThrow(ZkProtocolError)
  })

  it('ends the stream on a packet that is not an event', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(decodePayload(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 3 })))
    await expect(drain(sub, 1)).rejects.toThrow(ZkProtocolError)
  })

  it('closes the session exactly once, however often close() is called', async () => {
    const { session, closed } = fakeSession()
    const sub = new Subscription(session, opts)
    await sub.close()
    await sub.close()
    expect(closed()).toBe(1)
  })

  it('closes the session when a consumer leaves the loop early', async () => {
    // `for await` calls the iterator's return() when the body breaks. Without
    // one, the obvious consumer loop -- take a few events, break -- leaves the
    // subscription registered and the socket under it open, with the device
    // still pushing to nobody. This is the whole reason return() exists.
    const { session, closed } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('E5')))
    for await (const ev of sub) {
      expect(ev.kind).toBe('attendance')
      break
    }
    expect(closed()).toBe(1)
  })

  it('closes the session when the consumer throws out of the loop', async () => {
    // The other early exit `for await` cleans up after. An exception raised in
    // the BODY runs return(); one raised by next() does not, and must not --
    // that path is already ending and its own tests cover it.
    const { session, closed } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('F6')))
    await expect(
      (async () => {
        for await (const ev of sub) {
          void ev
          throw new Error('consumer gave up')
        }
      })(),
    ).rejects.toThrow('consumer gave up')
    expect(closed()).toBe(1)
  })

  it('ends iteration cleanly after close()', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    await sub.close()
    expect(await sub[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  })

  it('does not arm the idle timer until start()', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, { ...opts, idleTimeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 80))
    // Still live: the timer is armed by start(), after registration.
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('E5')))
    const got = await drain(sub, 1)
    expect(got[0]).toMatchObject({ userId: 'E5' })
    await sub.close()
  })

  it('ends the stream with ZkTimeoutError once started and idle', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, { ...opts, idleTimeoutMs: 30 })
    sub.start()
    await expect(drain(sub, 1)).rejects.toThrow(ZkTimeoutError)
  })

  it('queues an event pushed before start() and delivers it after', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('F6')))
    sub.start()
    expect((await drain(sub, 1))[0]).toMatchObject({ userId: 'F6' })
    await sub.close()
  })
})
