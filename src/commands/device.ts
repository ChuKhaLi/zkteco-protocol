import { CMD } from '../codec/commands.js'
import { decodeParamReply, encodeParamRequest } from '../codec/params.js'
import type { Session } from '../session/Session.js'

/**
 * Reads named device parameters.
 *
 * A key the device REFUSED (ACK_ERROR) is omitted from the result rather than
 * set to undefined, so `key in result` answers exactly "did the device answer
 * this" and no default is invented for a key that was never supplied. A key
 * the device answered with an EMPTY value is present with '' — the two are
 * kept apart because which of them a firmware uses for an unsupported
 * parameter is unknown, and is checklist item 16.
 *
 * Every other failure — timeout, dropped connection, malformed reply, an echo
 * that does not match — propagates out of this loop untouched, abandoning the
 * remaining reads. There is no partial result and no salvage: a function that
 * turned five failures into five absences would be indistinguishable from a
 * device that exposes nothing.
 *
 * Strictly sequential. The transport rejects a second receive() while one is
 * already in flight.
 */
export async function getParameters(
  session: Session,
  keys: readonly string[],
): Promise<Record<string, string>> {
  // Object.create(null), not {}: `key in out` is the documented presence
  // idiom above, and a plain object answers it WRONG for a key that
  // collides with an Object.prototype member name (e.g. 'toString') —
  // `in` would report true via the prototype chain even though the device
  // never answered and the key was never assigned. A null prototype has no
  // inherited members, so `in` sees only what this loop actually assigned.
  const out: Record<string, string> = Object.create(null)
  for (const key of keys) {
    const res = await session.tryExecute(CMD.OPTIONS_RRQ, encodeParamRequest(key))
    if (res.command === CMD.ACK_ERROR) continue
    out[key] = decodeParamReply(key, res.data)
  }
  return out
}
