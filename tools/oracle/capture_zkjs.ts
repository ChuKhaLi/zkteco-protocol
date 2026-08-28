/**
 * Drives zkteco-js (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 */
import ZKLib from 'zkteco-js'

const port = Number(process.argv[2])
const transport = process.argv[3]

/**
 * zkteco-js's ZkError (src/exceptions/handler.js) wraps the underlying error
 * in a plain object with no Error prototype and no toString(), so
 * `String(err)` on it prints "[object Object]". Pull the useful fields out
 * instead so a capture failure is diagnosable from stderr alone.
 */
function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'getError' in err && typeof err.getError === 'function') {
    return JSON.stringify(err.getError())
  }
  return String(err)
}

async function main(): Promise<void> {
  const device = new ZKLib('127.0.0.1', port, 5000, 5000)
  try {
    if (transport === 'udp') {
      // device.createSocket() tries TCP first and falls back to UDP only on
      // ECONNREFUSED — but its outer catch checks `err.code` on the ZkError
      // *wrapper* thrown by its own inner catch, which has no `.code` field
      // of its own (only `.err.code`). That check is therefore never true,
      // so the UDP branch is unreachable in zkteco-js 1.7.2 whenever the
      // initial TCP attempt fails for any reason. Drive the UDP transport
      // directly through the same public ZUDP instance the library
      // constructs internally, so the bytes on the wire are still entirely
      // zkteco-js's own construction.
      await device.zudp.createSocket()
      await device.zudp.connect()
      device.connectionType = 'udp'
    } else {
      await device.createSocket()
    }
  } catch (err) {
    process.stderr.write(`zkteco-js stopped: ${describeError(err)}\n`)
  } finally {
    try {
      await device.disconnect()
    } catch {
      // the emulator may close first
    }
  }
}

void main()
