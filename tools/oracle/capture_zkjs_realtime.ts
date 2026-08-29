/**
 * Drives zkteco-js's realtime path (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 */
import ZKLib from 'zkteco-js'

const port = Number(process.argv[2])
const transport = process.argv[3]

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
      // Same workaround as capture_zkjs.ts: zkteco-js's TCP-to-UDP fallback
      // checks `err.code` on a wrapper object that never carries one, so the
      // UDP branch is unreachable. Drive its own ZUDP instance directly, so
      // the bytes on the wire are still entirely zkteco-js's construction.
      await device.zudp.createSocket()
      await device.zudp.connect()
      device.connectionType = 'udp'
      await device.zudp.getRealTimeLogs(() => {})
    } else {
      await device.createSocket()
      await device.ztcp.getRealTimeLogs(() => {})
    }
    // Stay alive long enough for the pushed events to arrive and for any
    // acknowledgment the library might send to be recorded.
    await new Promise((r) => setTimeout(r, 800))
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
