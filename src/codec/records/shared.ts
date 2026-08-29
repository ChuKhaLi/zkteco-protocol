/**
 * Reads a fixed-width field and truncates at the first NUL byte.
 * Never reads past the field's own bounds.
 *
 * Decodes latin1, NOT ascii. Node's 'ascii' is latin1 with the high bit
 * stripped, so a device sending a name outside ASCII returns a well-typed,
 * plausible-looking, WRONG string with no way to recover the original bytes
 * and nothing anywhere reporting an error. latin1 is byte-preserving: a
 * consumer that needs the real characters gets them back with
 * `Buffer.from(value, 'latin1')` and the device's actual encoding.
 *
 * Which encoding devices really use is unknown and is item 20 on the
 * first-hardware checklist. latin1 is the decoding that keeps that question
 * answerable.
 */
export function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1')
}
