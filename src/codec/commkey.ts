const XOR_TAG = [0x5a, 0x4b, 0x53, 0x4f] as const // 'Z', 'K', 'S', 'O'
const DEFAULT_TICKS = 50

/**
 * Mixes the device comm key with the session id into the 4 bytes CMD_AUTH
 * carries.
 *
 * Steps, per the protocol description:
 *   1. Reverse the 32-bit order of the key.
 *   2. Add the session id.
 *   3. Pack little-endian and XOR the bytes with 'Z', 'K', 'S', 'O'.
 *   4. Swap the two 16-bit halves.
 *   5. XOR bytes 0, 1 and 3 with the low byte of `ticks`; ASSIGN byte 2 that
 *      same value. Byte 2 is not XORed. That reads like a typo and is not one.
 *
 * Written from a prose description of the algorithm, never transcribed from a
 * GPL implementation. Pinned by oracle fixtures.
 *
 * The low byte of `sessionId` does not affect the output — see the
 * characterisation test in commkey.spec.ts for why that falls out of steps 2,
 * 4 and 5 structurally. CONFIRMED, not a bug: Task 14's oracle capture shows
 * `pyzk`, driven as a black box, emitting `CMD_AUTH` bytes over both TCP and
 * UDP that match this function's output exactly (spec §A.4, test/oracle/
 * commkey.spec.ts). `zkteco-js` has no comm-key support and offered no
 * second opinion.
 */
export function mixCommKey(commKey: number, sessionId: number, ticks = DEFAULT_TICKS): Buffer {
  // 1. Reverse the bit order: input bit 0 becomes output bit 31.
  let k = 0
  for (let i = 0; i < 32; i++) {
    k = ((k << 1) | ((commKey >>> i) & 1)) >>> 0
  }

  // 2. Add the session id.
  k = (k + (sessionId >>> 0)) >>> 0

  // 3. Pack little-endian, then XOR with the tag characters.
  const packed = Buffer.alloc(4)
  packed.writeUInt32LE(k, 0)
  for (let i = 0; i < 4; i++) {
    packed[i] = (packed[i] as number) ^ (XOR_TAG[i] as number)
  }

  // 4. Swap the two 16-bit halves.
  const out = Buffer.from([packed[2] as number, packed[3] as number, packed[0] as number, packed[1] as number])

  // 5. Apply the tick byte. Byte 2 is assigned, not XORed.
  const b = ticks & 0xff
  out[0] = (out[0] as number) ^ b
  out[1] = (out[1] as number) ^ b
  out[2] = b
  out[3] = (out[3] as number) ^ b

  return out
}
