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
