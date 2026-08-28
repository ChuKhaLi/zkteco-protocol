import type { ZkNaiveTime } from '../types.js'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function make(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
): ZkNaiveTime {
  return {
    year, month, day, hour, minute, second,
    local:
      `${pad(year, 4)}-${pad(month)}-${pad(day)}` +
      `T${pad(hour)}:${pad(minute)}:${pad(second)}`,
  }
}

/**
 * Unpacks the 4-byte device timestamp.
 *
 * The device packs time through a pseudo-calendar of 31-day months and
 * 12-month years, not a real one. A consequence worth knowing: this can
 * legitimately yield 2026-02-31. That is not corrected, filtered, or rejected
 * here — the device packed it, so the caller sees it, alongside the raw bytes.
 */
export function decodeZkTime(t: number): ZkNaiveTime {
  let v = t >>> 0
  const second = v % 60; v = Math.floor(v / 60)
  const minute = v % 60; v = Math.floor(v / 60)
  const hour = v % 24; v = Math.floor(v / 24)
  const day = (v % 31) + 1; v = Math.floor(v / 31)
  const month = (v % 12) + 1; v = Math.floor(v / 12)
  return make(v + 2000, month, day, hour, minute, second)
}

/**
 * Unpacks the 6-byte form used elsewhere in the protocol: one byte each for
 * year-2000, month, day, hour, minute, second. Do not confuse it with the
 * packed uint32 form above.
 */
export function decodeZkTime6(buf: Buffer, offset = 0): ZkNaiveTime {
  return make(
    2000 + (buf[offset] as number),
    buf[offset + 1] as number,
    buf[offset + 2] as number,
    buf[offset + 3] as number,
    buf[offset + 4] as number,
    buf[offset + 5] as number,
  )
}
