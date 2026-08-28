import { CMD } from '../codec/commands.js'
import { ZkProtocolError } from '../errors.js'
import type { Session } from '../session/Session.js'
import type { ZkDeviceInfo } from '../types.js'

/**
 * Byte offsets of the counters inside the CMD_GET_FREE_SIZES reply body, which
 * is an array of little-endian uint32 values.
 *
 * NOT HARDWARE-VERIFIED. These come from protocol documentation and have never
 * been checked against a device. They live here as named constants, used by the
 * library and by the test emulator alike, so that one edit corrects them when
 * a real device contradicts them. See the first-hardware checklist in the spec.
 */
export const FREE_SIZES_OFFSET = {
  userCount: 16,
  recordCount: 32,
  recordCapacity: 64,
} as const

const REQUIRED_LENGTH = FREE_SIZES_OFFSET.recordCapacity + 4

/** Reads the device's own storage counters. */
export async function getInfo(session: Session): Promise<ZkDeviceInfo> {
  const res = await session.execute(CMD.GET_FREE_SIZES)
  if (res.data.length < REQUIRED_LENGTH) {
    throw new ZkProtocolError(
      `CMD_GET_FREE_SIZES reply is ${res.data.length} bytes, need at least ${REQUIRED_LENGTH}`,
      res.data,
    )
  }
  return {
    userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
    recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
    recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
  }
}
