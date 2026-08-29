import { ZkProtocolError } from '../errors.js'
import { readNulTerminated } from './records/shared.js'

/**
 * Well-known device parameter keywords.
 *
 * An OBSERVED list, NOT a contract. The keyword set is model- and
 * firmware-dependent: membership here is not a promise that any given device
 * exposes the keyword, and a device that does not will answer ACK_ERROR.
 * `getParameters` accepts any string, not only these.
 *
 * Note that some keywords carry a '~' prefix and some do not. The prefix is
 * part of the keyword; this library neither strips nor adds it.
 */
export const DEVICE_PARAM = {
  SERIAL_NUMBER: '~SerialNumber',
  DEVICE_NAME: '~DeviceName',
  PLATFORM: '~Platform',
  OS: '~OS',
  FP_VERSION: '~ZKFPVersion',
  VENDOR: '~OEMVendor',
  PRODUCT_TIME: '~ProductTime',
  PIN_WIDTH: '~PIN2Width',
  SSR: '~SSR',
  MAC: 'MAC',
  WORK_CODE: 'WorkCode',
  FACE_ON: 'FaceFunOn',
} as const

/**
 * Encodes a CMD_OPTIONS_RRQ request body: the keyword, bare.
 *
 * No NUL terminator and no length prefix — that is what both oracles put on
 * the wire. Whether a real device also accepts a NUL-terminated form is item
 * 18 on the first-hardware checklist.
 *
 * RangeError rather than a Zk* class: a malformed keyword is a bad argument
 * from the caller, not anything the device did, and the published error
 * taxonomy stays as v0.1 shipped it.
 */
export function encodeParamRequest(keyword: string): Buffer {
  if (keyword.length === 0) {
    throw new RangeError('parameter keyword must not be empty')
  }
  if (keyword.includes('=') || keyword.includes('\0')) {
    // A keyword containing '=' would make the echo check in decodeParamReply
    // ambiguous: there would be no way to tell the requested keyword's own
    // separator from the reply's.
    throw new RangeError(
      `parameter keyword must not contain '=' or NUL, got ${JSON.stringify(keyword)}`,
    )
  }
  return Buffer.from(keyword, 'latin1')
}

/**
 * Decodes a CMD_OPTIONS_RRQ reply body of the form `keyword=value`.
 *
 * Verifies that the reply echoes the keyword that was requested, and throws
 * when it does not. The MIT reference implementation instead replaces the
 * `keyword=` prefix with an empty string, which returns the ENTIRE body when
 * the prefix is absent — so a ~Platform reply to a ~DeviceName request would
 * surface the platform as the device name, under a field that says otherwise,
 * with no error anywhere. v0.1 §2.5: an identity is never fabricated.
 *
 * Whether real devices echo at all is item 15 on the first-hardware
 * checklist. If one does not, this throws rather than guesses.
 *
 * An empty value is returned as '' and is a legitimate answer, distinct from
 * the ACK_ERROR refusal that `getParameters` turns into an absent key.
 */
export function decodeParamReply(keyword: string, body: Buffer): string {
  const text = readNulTerminated(body, 0, body.length)
  const sep = text.indexOf('=')
  if (sep === -1) {
    throw new ZkProtocolError(
      `CMD_OPTIONS_RRQ reply for ${keyword} carries no '=' separator`,
      body,
    )
  }
  const echoed = text.slice(0, sep)
  if (echoed !== keyword) {
    throw new ZkProtocolError(
      `CMD_OPTIONS_RRQ reply echoes ${echoed} but ${keyword} was requested`,
      body,
    )
  }
  return text.slice(sep + 1)
}
