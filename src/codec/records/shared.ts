/**
 * Reads a fixed-width field and truncates at the first NUL byte.
 * Never reads past the field's own bounds.
 */
export function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('ascii')
}
