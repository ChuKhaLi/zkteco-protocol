import { CMD } from '../codec/commands.js'
import { parseUserData } from '../codec/records/user.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkUser } from '../types.js'

/**
 * Reads the raw USERTEMP_RRQ stream, without deciding a record width.
 *
 * Split out of `getUsers` so a caller that fetches its own count can put the
 * transfer FIRST and the count read second. That ordering matters because a
 * count read is not free of consequence: a timeout, framing or connection
 * failure ends the session (spec v0.5 §5.2), so a count fetched before the
 * transfer can take the transfer down with it, while a count fetched after it
 * can only cost the count. `ZkDevice.getUsers` is the caller that needs this;
 * `getAttendanceLogs` already reads its count after its own transfer.
 *
 * The returned buffer is the parser's input, header and all — pair it with
 * `parseUserData`, which is where every framing refusal lives.
 */
export async function readUserStream(session: Session, transport: 'tcp' | 'udp'): Promise<Buffer> {
  return readBulk(session, CMD.USERTEMP_RRQ, transport)
}

/**
 * Reads the enrolled user list.
 *
 * This is not an optional convenience: the 8- and 16-byte attendance dialects
 * carry no printed user id, so resolving a punch to a person depends on it.
 *
 * `userCount` is the device's own count from CMD_GET_FREE_SIZES, and it
 * decides the record width (codec/records/user.ts). Pass `null` when no count
 * is available; that is a supported state, not a failure. It is NOT fetched
 * here on purpose -- this function runs inside the attendance poll loop, and
 * a hidden CMD_GET_FREE_SIZES round-trip per poll would keep the terminal
 * busy for the people badging at it. Every caller supplies it.
 */
export async function getUsers(
  session: Session,
  transport: 'tcp' | 'udp',
  userCount: number | null,
): Promise<ZkUser[]> {
  const stream = await readUserStream(session, transport)
  return parseUserData(stream, userCount)
}
