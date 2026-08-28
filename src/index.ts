export { ZkDevice, type ZkDeviceOptions } from './ZkDevice.js'
export type { GetAttendanceOptions } from './commands/attendance.js'
export type {
  ZkAttendanceLog,
  ZkDeviceInfo,
  ZkNaiveTime,
  ZkUser,
} from './types.js'
export {
  ZkAuthError,
  ZkConnectionError,
  ZkError,
  ZkFramingError,
  ZkProtocolError,
  ZkTimeoutError,
} from './errors.js'
export { decodeZkTime, decodeZkTime6 } from './codec/time.js'

export const VERSION = '0.1.0'
