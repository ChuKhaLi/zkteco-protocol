import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkConnectionError } from '../../src/errors.js'
import { ZkDevice } from '../../src/ZkDevice.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkEventStream } from '../../src/realtime/Subscription.js'

/**
 * The ZkDevice-level guard's own message. Asserting on this rather than
 * merely `ZkConnectionError` matters: the transport rejects an in-flight
 * receive() while listening with that same error class ("this transport is
 * listening for events; receive() is not available"), so a test that checks
 * only the class would still pass with `requireIdleSession()` deleted — it
 * would be proving that the transport's lower-level check exists, not that
 * this guard does.
 */
const GUARD_MESSAGE = /subscribed to realtime events/

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
      await expect(device.getInfo()).rejects.toThrow(GUARD_MESSAGE)
      await expect(device.getUsers()).rejects.toThrow(ZkConnectionError)
      await expect(device.getUsers()).rejects.toThrow(GUARD_MESSAGE)
      await expect(device.getAttendanceLogs()).rejects.toThrow(ZkConnectionError)
      await expect(device.getAttendanceLogs()).rejects.toThrow(GUARD_MESSAGE)
    })

    it('refuses a second subscription on the same device', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await expect(device.subscribe()).rejects.toThrow(ZkConnectionError)
      await expect(device.subscribe()).rejects.toThrow(GUARD_MESSAGE)
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

    // Regression: connect() used to just null out this.stream, leaking the
    // Subscription. TcpTransport.close()/UdpTransport.close() deliberately
    // detach their failure listener before tearing the socket down (a clean
    // close is not a failure), so nothing ever told the orphaned Subscription
    // its connection was gone — a caller's `for await` would hang forever. A
    // real timeout on this test turns that regression back into a failure
    // instead of a hung suite.
    it('ends an old stream when connect() is called again without closing it first', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      const orphaned = await device.subscribe()
      await device.connect()
      expect(await orphaned[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
    }, 3000)

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
