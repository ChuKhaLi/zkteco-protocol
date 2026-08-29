import { CMD } from '../codec/commands.js'
import { DEVICE_PARAM, decodeParamReply, encodeParamRequest } from '../codec/params.js'
import { decodeZkTime } from '../codec/time.js'
import { readNulTerminated } from '../codec/records/shared.js'
import { ZkProtocolError } from '../errors.js'
import type { Session } from '../session/Session.js'
import type { ZkDeviceIdentity, ZkNaiveTime } from '../types.js'

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
 * ACK_UNAUTH is treated as ZkProtocolError, not as a refusal or a value.
 * tryExecute() only throws on ACK_ERROR, so without this check any other
 * reply command — including ACK_UNAUTH — would reach decodeParamReply() and
 * either be parsed as a plausible value or (with an empty body) mistaken for
 * an empty-value answer. ACK_UNAUTH is singled out, and only it: it is the
 * one non-acknowledgment code this codebase already assigns a meaning to
 * (Session.open handles it during the comm-key handshake), so it cannot be a
 * genuine parameter reply under any reading. Tightening this further to
 * "only ACK_OK counts as success" is deliberately NOT done — nothing
 * confirms real firmware acknowledges CMD_OPTIONS_RRQ with ACK_OK rather
 * than, say, ACK_DATA, and inventing that constraint would be exactly the
 * kind of unevidenced hypothesis this project avoids.
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
    if (res.command === CMD.ACK_UNAUTH) {
      throw new ZkProtocolError(`CMD_OPTIONS_RRQ for ${key} answered ACK_UNAUTH`, res.data)
    }
    out[key] = decodeParamReply(key, res.data)
  }
  return out
}

/** The parameter keyword behind each ZkDeviceIdentity field. */
const IDENTITY_KEYS = {
  serialNumber: DEVICE_PARAM.SERIAL_NUMBER,
  deviceName: DEVICE_PARAM.DEVICE_NAME,
  platform: DEVICE_PARAM.PLATFORM,
  os: DEVICE_PARAM.OS,
} as const

/**
 * Reads the firmware version.
 *
 * CMD_GET_VERSION is NOT a parameter read: it takes an empty payload and
 * answers with the firmware string as the whole body — no keyword, no '=',
 * and so nothing to check the echo of. Do not fold this into the parameter
 * path; the echo guard would have nothing to verify and would reject a
 * perfectly good reply.
 *
 * This is the read in the library with no other validation of any kind — no
 * echo, no length check, nothing but the ACK_ERROR branch below — so an
 * ACK_UNAUTH reply here is the case with nothing else to catch it: an empty
 * body would otherwise decode to firmwareVersion: '', indistinguishable from
 * a device that genuinely answered with no value. See the ACK_UNAUTH comment
 * on getParameters() above; the same reasoning applies here.
 */
async function readFirmware(session: Session): Promise<string | null> {
  const res = await session.tryExecute(CMD.GET_VERSION)
  if (res.command === CMD.ACK_ERROR) return null
  if (res.command === CMD.ACK_UNAUTH) {
    throw new ZkProtocolError('CMD_GET_VERSION answered ACK_UNAUTH', res.data)
  }
  return readNulTerminated(res.data, 0, res.data.length)
}

/**
 * Reads what the device says about itself: five fields, five round trips,
 * strictly sequential because the transport rejects overlapping receives.
 *
 * A consumer that needs only one field should call getParameters with just
 * that keyword and pay for one round trip. This is the convenience, not the
 * primitive.
 */
export async function getIdentity(session: Session): Promise<ZkDeviceIdentity> {
  const params = await getParameters(session, Object.values(IDENTITY_KEYS))
  const firmwareVersion = await readFirmware(session)
  // `?? null` fills in only for a key getParameters OMITTED, which is exactly
  // the ACK_ERROR refusal. An empty-string value is neither null nor
  // undefined, so it survives this intact and stays distinguishable from a
  // refusal — see the ZkDeviceIdentity docblock.
  return {
    serialNumber: params[IDENTITY_KEYS.serialNumber] ?? null,
    deviceName: params[IDENTITY_KEYS.deviceName] ?? null,
    platform: params[IDENTITY_KEYS.platform] ?? null,
    os: params[IDENTITY_KEYS.os] ?? null,
    firmwareVersion,
  }
}

/**
 * Reads the device's own clock.
 *
 * Returns ZkNaiveTime, never a Date: the device records naive local time with
 * no offset, and a Date would bind it to the decoding process's timezone —
 * right by accident near the device, hours wrong in CI, silent either way.
 *
 * Uses execute(), not tryExecute(): unlike a parameter keyword, a device with
 * no clock command is a protocol failure rather than an answer, and the
 * return type is not nullable.
 *
 * The 31-day pseudo-calendar can legitimately decode to a date like
 * 2026-02-31. That is returned verbatim — see decodeZkTime.
 */
export async function getTime(session: Session): Promise<ZkNaiveTime> {
  const res = await session.execute(CMD.GET_TIME)
  // Symmetric with getParameters and readFirmware, and for a sharper reason
  // than either. A parameter reply that is not an answer is caught by the echo
  // check; a short clock reply is caught by the length check below. But four
  // bytes of a reply that acknowledges nothing decode to a perfectly
  // valid-looking date, and decodeZkTime has no notion of an implausible one —
  // so this is the most convincing wrong answer the library could return.
  // ACK_UNAUTH only, for the same reason as the other two: it is the one
  // non-acknowledgment this codebase already assigns a meaning to, and
  // tightening to "only ACK_OK counts" would invent a constraint no device has
  // confirmed.
  if (res.command === CMD.ACK_UNAUTH) {
    throw new ZkProtocolError('CMD_GET_TIME answered ACK_UNAUTH', res.data)
  }
  if (res.data.length < 4) {
    throw new ZkProtocolError(
      `CMD_GET_TIME reply is ${res.data.length} bytes, need at least 4`,
      res.data,
    )
  }
  return decodeZkTime(res.data.readUInt32LE(0))
}
