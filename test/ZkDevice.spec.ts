import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../src/codec/commands.js'
import { START_MARKER } from '../src/codec/framing.js'
import { ZkDevice } from '../src/ZkDevice.js'
import { ZkConnectionError } from '../src/errors.js'
import { reply, startEmulator, type Emulator } from './emulator/index.js'
import type { ZkUser } from '../src/types.js'

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

/** A 72-byte emulator user; the emulator serves `raw` verbatim. */
function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(72)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 9, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
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

    describe('read commands while subscribed', () => {
      // The guard must be identified by ITS OWN message. Asserting only
      // ZkConnectionError would pass with the guard deleted, because the
      // transport throws the same class one layer down once it is listening.
      const SUBSCRIBED = /subscribed to realtime events/

      it('refuses getIdentity, getParameters and getTime with the guard\'s own message', async () => {
        running = await startEmulator({ transport, params: { '~OS': 'Linux' } })
        device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
        await device.connect()
        const stream = await device.subscribe()
        try {
          await expect(device.getIdentity()).rejects.toThrow(SUBSCRIBED)
          await expect(device.getParameters(['~OS'])).rejects.toThrow(SUBSCRIBED)
          await expect(device.getTime()).rejects.toThrow(SUBSCRIBED)
        } finally {
          await stream.close()
        }
      })

      it('answers all three once the stream is closed and the device reconnects', async () => {
        running = await startEmulator({
          transport,
          params: { '~SerialNumber': 'OAJ7194600263' },
          firmware: 'Ver 6.60',
          deviceTimeRaw: 0x2b1f_c4d0,
        })
        device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
        await device.connect()
        const stream = await device.subscribe()
        await stream.close()
        await device.connect()
        expect((await device.getIdentity()).serialNumber).toBe('OAJ7194600263')
        expect(await device.getParameters(['~SerialNumber'])).toHaveProperty('~SerialNumber')
        expect((await device.getTime()).year).toBeTypeOf('number')
      })
    })
  })
}

it('still reads users when the device will not report a user count', async () => {
  // ZkDevice.getUsers() asks for a count to derive the record width. A device
  // whose free-sizes reply is refused must not lose a user read that works:
  // the no-count path reads 72-byte records for every decidable length, and
  // eight users is 576 bytes, which is not a multiple of 504.
  //
  // ACK_UNAUTH rather than a timeout on purpose: this is the half of the
  // degradation where the session SURVIVES the refusal, so the read that
  // follows is unencumbered. The timeout half is the test below.
  const eight = Array.from({ length: 8 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
  running = await startEmulator({
    transport: 'tcp',
    users: eight,
    handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
  })
  device = new ZkDevice({ host: '127.0.0.1', port: running.port })
  await device.connect()
  expect((await device.getUsers()).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  await device.disconnect()
  device = null
})

it('still reads users when the count read times out, and leaves the session dead', async () => {
  // The other half, and the one the ordering exists for. A timeout is not a
  // refusal the session walks away from: Session.exchange abandons the
  // session on ZkTimeoutError (spec v0.5 section 5.2), so the count read is
  // fatal to it. Reading the list FIRST is what keeps the eight users --
  // fetching the count first threw ZkConnectionError from the bulk read
  // instead, on a session the swallowed getInfo had already killed.
  //
  // Both consequences are asserted, because the second is the price of the
  // first: the users arrive, and the session behind them is gone.
  const eight = Array.from({ length: 8 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
  running = await startEmulator({
    transport: 'tcp',
    users: eight,
    // Never answers. `null` from a handler sends no reply at all, which is
    // what a device that ignores CMD_GET_FREE_SIZES looks like.
    handlers: { [CMD.GET_FREE_SIZES]: () => null },
  })
  device = new ZkDevice({ host: '127.0.0.1', port: running.port, timeoutMs: 200 })
  await device.connect()
  expect((await device.getUsers()).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  // The documented consequence, pinned rather than described: getUsers
  // resolved, and the next call on the same ZkDevice does not.
  await expect(device.getInfo()).rejects.toThrow(ZkConnectionError)
  await expect(device.getInfo()).rejects.toThrow(/this session is not open/)
  await device.disconnect()
  device = null
})

it('reads all seven users when the device reports a count that disambiguates the width', async () => {
  // Success-path sibling of the test above: 7 users at 72 bytes is 504
  // bytes, also 18 records at 28 bytes. The degradation test above proves
  // the null fallback still works when the count cannot be read; this one
  // proves the count getInfo() actually returns is the one that gets used,
  // by picking the one body length where a wrong or missing count would
  // refuse to decode it at all.
  const seven = Array.from({ length: 7 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
  running = await startEmulator({
    transport: 'tcp',
    info: { userCount: 7, recordCount: 0, recordCapacity: 100_000 },
    users: seven,
  })
  device = new ZkDevice({ host: '127.0.0.1', port: running.port })
  await device.connect()
  expect((await device.getUsers()).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7])
  await device.disconnect()
  device = null
})

describe('ZkDevice defaults', () => {
  it('defaults to the TCP transport', async () => {
    running = await startEmulator({ transport: 'tcp' })
    // Explicit port so the test can reach the emulator; transport is left out.
    device = new ZkDevice({ host: '127.0.0.1', port: running.port })
    await device.connect()
    // `running.transport` is 'tcp' by construction (startEmulator was called
    // with `transport: 'tcp'` above) regardless of what ZkDevice actually
    // did, so it proves nothing about ZkDevice's own default. Assert on the
    // bytes ZkDevice put on the wire instead: TCP framing opens with
    // START_MARKER; a UDP payload would not.
    expect(running.receivedRaw[0]!.subarray(0, 4)).toEqual(START_MARKER)
    await device.disconnect()
    device = null
  })
})
