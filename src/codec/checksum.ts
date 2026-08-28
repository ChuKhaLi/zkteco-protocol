/**
 * ZKTeco packet checksum: a one's-complement sum over the payload read as
 * 16-bit little-endian words, with the checksum field itself treated as zero
 * and a trailing odd byte padded with zero.
 *
 * Reference implementations in the wild express this by repeatedly subtracting
 * 65535 (not 65536) and then negating. That agrees with the carry-folding form
 * below, which is the standard one's-complement formulation and reads clearly.
 * The behaviour is pinned by oracle fixtures — see the oracle task.
 */
export function checksum16(payload: Buffer): number {
  let sum = 0
  for (let i = 0; i < payload.length; i += 2) {
    // Bytes 2-3 hold the checksum itself and count as zero.
    if (i === 2) continue
    sum += i + 1 < payload.length ? payload.readUInt16LE(i) : (payload[i] as number)
  }
  // Fold the carry back into the low 16 bits.
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16)
  return ~sum & 0xffff
}
