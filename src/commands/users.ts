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
 */
export async function getUsers(
  session: Session,
  transport: 'tcp' | 'udp',
): Promise<ZkUser[]> {
  const stream = await readBulk(session, CMD.USERTEMP_RRQ, transport)
  return parseUserData(stream)
}
