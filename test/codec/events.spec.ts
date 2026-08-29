import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG, encodeEventMask, isEventPacket, readEventType, decodeRealtimeAttendance } from '../../src/codec/events.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'

describe('event mask encoding', () => {
  it('encodes the attendance-only mask as the four bytes zkteco-js transmits', () => {
    expect(encodeEventMask(EVENT_FLAG.ATTENDANCE).toString('hex')).toBe('01000000')
  })

  it('encodes the all-events mask the specification uses in its example', () => {
    expect(encodeEventMask(0xffff).toString('hex')).toBe('ffff0000')
  })

  it('encodes a combined mask little-endian', () => {
    expect(encodeEventMask(EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM).toString('hex')).toBe('01020000')
  })
})

describe('event packet recognition', () => {
  // A pushed event carries the event type in the field that holds a session
  // id in every other packet, and a reply id of zero. Built here the way the
  // device is believed to build it.
  const pushed = (eventType: number, data: Buffer): ReturnType<typeof decodePayload> =>
    decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

  it('recognises a pushed event by its command', () => {
    expect(isEventPacket(pushed(EVENT_FLAG.ATTENDANCE, Buffer.alloc(0)))).toBe(true)
  })

  it('does not mistake an ordinary reply for an event', () => {
    const ack = decodePayload(encodePayload({ command: CMD.ACK_OK, sessionId: 0x1234, replyId: 7 }))
    expect(isEventPacket(ack)).toBe(false)
  })

  it('reads the event type out of the session-id slot', () => {
    expect(readEventType(pushed(EVENT_FLAG.ALARM, Buffer.alloc(0)))).toBe(EVENT_FLAG.ALARM)
  })
})

/** The large dialect: 9-byte printed id, 15 zero bytes, verify type, 6-byte time. */
function largeEvent(userId: string, verifyMode: number, trailing = 4): Buffer {
  const buf = Buffer.alloc(32 + trailing)
  buf.write(userId, 0, 9, 'ascii')
  buf.writeUInt16LE(verifyMode, 24)
  buf.set([26, 8, 27, 8, 1, 30], 26) // 2026-08-27T08:01:30
  return buf
}

/** The small dialect: uid, three unknown bytes, 6-byte time. */
function smallEvent(uid: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.writeUInt8(uid, 0)
  buf.set([26, 8, 27, 8, 1, 30], 4)
  return buf
}

describe('realtime attendance dialects', () => {
  it('decodes the large dialect, printed identity and all', () => {
    const got = decodeRealtimeAttendance(largeEvent('0001234', 1))
    expect(got).toEqual({
      userId: '0001234',
      uid: null,
      verifyMode: 1,
      timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }),
    })
  })

  it('decodes the large dialect at exactly 32 bytes, with no trailing bytes', () => {
    expect(decodeRealtimeAttendance(largeEvent('7', 0, 0))?.userId).toBe('7')
  })

  it('reports no identity when the printed id field is empty, rather than an empty string', () => {
    const got = decodeRealtimeAttendance(largeEvent('', 0))
    expect(got?.userId).toBeNull()
    expect(got?.timestamp.local).toBe('2026-08-27T08:01:30')
  })

  // Node's 'ascii' decoding masks the high bit, so 0xc1 would read back as
  // 'A'. A byte that is not printable ASCII must not become a plausible
  // identifier; it must become no identifier at all.
  it('reports no identity when the id field holds bytes outside printable ASCII', () => {
    const buf = largeEvent('', 0)
    buf.set([0xc1, 0xc2, 0xc3], 0)
    expect(decodeRealtimeAttendance(buf)?.userId).toBeNull()
  })

  it('decodes the small dialect, which carries a uid and no printed identity', () => {
    expect(decodeRealtimeAttendance(smallEvent(5))).toEqual({
      userId: null,
      uid: 5,
      verifyMode: null,
      timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }),
    })
  })

  it('refuses to decode a length matching neither dialect', () => {
    expect(decodeRealtimeAttendance(Buffer.alloc(20))).toBeNull()
    expect(decodeRealtimeAttendance(Buffer.alloc(31))).toBeNull()
    expect(decodeRealtimeAttendance(Buffer.alloc(0))).toBeNull()
  })
})

import { decodeRealtimeEvent } from '../../src/codec/events.js'

describe('decodeRealtimeEvent', () => {
  const push = (eventType: number, data: Buffer) =>
    decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

  it('marks a printed identity as coming from the device itself', () => {
    const ev = decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, largeEvent('0001234', 1)))
    expect(ev).toMatchObject({
      kind: 'attendance',
      eventType: EVENT_FLAG.ATTENDANCE,
      userId: '0001234',
      userIdSource: 'device',
      uid: null,
      verifyMode: 1,
    })
  })

  it('leaves userIdSource null when no identity was sent', () => {
    const ev = decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, smallEvent(9)))
    expect(ev).toMatchObject({ kind: 'attendance', userId: null, userIdSource: null, uid: 9 })
  })

  it('surfaces an event type it cannot decode, with its bytes intact', () => {
    const data = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    expect(decodeRealtimeEvent(push(EVENT_FLAG.ALARM, data))).toEqual({
      kind: 'unknown',
      eventType: EVENT_FLAG.ALARM,
      raw: 'deadbeef',
    })
  })

  it('surfaces an attendance payload of unknown length rather than decoding part of it', () => {
    const data = Buffer.alloc(20, 0x11)
    expect(decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, data))).toEqual({
      kind: 'unknown',
      eventType: EVENT_FLAG.ATTENDANCE,
      raw: '11'.repeat(20),
    })
  })
})
