/**
 * A wall-clock reading with NO timezone and NO offset, exactly as the device
 * recorded it.
 *
 * The library never returns a JavaScript `Date`. A `Date` would silently bind
 * this reading to the timezone of whatever process decoded it: correct by
 * accident on a machine in the same zone as the device, hours wrong in CI, and
 * nothing anywhere reports an error. Apply a timezone yourself, deliberately.
 */
export interface ZkNaiveTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** "2026-08-27T08:01:00" — deliberately carries no offset. */
  readonly local: string
}

/** One badge event, exactly as the device reported it. */
export interface ZkAttendanceLog {
  /**
   * The identifier printed on the device. `null` when the device did not send
   * it and no lookup matched. Never fabricated — a null beats a wrong name.
   */
  userId: string | null

  /**
   * Where `userId` came from:
   *   'device' — sent verbatim in the record (40-byte dialect). Trustworthy.
   *   'lookup' — resolved through the user list. MAY BE WRONG: device-internal
   *              uids are recycled after a user is deleted, so a punch by the
   *              previous holder resolves against the current table and is
   *              attributed to the wrong person, with no error anywhere.
   *   null     — could not be determined.
   */
  userIdSource: 'device' | 'lookup' | null

  /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
  uid: number | null

  timestamp: ZkNaiveTime

  /** Raw status code. Meaning VARIES BY MODEL — deliberately not decoded. */
  status: number

  /** Raw verification method. Also model-dependent, also not decoded. */
  verifyMode: number

  /** Which dialect this record was decoded from. */
  recordSize: 8 | 16 | 40

  /** Hex of the original record bytes, for reconciliation. */
  raw: string
}

/** One enrolled user, as the device stores them. */
export interface ZkUser {
  /** Device-internal key. Recycled after deletion — NOT an identity. */
  uid: number
  /** The identifier printed on the device. A string, so leading zeros survive. */
  userId: string
  name: string
  /** Raw privilege level. Model-dependent, deliberately not decoded. */
  privilege: number
  /** True when a password is set. The password itself is never returned. */
  hasPassword: boolean
  /** Raw card number, 0 when unset. */
  cardNumber: number
  /** Hex of the original record bytes. */
  raw: string
}
