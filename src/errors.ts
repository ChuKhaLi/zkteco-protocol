export class ZkError extends Error {
  /** Hex of the bytes that caused this error, when any exist. */
  readonly raw?: string

  constructor(message: string, raw?: Buffer) {
    super(message)
    this.name = new.target.name
    if (raw) this.raw = raw.toString('hex')
  }
}

/** Socket refused, closed, or unreachable. */
export class ZkConnectionError extends ZkError {}

/** The device stayed silent past the deadline. */
export class ZkTimeoutError extends ZkError {}

/** The comm key was rejected. */
export class ZkAuthError extends ZkError {}

/** The device replied with an error code, or a malformed packet arrived. */
export class ZkProtocolError extends ZkError {}

/**
 * Record framing failed validation. Deliberately its own class rather than a
 * ZkProtocolError subtype: callers must be able to tell "the device reported a
 * failure" apart from "these bytes may be misaligned, trust nothing parsed
 * from them".
 */
export class ZkFramingError extends ZkError {}
