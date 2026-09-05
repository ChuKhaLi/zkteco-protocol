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
 * this prefix is removed, so the size is taken to INCLUDE these nine bytes.
 *
 * Experiment E8 tried to settle that and could not: NEITHER oracle implements
 * this prefix. `pyzk` misframes every record when one is present — silently,
 * exit 0, with a fabricated user id — and `zkteco-js` never reads the declared
 * size at all. So this is the one decoding behaviour here that rests on
 * documentation alone; see PROVENANCE.md, *The junk prefix*. If firmware
 * declares a size that EXCLUDES the prefix, this library refuses with
 * ZkFramingError rather than returning misframed records, which
 * test/commands/attendance.spec.ts pins over both transports.
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
 * STILL A HYPOTHESIS, but a narrower one than it was. The record layouts name
 * their fields `status` and `punch`; the public API exposes `status` (in/out)
 * and `verifyMode` (finger/card/face/password). Which feeds which is not
 * settled by the available documentation, so the name-preserving mapping is
 * assumed here and isolated in this one function.
 *
 * The oracle task this docblock used to promise has now RUN — experiment E7,
 * `PROVENANCE.md`, *The status/punch mapping*. It settled the half about
 * OFFSETS: `pyzk` reads these two bytes and no others, in all three dialects,
 * and `zkteco-js`'s source reads the same two for the 40-byte form. It did not
 * settle the half about NAMES, and pointed the other way on it: `zkteco-js`
 * calls byte 26 `type` and byte 31 `state`, so aligning `state` with `status`
 * would swap what this function does. The two oracles do not agree, so per the
 * rule this docblock has always carried, NEITHER mapping is adopted and the
 * divergence is recorded instead.
 *
 * Change this function, and nothing else, when hardware resolves it.
 */
export function mapStatusAndVerify(
  recordStatus: number,
  recordPunch: number,
): { status: number; verifyMode: number } {
  return { status: recordStatus, verifyMode: recordPunch }
}

/**
 * Derives the record size by division.
 *
 * What this refuses: a body that is not a whole number of records, and a
 * quotient that is not a known size. What it CANNOT refuse: a count that is
 * wrong by a divisor of the true size — the known sizes are multiples of one
 * another, so 16 bytes over a count of 1 is "one 16-byte record" whether or
 * not it is really two 8-byte ones. That case is caught one layer up, where
 * getAttendanceLogs reads the count again after the transfer and refuses if
 * it moved. Do not describe this function as refusing a stale count; until
 * v0.5 its docblock did, and the claim was false.
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
    const printedUserId = readNulTerminated(rec, 2, 24)
    return {
      uid: rec.readUInt16LE(0),
      // A blank field must not be reported as a device-supplied identity —
      // '' labelled userIdSource: 'device' is exactly the fabricated
      // identity the public API promises never to hand back (README,
      // spec §4.2). null instead lets this record flow into the same
      // lookup-by-uid path as the 8- and 16-byte dialects.
      userIdFromRecord: printedUserId === '' ? null : printedUserId,
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
