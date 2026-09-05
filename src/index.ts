export { ZkDevice, type ZkDeviceOptions } from './ZkDevice.js'
export type { GetAttendanceOptions } from './commands/attendance.js'
export type {
  ZkAttendanceLog,
  ZkDeviceIdentity,
  ZkDeviceInfo,
  ZkNaiveTime,
  ZkRealtimeEvent,
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
export { EVENT_FLAG } from './codec/events.js'
export { DEVICE_PARAM } from './codec/params.js'
export type { SubscribeOptions, ZkEventStream } from './realtime/Subscription.js'

export const VERSION = '0.6.1'
