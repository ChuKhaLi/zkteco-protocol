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
   * reading the user list. Defaults to true. Turning it off skips a full
   * download of the user list on every call — not one round-trip — and leaves
   * `userId` null for those dialects.
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
  byNumericUserId: Map<number, ZkUser | null>,
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
  // No match means no identity, and so does an ambiguous one (null in
  // byNumericUserId marks a numeric key two users share) or a blank printed
  // id. Never fabricate — a null beats a name that belongs to somebody else.
  if (!match || match.userId === '') return { userId: null, userIdSource: null }
  return { userId: match.userId, userIdSource: 'lookup' }
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
  // `after` is the count read AFTER the attendance transfer, so it is the
  // freshest one this call holds and it costs no extra round-trip -- which is
  // the whole reason getUsers does not fetch a count itself.
  const users = needsLookup ? await getUsers(session, transport, after.userCount) : []
  const byUid = new Map(users.map((u) => [u.uid, u]))
  // The 16-byte dialect carries a numeric user id, so match on the numeric
  // value of the printed one. Leading zeros survive because the string from
  // the user list is what gets returned — which is also why '1' and '01' are
  // two users sharing one numeric key: that key is marked ambiguous (null)
  // and resolves to no identity rather than to whichever was listed last.
  const byNumericUserId = new Map<number, ZkUser | null>()
  for (const u of users) {
    if (!/^\d+$/.test(u.userId)) continue
    const n = Number(u.userId)
    byNumericUserId.set(n, byNumericUserId.has(n) ? null : u)
  }

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
