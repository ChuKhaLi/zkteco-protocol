import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../src/codec/commands.js'
import { ZkDevice } from '../src/ZkDevice.js'
import { ZkConnectionError } from '../src/errors.js'
import { startEmulator, type Emulator } from './emulator/index.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
afterEach(async () => {
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

const DAY = 86_400

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt32LE(t, 27)
  return b
}

for (const transport of ['tcp', 'udp'] as const) {
  describe(`ZkDevice over ${transport}`, () => {
    it('connects, reads counters, reads logs, disconnects', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 3, recordCount: 1, recordCapacity: 100_000 },
        records: { size: 40, rows: [rec40(1, '000123', DAY)] },
      })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      expect(await device.getInfo()).toEqual({
        userCount: 3, recordCount: 1, recordCapacity: 100_000,
      })
      const logs = await device.getAttendanceLogs()
      expect(logs[0]).toMatchObject({ userId: '000123', userIdSource: 'device' })
      await device.disconnect()
      device = null
    })

    it('is safe to disconnect twice', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      await device.disconnect()
      await expect(device.disconnect()).resolves.toBeUndefined()
      device = null
    })

    it('closes the first session before opening a second, rather than leaking it', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      await device.connect()
      // Proof of teardown, not just that the second connect() resolved: the
      // first session's close() sends CMD_EXIT before the second handshake
      // opens. A leaked first session never sends it, so this count would be
      // 0 with the guard removed. Checked before disconnect() so its own
      // EXIT can't be mistaken for the one under test.
      const exits = running.received.filter((p) => p.command === CMD.EXIT)
      expect(exits).toHaveLength(1)
      // The instance must still be fully usable afterwards, not half torn down.
      await expect(device.getInfo()).resolves.toEqual({
        userCount: 0, recordCount: 0, recordCapacity: 0,
      })
      await device.disconnect()
      device = null
    })

    it('is safe to disconnect without ever connecting', async () => {
      device = new ZkDevice({ host: '127.0.0.1', port: 4370, transport })
      await expect(device.disconnect()).resolves.toBeUndefined()
      device = null
    })

    it('refuses to run a command before connect', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await expect(device.getInfo()).rejects.toBeInstanceOf(ZkConnectionError)
      device = null
    })
  })
}

describe('ZkDevice defaults', () => {
  it('defaults to the TCP transport', async () => {
    running = await startEmulator({ transport: 'tcp' })
    // Explicit port so the test can reach the emulator; transport is left out.
    device = new ZkDevice({ host: '127.0.0.1', port: running.port })
    await device.connect()
    expect(running.transport).toBe('tcp')
    await device.disconnect()
    device = null
  })
})
