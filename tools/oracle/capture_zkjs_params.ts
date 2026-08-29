/**
 * Drives zkteco-js's device-information reads (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 *
 * The parameter reads and the firmware read are wired for TCP only —
 * zkteco-js wraps them with a TCP callback and no UDP callback, so on UDP it
 * throws before touching the socket. getTime is the exception and has a real
 * UDP implementation, so the UDP run still yields evidence for CMD_GET_TIME.
 * That asymmetry is the point of running both transports here; it is recorded
 * in PROVENANCE.md rather than smoothed over.
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

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    process.stderr.write(`${label} -> ${String(await fn())}\n`)
  } catch (err) {
    process.stderr.write(`${label} failed: ${describeError(err)}\n`)
  }
}

async function main(): Promise<void> {
  const device = new ZKLib('127.0.0.1', port, 5000, 5000)
  try {
    if (transport === 'udp') {
      // Same workaround as capture_zkjs.ts: zkteco-js's TCP-to-UDP fallback
      // checks err.code on a wrapper that never carries one, so its UDP
      // branch is unreachable. Drive its ZUDP instance directly, so the wire
      // bytes are still entirely zkteco-js's construction.
      await device.zudp.createSocket()
      await device.zudp.connect()
      device.connectionType = 'udp'
      await run('udp getTime', () => device.zudp.getTime())
    } else {
      await device.createSocket()
      await run('tcp getSerialNumber', () => device.ztcp.getSerialNumber())
      await run('tcp getDeviceName', () => device.ztcp.getDeviceName())
      await run('tcp getPlatform', () => device.ztcp.getPlatform())
      await run('tcp getOS', () => device.ztcp.getOS())
      await run('tcp getFirmware', () => device.ztcp.getFirmware())
      await run('tcp getTime', () => device.ztcp.getTime())
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
