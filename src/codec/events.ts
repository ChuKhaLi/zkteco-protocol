import { CMD } from './commands.js'
import { encodePayload, type DecodedPacket } from './packet.js'
import { decodeZkTime6 } from './time.js'
import type { ZkNaiveTime, ZkRealtimeEvent } from '../types.js'

/**
 * Realtime event flags, as published.
 *
 * The gap at 64 is in the source material, not an omission here: no flag is
 * documented at that bit.
 */
export const EVENT_FLAG = {
  ATTENDANCE: 1,
  FINGER: 2,
  ENROLL_USER: 4,
  ENROLL_FINGER: 8,
  BUTTON: 16,
  UNLOCK: 32,
  VERIFY: 128,
  FPFTR: 256,
  ALARM: 512,
} as const

/** The 4-byte little-endian mask CMD_REG_EVENT carries. */
export function encodeEventMask(mask: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(mask >>> 0, 0)
  return buf
}

/**
 * True when a decoded packet is an unsolicited realtime event.
 *
 * A device pushes these with the same command it was registered with. This
 * is deliberately the only test applied: the reply id is also believed to be
 * zero on every pushed packet, but adding that to the predicate would make a
 * device that numbers its pushes look like a non-event packet, which ends the
 * stream (spec §9.3). One condition, evidenced by two sources, is enough.
 */
export function isEventPacket(pkt: DecodedPacket): boolean {
  return pkt.command === CMD.REG_EVENT
}

/**
 * The event type of a pushed packet.
 *
 * It occupies the field that carries a session id in every other packet. Two
 * independent sources agree on that — the protocol documentation writes these
 * packets with an event where a session id would be and no session id at all,
 * and zkteco-js reads the type from that same offset — and neither source is
 * a device. First-hardware checklist item.
 */
export function readEventType(pkt: DecodedPacket): number {
  return pkt.sessionId
}

/** Smallest payload that can hold the documented large layout. */
const LARGE_MIN_LENGTH = 32
/** The only length the small dialect has ever been observed at. */
const SMALL_LENGTH = 10
const PRINTED_ID_LENGTH = 9
const PRINTED_ID_OFFSET = 0
const VERIFY_MODE_OFFSET = 24
const LARGE_TIME_OFFSET = 26
const SMALL_UID_OFFSET = 0
const SMALL_TIME_OFFSET = 4

export interface RealtimeAttendance {
  /** The identifier printed on the device, or null when none was sent. */
  userId: string | null
  /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
  uid: number | null
  timestamp: ZkNaiveTime
  /** Raw verification method. Model-dependent, deliberately not decoded. */
  verifyMode: number | null
}

/**
 * Reads a fixed-width identifier field, or returns null if it holds anything
 * that is not a printable identifier.
 *
 * Deliberately not `readNulTerminated` from records/shared.ts: that decodes
 * with Node's 'ascii', which MASKS THE HIGH BIT, so a field of 0xc1 0xc2 0xc3
 * reads back as "ABC" — a fabricated identity that no caller could tell from
 * a real one. The bytes are validated before they are decoded.
 */
function readPrintableId(buf: Buffer, start: number, length: number): string | null {
  const field = buf.subarray(start, start + length)
  const nul = field.indexOf(0)
  const body = field.subarray(0, nul === -1 ? field.length : nul)
  if (body.length === 0) return null
  for (const byte of body) {
    if (byte < 0x20 || byte > 0x7e) return null
  }
  return body.toString('ascii')
}

/**
 * Decodes a realtime attendance payload, or returns null when its length
 * matches no known dialect.
 *
 * Dialect selection is by LENGTH, never by transport. zkteco-js picks its
 * decoder by transport — one layout on TCP, another on UDP — which conflates
 * a model-dependent record dialect with the socket it arrived on. Record
 * dialects in this protocol already vary by model (8/16/40-byte attendance
 * records), and nothing about a datagram makes a device pack a timestamp
 * differently.
 *
 * The large dialect is documented at exactly 32 bytes; observed packets carry
 * 36. The four extra bytes are undocumented, are not interpreted, and survive
 * in the caller's `raw`. Hence `>=` rather than `===`: a device with trailing
 * bytes is decoded rather than discarded. First-hardware checklist item.
 */
export function decodeRealtimeAttendance(data: Buffer): RealtimeAttendance | null {
  if (data.length >= LARGE_MIN_LENGTH) {
    return {
      userId: readPrintableId(data, PRINTED_ID_OFFSET, PRINTED_ID_LENGTH),
      uid: null,
      verifyMode: data.readUInt16LE(VERIFY_MODE_OFFSET),
      timestamp: decodeZkTime6(data, LARGE_TIME_OFFSET),
    }
  }
  if (data.length === SMALL_LENGTH) {
    // The uid field's width rests on a SINGLE source, which read one byte.
    // One source cannot distinguish a uint8 from a uint16 LE holding a small
    // value, and the protocol documentation does not describe this dialect at
    // all. First-hardware checklist item.
    return {
      userId: null,
      uid: data.readUInt8(SMALL_UID_OFFSET),
      verifyMode: null,
      timestamp: decodeZkTime6(data, SMALL_TIME_OFFSET),
    }
  }
  return null
}

/**
 * Maps a pushed packet onto the public event type.
 *
 * Anything not decodable becomes `kind: 'unknown'` carrying its bytes.
 * Nothing is ever decoded partially, and an unknown event never ends a
 * stream — an unfamiliar dialect should be reportable, not invisible.
 */
export function decodeRealtimeEvent(pkt: DecodedPacket): ZkRealtimeEvent {
  const eventType = readEventType(pkt)
  const raw = pkt.data.toString('hex')
  if (eventType !== EVENT_FLAG.ATTENDANCE) return { kind: 'unknown', eventType, raw }
  const decoded = decodeRealtimeAttendance(pkt.data)
  if (!decoded) return { kind: 'unknown', eventType, raw }
  return {
    kind: 'attendance',
    eventType,
    userId: decoded.userId,
    userIdSource: decoded.userId === null ? null : 'device',
    uid: decoded.uid,
    timestamp: decoded.timestamp,
    verifyMode: decoded.verifyMode,
    raw,
  }
}

/**
 * Builds the acknowledgment a client is documented to send after each event.
 *
 * The protocol documentation says the client answers every pushed event with
 * CMD_ACK_OK, carrying the session id and a zero reply number. Reading
 * `zkteco-js` shows no acknowledgment code path anywhere, on either
 * transport, and that source reading is what decides this: `pyzk` never sent
 * CMD_REG_EVENT at all, so it contributed no evidence either way (design spec
 * §8.1's fourth branch), and §8.1 applied to that single source says this
 * library does not acknowledge.
 *
 * The realtime capture corroborates it only weakly. `zkteco-js` registered on
 * both transports and then sent nothing further but CMD_EXIT while the
 * emulator pushed three attendance events — but the same investigation shows
 * its decoder never recognised those events at all, so it may simply never
 * have had one to acknowledge. Do not read the capture as the finding; see
 * PROVENANCE.md §3.
 *
 * `ackEvent` stays here, tested and called from nowhere, exactly as
 * `applyReplyIdQuirk` does — internal to the package, never part of the
 * published API, and one call site away in `Session.subscribe`. If the
 * first real terminal delivers exactly one event and then goes silent, this
 * is the first thing to try.
 */
export function ackEvent(sessionId: number, replyId = 0): Buffer {
  return encodePayload({ command: CMD.ACK_OK, sessionId, replyId })
}
