import { CMD } from '../codec/commands.js'
import { parseUserData } from '../codec/records/user.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkUser } from '../types.js'

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
  const stream = await readBulk(session, CMD.USERTEMP_RRQ, transport)
  return parseUserData(stream, userCount)
}
