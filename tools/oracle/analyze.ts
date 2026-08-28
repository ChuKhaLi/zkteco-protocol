import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'

export interface CapturedPacket {
  hex: string
  command: number
  checksum: number
  sessionId: number
  replyId: number
}

export interface OracleFixture {
  source: 'pyzk' | 'zkteco-js'
  transport: 'tcp' | 'udp'
  commKey: number
  emulatorSessionId: number
  packets: CapturedPacket[]
}

export type ChecksumClass = 'self' | 'previous-reply-id' | 'neither'

/**
 * Decides which reply id a captured packet's checksum was computed over.
 *
 * 'self'               — the checksum matches the packet as transmitted.
 * 'previous-reply-id'  — the checksum matches the same packet with replyId - 1,
 *                        which is the quirk this library implements.
 * 'neither'            — something else is going on; investigate before
 *                        trusting any of it.
 */
export function classifyChecksum(p: CapturedPacket, dataHexAfterHeader = ''): ChecksumClass {
  const data = Buffer.from(dataHexAfterHeader, 'hex')
  const asSent = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: p.replyId, data,
  })
  if (checksum16(asSent) === p.checksum) return 'self'
  const asPrevious = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: (p.replyId - 1) & 0xffff, data,
  })
  if (checksum16(asPrevious) === p.checksum) return 'previous-reply-id'
  return 'neither'
}
