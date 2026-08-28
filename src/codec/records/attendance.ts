import { ZkFramingError } from '../../errors.js'
import { decodeZkTime } from '../time.js'
import type { ZkNaiveTime } from '../../types.js'
import { readNulTerminated } from './shared.js'

const KNOWN_SIZES = [8, 16, 40] as const
export type RecordSize = (typeof KNOWN_SIZES)[number]

/**
 * A junk prefix observed at the head of some 40-byte payloads. Documented
 * device behaviour, not evidence of corruption, so it is skipped rather than
 * thrown on. Its exact relationship to the declared totalSize is unverified
 * until real hardware is available — the guards below run on the body AFTER
 * this prefix is removed.
 */
const JUNK_PREFIX = Buffer.from([0xff, 0x32, 0x35, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00])

export interface DecodedAttendanceRecord {
  uid: number | null
  userIdFromRecord: string | null
  numericUserId: number | null
  timestamp: ZkNaiveTime
  status: number
  verifyMode: number
  recordSize: RecordSize
  raw: string
}

/**
 * Maps the two model-dependent bytes a record carries onto the two the public
 * API exposes.
 *
 * HYPOTHESIS. The record layouts name their fields `status` and `punch`; the
 * public API exposes `status` (in/out) and `verifyMode` (finger/card/face/
 * password). Which feeds which is not settled by the available documentation,
 * so the name-preserving mapping is assumed here and isolated in this one
 * function. The oracle task decodes identical record bytes with two
 * independent implementations and adopts their mapping only if they agree; if
 * they disagree, the divergence is recorded and left for first-hardware
 * verification. Change this function, and nothing else, when that resolves.
 */
export function mapStatusAndVerify(
  recordStatus: number,
  recordPunch: number,
): { status: number; verifyMode: number } {
  return { status: recordStatus, verifyMode: recordPunch }
}

/**
 * Derives the record size by division, and refuses to guess.
 *
 * If `recordCount` is even slightly stale — somebody badged between the
 * counter read and the buffer read — the quotient is garbage and a parse loop
 * would still run, emitting misaligned records with meaningless identifiers
 * and nonsense timestamps, raising nothing. No data is better than wrong data.
 */
export function detectRecordSize(bodyLength: number, recordCount: number): RecordSize {
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new ZkFramingError(`record count must be a positive integer, got ${recordCount}`)
  }
  if (bodyLength % recordCount !== 0) {
    throw new ZkFramingError(
      `record body of ${bodyLength} bytes does not divide evenly by ${recordCount} records`,
    )
  }
  const size = bodyLength / recordCount
  if (!KNOWN_SIZES.includes(size as RecordSize)) {
    throw new ZkFramingError(
      `derived record size ${size} is not one of ${KNOWN_SIZES.join(', ')}`,
    )
  }
  return size as RecordSize
}

function decodeOne(rec: Buffer, size: RecordSize): DecodedAttendanceRecord {
  const raw = rec.toString('hex')
  if (size === 40) {
    const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(26), rec.readUInt8(31))
    return {
      uid: rec.readUInt16LE(0),
      userIdFromRecord: readNulTerminated(rec, 2, 24),
      numericUserId: null,
      timestamp: decodeZkTime(rec.readUInt32LE(27)),
      status,
      verifyMode,
      recordSize: 40,
      raw,
    }
  }
  if (size === 16) {
    const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(8), rec.readUInt8(9))
    return {
      uid: null,
      userIdFromRecord: null,
      // Rendering this as a string would strip leading zeros and lose the
      // identity. Resolve it through the user list instead.
      numericUserId: rec.readUInt32LE(0),
      timestamp: decodeZkTime(rec.readUInt32LE(4)),
      status,
      verifyMode,
      recordSize: 16,
      raw,
    }
  }
  const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(2), rec.readUInt8(7))
  return {
    uid: rec.readUInt16LE(0),
    userIdFromRecord: null,
    numericUserId: null,
    timestamp: decodeZkTime(rec.readUInt32LE(3)),
    status,
    verifyMode,
    recordSize: 8,
    raw,
  }
}

/**
 * Decodes a complete attendance payload: a 4-byte little-endian totalSize
 * followed by fixed-width records.
 */
export function parseAttendanceData(
  data: Buffer,
  recordCount: number,
): DecodedAttendanceRecord[] {
  if (recordCount === 0) return []
  if (data.length < 4) {
    throw new ZkFramingError('attendance payload too short to hold its size header', data)
  }
  const totalSize = data.readUInt32LE(0)
  if (data.length < 4 + totalSize) {
    throw new ZkFramingError(
      `attendance payload declares ${totalSize} bytes but only ${data.length - 4} arrived`,
      data.subarray(0, 16),
    )
  }

  let body = data.subarray(4, 4 + totalSize)
  if (body.subarray(0, JUNK_PREFIX.length).equals(JUNK_PREFIX)) {
    body = body.subarray(JUNK_PREFIX.length)
  }

  const size = detectRecordSize(body.length, recordCount)
  const out: DecodedAttendanceRecord[] = []
  for (let off = 0; off + size <= body.length; off += size) {
    out.push(decodeOne(body.subarray(off, off + size), size))
  }
  return out
}
