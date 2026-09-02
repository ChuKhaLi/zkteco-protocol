import { afterEach, describe, expect, it } from 'vitest'
import { ZkDevice } from '../src/ZkDevice.js'
import { CMD } from '../src/codec/commands.js'
import { ZkAuthError, ZkConnectionError, ZkFramingError, ZkTimeoutError } from '../src/errors.js'
import { USER_RECORD_SIZE } from '../src/codec/records/user.js'
import { startEmulator, type Emulator } from './emulator/index.js'
import type { ZkUser } from '../src/types.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
afterEach(async () => {
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

const DAY = 86_400

function emUser(uid: number, userId: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name: 'N', privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0); b.write(userId, 2, 24, 'ascii'); b.writeUInt32LE(t, 27)
  return b
}
function rec16(numericUserId: number, t: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(numericUserId, 0); b.writeUInt32LE(t, 4)
  return b
}
function rec8(uid: number, t: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0); b.writeUInt32LE(t, 3)
  return b
}

// MAX_CHUNK.tcp is 0xffc0 (65472) bytes per src/codec/commands.ts — a
// buffered read only loops more than once when the declared body exceeds
// that on TCP too (UDP's 16KiB chunk is crossed much sooner). 2000 40-byte
// rows (80,004 bytes with the size header) clears both thresholds, so the
// chunk loop genuinely iterates — twice on TCP, five times on UDP — on
// every transport this suite runs against.
const CHUNK_ROW_COUNT = 2000

for (const transport of ['tcp', 'udp'] as const) {
  describe(`scenarios over ${transport}`, () => {
    const connect = async (emulator: Emulator, commKey?: number): Promise<ZkDevice> => {
      const d = new ZkDevice({
        host: '127.0.0.1', port: emulator.port, transport, commKey, timeoutMs: 2000,
      })
      await d.connect()
      return d
    }

    // 1. Handshake, with and without auth.
    it('handshakes on a device that needs no comm key', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      expect(device).toBeInstanceOf(ZkDevice)
    })

    it('handshakes with the right comm key and refuses the wrong one', async () => {
      running = await startEmulator({ transport, commKey: 1234 })
      device = await connect(running, 1234)
      await device.disconnect()
      device = null

      const wrong = new ZkDevice({
        host: '127.0.0.1', port: running.port, transport, commKey: 4321, timeoutMs: 2000,
      })
      await expect(wrong.connect()).rejects.toBeInstanceOf(ZkAuthError)
    })

    it('honours a disconnect() issued while connect() is still in flight', async () => {
      running = await startEmulator({ transport, replyDelayMs: 100 })
      const d = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      const connecting = d.connect()
      await d.disconnect()
      await connecting
      // The session that finished opening was closed, not installed.
      await expect(d.getInfo()).rejects.toThrow(/not connected/)
      expect(running.received.map((p) => p.command)).toContain(CMD.EXIT)
    })

    // 2. All three record dialects.
    const dialectCases: Array<
      [name: string, records: { size: 8 | 16 | 40; rows: Buffer[] }, users: ZkUser[], expectedId: string, expectedSource: 'device' | 'lookup']
    > = [
      ['40-byte', { size: 40, rows: [rec40(1, '000123', DAY)] }, [], '000123', 'device'],
      ['16-byte', { size: 16, rows: [rec16(7, DAY)] }, [emUser(1, '007')], '007', 'lookup'],
      ['8-byte', { size: 8, rows: [rec8(9, DAY)] }, [emUser(9, '000777')], '000777', 'lookup'],
    ]
    it.each(dialectCases)(
      'reads the %s dialect',
      async (_name, records, users, expectedId, expectedSource) => {
        running = await startEmulator({
          transport, users,
          info: { userCount: users.length, recordCount: 1, recordCapacity: 1000 },
          records,
        })
        device = await connect(running)
        const [log] = await device.getAttendanceLogs()
        expect(log).toMatchObject({ userId: expectedId, userIdSource: expectedSource })
      },
    )

    // 3. Multi-chunk read.
    it('reads a body far larger than one chunk', async () => {
      const rows = Array.from({ length: CHUNK_ROW_COUNT }, (_, i) => rec40(i + 1, `U${i + 1}`, DAY))
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: CHUNK_ROW_COUNT, recordCapacity: 100_000 },
        records: { size: 40, rows },
      })
      device = await connect(running)
      const logs = await device.getAttendanceLogs()
      expect(logs).toHaveLength(CHUNK_ROW_COUNT)
      expect(logs[CHUNK_ROW_COUNT - 1]!.userId).toBe(`U${CHUNK_ROW_COUNT}`)
    })

    // 4. Empty buffer.
    it('returns an empty array on a freshly installed device', async () => {
      running = await startEmulator({
        transport, info: { userCount: 0, recordCount: 0, recordCapacity: 100_000 },
      })
      device = await connect(running)
      expect(await device.getAttendanceLogs()).toEqual([])
    })

    // 5. Framing guard.
    it('throws rather than parsing when the record count and body disagree', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 7, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, 0), rec8(2, 0)] },
      })
      device = await connect(running)
      await expect(device.getAttendanceLogs()).rejects.toBeInstanceOf(ZkFramingError)
    })

    // 7. Silent device.
    it('times out on a silent device instead of hanging', async () => {
      running = await startEmulator({ transport, behavior: 'silent' })
      const d = new ZkDevice({
        host: '127.0.0.1', port: running.port, transport, timeoutMs: 200,
      })
      await expect(d.connect()).rejects.toBeInstanceOf(ZkTimeoutError)
    })

    // 8. Junk prefix.
    it('skips a junk prefix on the 40-byte dialect', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(3, 'Z9', DAY)], junkPrefix: true },
      })
      device = await connect(running)
      expect((await device.getAttendanceLogs())[0]).toMatchObject({ userId: 'Z9' })
    })

    // 10. Time boundaries, end to end.
    it('decodes boundary timestamps without normalising them', async () => {
      const rows = [
        rec40(1, 'A', 0),                       // 2000-01-01, the power-loss reset
        rec40(2, 'B', 30 * DAY),                // day 31 of the pseudo-calendar
        rec40(3, 'C', 31 * DAY + 30 * DAY),     // February 31st: does not exist
        rec40(4, 'D', 12 * 31 * DAY),           // year rollover
      ]
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 4, recordCapacity: 1000 },
        records: { size: 40, rows },
      })
      device = await connect(running)
      const logs = await device.getAttendanceLogs()
      expect(logs.map((l) => l.timestamp.local)).toEqual([
        '2000-01-01T00:00:00',
        '2000-01-31T00:00:00',
        '2000-02-31T00:00:00',
        '2001-01-01T00:00:00',
      ])
    })

    it('never returns a Date', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY)] },
      })
      device = await connect(running)
      const [log] = await device.getAttendanceLogs()
      expect(log!.timestamp).not.toBeInstanceOf(Date)
      expect(JSON.parse(JSON.stringify(log)).timestamp.local).toBe('2000-01-02T00:00:00')
    })
  })
}

