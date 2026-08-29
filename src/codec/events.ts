import { CMD } from './commands.js'
import type { DecodedPacket } from './packet.js'

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
