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

export type ChecksumClass = 'self' | 'previous-reply-id' | 'ambiguous' | 'neither'

/**
 * Decides which reply id a captured packet's checksum was computed over.
 *
 * 'self'               — the checksum matches the packet as transmitted.
 * 'previous-reply-id'  — the checksum matches the same packet with replyId - 1,
 *                        which is the quirk this library implements.
 * 'ambiguous'          — both 'self' and 'previous-reply-id' produce the same checksum.
 *                        This occurs when replyId === 0 because one's-complement folding
 *                        makes 0x0000 and (0 - 1) & 0xffff = 0xFFFF arithmetically
 *                        identical in the checksum computation.
 * 'neither'            — something else is going on; investigate before
 *                        trusting any of it.
 */
export function classifyChecksum(p: CapturedPacket, dataHexAfterHeader = ''): ChecksumClass {
  const data = Buffer.from(dataHexAfterHeader, 'hex')
  const asSent = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: p.replyId, data,
  })
  const checksumSelf = checksum16(asSent)
  const asPrevious = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: (p.replyId - 1) & 0xffff, data,
  })
  const checksumPrevious = checksum16(asPrevious)

  if (checksumSelf === checksumPrevious) return 'ambiguous'
  if (checksumSelf === p.checksum) return 'self'
  if (checksumPrevious === p.checksum) return 'previous-reply-id'
  return 'neither'
}
