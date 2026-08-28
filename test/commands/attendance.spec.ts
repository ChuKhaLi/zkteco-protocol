import { afterEach, describe, expect, it } from 'vitest'
import { getAttendanceLogs } from '../../src/commands/attendance.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodeZkTime } from '../../src/codec/time.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { ZkFramingError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const DAY = 86_400

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt32LE(t, 27)
  return b
}

function rec16(numericUserId: number, t: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(numericUserId, 0)
  b.writeUInt32LE(t, 4)
  return b
}

function rec8(uid: number, t: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  b.writeUInt32LE(t, 3)
  return b
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  const openSession = async (port: number): Promise<Session> => {
    const s = new Session(makeTransport(port), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  describe(`getAttendanceLogs over ${transportKind}`, () => {
    it('marks 40-byte identities as coming from the device', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(5, '000123', DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({
        userId: '000123', userIdSource: 'device', uid: 5, recordSize: 40,
      })
      expect(log!.timestamp.local).toBe('2000-01-02T00:00:00')
    })

    it('resolves an 8-byte record through the user list and says so', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '000777', 'Carol')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '000777', userIdSource: 'lookup', uid: 9 })
    })

    it('resolves a 16-byte record by numeric id while preserving leading zeros', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(1, '007', 'Bob')],
        records: { size: 16, rows: [rec16(7, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '007', userIdSource: 'lookup' })
    })

    it('returns null rather than inventing an identity it cannot resolve', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        users: [],
        records: { size: 8, rows: [rec8(99, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null, uid: 99 })
    })

    it('skips the user lookup entirely when resolveUserIds is false', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '000777', 'Carol')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind, { resolveUserIds: false })
      expect(log).toMatchObject({ userId: null, userIdSource: null })
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('never looks up users for the 40-byte dialect', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(5, 'ignored', 'X')],
        records: { size: 40, rows: [rec40(5, '000123', DAY)] },
      })
      session = await openSession(running.port)
      await getAttendanceLogs(session, transportKind)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('returns an empty array without issuing a read on an empty buffer', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 0, recordCapacity: 1000 },
      })
      session = await openSession(running.port)
      expect(await getAttendanceLogs(session, transportKind)).toEqual([])
      expect(running.received.map((p) => p.command)).not.toContain(CMD.ATTLOG_RRQ)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.PREPARE_BUFFER)
    })

    it('filters client-side on `since`, inclusive of the boundary', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 3, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY), rec40(1, 'A', 2 * DAY), rec40(1, 'A', 3 * DAY)] },
      })
      session = await openSession(running.port)
      const logs = await getAttendanceLogs(session, transportKind, { since: decodeZkTime(2 * DAY) })
      expect(logs.map((l) => l.timestamp.local)).toEqual([
        '2000-01-03T00:00:00', '2000-01-04T00:00:00',
      ])
    })

    it('throws instead of parsing when the framing does not add up', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 3, recordCapacity: 1000 },
        // Two records on the wire, three claimed by the counter.
        records: { size: 8, rows: [rec8(1, 0), rec8(2, 0)] },
      })
      session = await openSession(running.port)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toBeInstanceOf(ZkFramingError)
    })

    it('skips a junk prefix on the 40-byte dialect', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(3, 'Z9', DAY)], junkPrefix: true },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: 'Z9', uid: 3 })
    })

    it('attaches raw hex to every record', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log!.raw).toMatch(/^[0-9a-f]{80}$/)
    })
  })
}
