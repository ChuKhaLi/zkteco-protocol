import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG, encodeEventMask, isEventPacket, readEventType } from '../../src/codec/events.js'
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
