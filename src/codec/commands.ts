export const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLEDEVICE: 1002,
  DISABLEDEVICE: 1003,
  AUTH: 1102,
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