// 6. Device disconnects mid-transfer. TCP only — a UDP peer has no connection
//    to drop, so the scenario does not exist there.
describe('scenarios over tcp only', () => {
  it('surfaces an error when the device disconnects mid-transfer', async () => {
    // Needs >1 TCP chunk (see CHUNK_ROW_COUNT above) so dropAfterChunk: 1
    // actually has a second chunk request to drop — with a body that fits in
    // one chunk the transfer would complete normally and this would never
    // throw.
    const rows = Array.from({ length: CHUNK_ROW_COUNT }, (_, i) => rec40(i + 1, `U${i + 1}`, DAY))
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 0, recordCount: CHUNK_ROW_COUNT, recordCapacity: 100_000 },
      records: { size: 40, rows },
      behavior: 'dropMidTransfer',
      dropAfterChunk: 1,
    })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, timeoutMs: 2000 })
    await device.connect()
    // Asserted by class, not a generic toThrow(): a bare toThrow() passes on
    // ANY rejection, including a ZkTimeoutError raised for an unrelated
    // reason (e.g. a misconfigured transport that never talks to this
    // emulator at all) — this suite has already been fooled by exactly that
    // shape once. The socket is destroyed mid-read here, which the transport
    // surfaces specifically as ZkConnectionError; requiring that class is
    // what actually proves the drop was detected rather than just some
    // failure.
    await expect(device.getAttendanceLogs()).rejects.toBeInstanceOf(ZkConnectionError)
    device = null
  })
})
