export const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLEDEVICE: 1002,
  DISABLEDEVICE: 1003,
  AUTH: 1102,
  OPTIONS_RRQ: 11,
  GET_TIME: 201,
  GET_VERSION: 1100,
  REG_EVENT: 500,
  GET_FREE_SIZES: 50,
  ATTLOG_RRQ: 13,
  USERTEMP_RRQ: 9,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  PREPARE_BUFFER: 1503,
  READ_BUFFER: 1504,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_UNAUTH: 2005,
} as const

/** Maximum bytes requested per chunk, per transport. */
export const MAX_CHUNK = { tcp: 0xffc0, udp: 16 * 1024 } as const

/**
 * The `fct` field of the 11-byte PREPARE_BUFFER request, per command.
 *
 * Restated from zkteco-js `helper/command.js:109-110` (MIT): GET_USERS sends
 * `01 09 00 05 00 00 00 …` (command 9, fct 5) and GET_ATTENDANCE_LOGS sends
 * `01 0d 00 00 00 00 00 …` (command 13, fct 0). Before v0.5 this library sent
 * 0 for both. What fct means is not recorded anywhere readable; only the
 * values are. A command absent here sends 0.
 */
export const BUFFER_FCT: Readonly<Record<number, number>> = {
  [CMD.USERTEMP_RRQ]: 5,
  [CMD.ATTLOG_RRQ]: 0,
}
