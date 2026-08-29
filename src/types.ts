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
  /** Hex of the record bytes, with the 8-byte password field zeroed. Not a byte-for-byte copy; the password is redacted because `raw` is meant to be persisted and forwarded for reconciliation. */
  raw: string
}

/** Counters the device reports about its own storage. */
export interface ZkDeviceInfo {
  userCount: number
  recordCount: number
  recordCapacity: number
}

/**
 * One event a device pushed while a subscription was active.
 *
 * Deliberately NOT a `ZkAttendanceLog`. The realtime payload carries no
 * in/out status field and belongs to no 8/16/40-byte record dialect, so
 * reusing that type would mean fabricating both `status` and `recordSize`.
 */
export type ZkRealtimeEvent =
  | {
      kind: 'attendance'
      /** The EVENT_FLAG value the device pushed this under. */
      eventType: number
      /**
       * The identifier printed on the device. `null` when the dialect carried
       * none — never an empty string, and never resolved through the user
       * list: device-internal uids are recycled after a deletion, so a lookup
       * can attribute a punch to the wrong person with no error anywhere.
       */
      userId: string | null
      /** 'device' when the record itself supplied the id, null when it did not. */
      userIdSource: 'device' | null
      /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
      uid: number | null
      timestamp: ZkNaiveTime
      /** Raw verification method. Model-dependent, deliberately not decoded. */
      verifyMode: number | null
      /** Hex of the event payload. */
      raw: string
    }
  | {
      kind: 'unknown'
      eventType: number
      /** Hex of the event payload, undecoded and complete. */
      raw: string
    }
