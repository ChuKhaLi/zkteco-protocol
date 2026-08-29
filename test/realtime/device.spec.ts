import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkConnectionError } from '../../src/errors.js'
import { ZkDevice } from '../../src/ZkDevice.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkEventStream } from '../../src/realtime/Subscription.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
let stream: ZkEventStream | null = null
afterEach(async () => {
  await stream?.close().catch(() => {}); stream = null
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

for (const transport of ['tcp', 'udp'] as const) {
  describe(`ZkDevice.subscribe over ${transport}`, () => {
    it('registers with the attendance mask by default', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE)
    })

    it('registers with a caller-supplied mask', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe({ events: EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM })
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM)
    })

    // Without this guard, the pre-existing queue hands the next receive() a
    // pushed event as though it were a reply, and getInfo() decodes a badge
    // as storage counters.
    it('refuses the read commands while subscribed', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await expect(device.getInfo()).rejects.toThrow(ZkConnectionError)
      await expect(device.getUsers()).rejects.toThrow(ZkConnectionError)
      await expect(device.getAttendanceLogs()).rejects.toThrow(ZkConnectionError)
    })

    it('refuses a second subscription on the same device', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await expect(device.subscribe()).rejects.toThrow(ZkConnectionError)
    })

    it('reads normally again after reconnecting', async () => {
      running = await startEmulator({ transport, info: { userCount: 2, recordCount: 0, recordCapacity: 10 } })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await stream.close()
      stream = null
      await device.connect()
      await expect(device.getInfo()).resolves.toMatchObject({ userCount: 2 })
    })

    it('ends the subscription when the device is disconnected', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      const open = await device.subscribe()
      await device.disconnect()
      device = null
      expect(await open[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
    })
  })
}
