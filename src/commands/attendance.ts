import { CMD } from '../codec/commands.js'
import { parseAttendanceData, type DecodedAttendanceRecord } from '../codec/records/attendance.js'
import { ZkFramingError } from '../errors.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkAttendanceLog, ZkNaiveTime, ZkUser } from '../types.js'
import { getInfo } from './info.js'
import { getUsers } from './users.js'

export interface GetAttendanceOptions {
  /**
   * Drops records earlier than this, INCLUSIVE of the boundary.
   *
   * CLIENT-SIDE FILTER. The protocol has no "read from timestamp X" capability
   * — the device returns its entire buffer and the filtering happens here,
   * after everything has been downloaded. On a device holding 100,000 records
   * every call re-reads all of them, so a short poll interval will keep the
   * terminal busy and slow to respond to the people badging at it. Poll on the
   * order of minutes, not seconds.
   */
  since?: ZkNaiveTime

  /**
   * Resolve the printed user id for the 8- and 16-byte dialects by also
   * reading the user list. Defaults to true. Turning it off saves one device
   * round-trip and leaves `userId` null for those dialects.
   */
  resolveUserIds?: boolean
}

/** Naive times sort correctly as strings — the format is fixed-width. */
function isAtOrAfter(a: ZkNaiveTime, boundary: ZkNaiveTime): boolean {
  return a.local >= boundary.local
}

function resolve(
  record: DecodedAttendanceRecord,
  byUid: Map<number, ZkUser>,
  byNumericUserId: Map<number, ZkUser>,
): Pick<ZkAttendanceLog, 'userId' | 'userIdSource'> {
  if (record.userIdFromRecord !== null) {
    return { userId: record.userIdFromRecord, userIdSource: 'device' }
  }
  const match =
    record.uid !== null
      ? byUid.get(record.uid)
      : record.numericUserId !== null
        ? byNumericUserId.get(record.numericUserId)
        : undefined
  // No match means no identity. Never fabricate one — a null beats a name that
  // belongs to somebody else.
  return match ? { userId: match.userId, userIdSource: 'lookup' } : { userId: null, userIdSource: null }
}

/** Reads the attendance log. */
export async function getAttendanceLogs(
  session: Session,
  transport: 'tcp' | 'udp',
  opts: GetAttendanceOptions = {},
): Promise<ZkAttendanceLog[]> {
  // The record count is needed before anything else: the framing guard divides
  // by it, and a freshly installed device must not be sent a read at all.
  const { recordCount } = await getInfo(session)
  if (recordCount === 0) return []

  const stream = await readBulk(session, CMD.ATTLOG_RRQ, transport)

  // Read again. The record-size division cannot detect a count that is stale
  // by a divisor — 16 bytes over a count of 1 is one 16-byte record, not two
  // 8-byte ones — so a punch landing between the first count and the read
  // would be parsed misaligned with no error. A count that did not move
  // across the read is the evidence that no such punch landed; a count that
  // did costs this poll, and the next poll recovers. Disabling the device
  // around the read, which is how other implementations avoid this, is a
  // write path and locks employees out (spec v0.5 §7.2).
  const after = await getInfo(session)
  if (after.recordCount !== recordCount) {
    throw new ZkFramingError(
      `the attendance buffer changed during the read: ${recordCount} record(s) before, ${after.recordCount} after`,
    )
  }
  const records = parseAttendanceData(stream, recordCount)

  const needsLookup =
    opts.resolveUserIds !== false && records.some((r) => r.userIdFromRecord === null)
  const users = needsLookup ? await getUsers(session, transport) : []
  const byUid = new Map(users.map((u) => [u.uid, u]))
  // The 16-byte dialect carries a numeric user id, so match on the numeric
  // value of the printed one. Leading zeros survive because the string from
  // the user list is what gets returned.
  const byNumericUserId = new Map(
    users.filter((u) => /^\d+$/.test(u.userId)).map((u) => [Number(u.userId), u]),
  )

  const logs: ZkAttendanceLog[] = records.map((r) => ({
    ...resolve(r, byUid, byNumericUserId),
    uid: r.uid,
    timestamp: r.timestamp,
    status: r.status,
    verifyMode: r.verifyMode,
    recordSize: r.recordSize,
    raw: r.raw,
  }))

  const since = opts.since
  return since ? logs.filter((l) => isAtOrAfter(l.timestamp, since)) : logs
}
