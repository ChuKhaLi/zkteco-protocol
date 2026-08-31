import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'
import { START_MARKER } from '../../src/codec/framing.js'

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
 * 'ambiguous'          — both 'self' and 'previous-reply-id' produce the same checksum,
 *                        AND that shared value is the one transmitted. This occurs when
 *                        replyId === 0 because one's-complement folding makes 0x0000 and
 *                        (0 - 1) & 0xffff = 0xFFFF arithmetically identical in the
 *                        checksum computation. The tie means the two hypotheses cannot be
 *                        told apart; it does NOT mean the packet is sound, so a tie the
 *                        transmitted checksum does not match is 'neither', not this.
 * 'neither'            — something else is going on; investigate before
 *                        trusting any of it.
 *
 * Data is extracted from p.hex instead of taken as a parameter because a caller
 * should never need to juggle packet bytes manually. An optional parameter that
 * defaults to empty is a silent wrong answer waiting for someone calling the
 * obvious way.
 */
export function classifyChecksum(p: CapturedPacket): ChecksumClass {
  const buf = Buffer.from(p.hex, 'hex')
  let dataStart = 0

  // If the packet is TCP-framed, skip the 8-byte TCP prefix (marker + length).
  if (buf.length >= 4 && buf.subarray(0, 4).equals(START_MARKER)) {
    dataStart = 8
  }

  // Skip the 8-byte payload header (command, checksum, sessionId, replyId).
  dataStart += 8

  // The remainder is the packet data.
  const data = Buffer.from(buf.subarray(dataStart))

  const asSent = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: p.replyId, data,
  })
  const checksumSelf = checksum16(asSent)
  const asPrevious = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: (p.replyId - 1) & 0xffff, data,
  })
  const checksumPrevious = checksum16(asPrevious)

  // The tie is checked first so a genuine tie never reports as 'self', but it
  // only yields 'ambiguous' when the transmitted checksum is one the tie
  // actually produced. A tie matching nothing is a corrupt or foreign packet,
  // and falls through to 'neither' with the rest of them.
  if (checksumSelf === checksumPrevious) {
    return checksumSelf === p.checksum ? 'ambiguous' : 'neither'
  }
  if (checksumSelf === p.checksum) return 'self'
  if (checksumPrevious === p.checksum) return 'previous-reply-id'
  return 'neither'
}
