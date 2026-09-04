import { afterEach, describe, expect, it } from 'vitest'
import { getAttendanceLogs } from '../../src/commands/attendance.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodeZkTime } from '../../src/codec/time.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { ZkAuthError, ZkFramingError } from '../../src/errors.js'
import { encodeFreeSizes, reply, startEmulator, type Emulator } from '../emulator/index.js'
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
  b.write(userId, 48, 9, 'ascii')
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

    it('attributes a punch to a nine-character id without truncating it', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '123456789', 'Nine')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '123456789', userIdSource: 'lookup' })
    })

    it('forwards the post-transfer user count, not a stale or wrong one, to resolve a 504-byte body', async () => {
      // 7 users at 72 bytes is 504 bytes -- also 18 records at 28 bytes, the
      // one length that is a whole number of records under both widths, so
      // only a correct count decodes the list at all.
      //
      // The emulator has to MOVE for this test to earn its name. Served a
      // static userCount of 7, both getInfo calls return the same number and
      // the fixture cannot tell the post-transfer count from the pre-transfer
      // one -- forwarding either would pass. So CMD_GET_FREE_SIZES answers 0
      // the first time and 7 the second: the pre-transfer count now hits
      // "user count is 0 but the body carries 504 bytes" and fails. recordCount
      // is held at 1 across both replies so the attendance bracket guard,
      // which refuses a record count that moved, does not fire for an
      // unrelated reason and mask what this test is checking.
      const users = Array.from({ length: 7 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
      let freeSizesCalls = 0
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 7, recordCount: 1, recordCapacity: 1000 },
        users,
        records: { size: 8, rows: [rec8(5, DAY)] },
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => {
            freeSizesCalls += 1
            const userCount = freeSizesCalls === 1 ? 0 : 7
            return [
              reply(state, req, CMD.ACK_OK, encodeFreeSizes({ ...state.info, userCount })),
            ]
          },
        },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '5', userIdSource: 'lookup', uid: 5 })
      // Both counts were actually read; without this the handler could have
      // been called once and the distinction would be untested again.
      expect(freeSizesCalls).toBe(2)
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

    it('returns null when two enrolled ids collide numerically', async () => {
      // '1' and '01' both become 1. Last-writer-wins picked one and labelled
      // it 'lookup' (review R13).
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 2, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(1, '1', 'One'), emUser(2, '01', 'Zero-one')],
        records: { size: 16, rows: [rec16(1, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null })
    })

    it('returns null when the matched user has a blank printed id', async () => {
      // The 40-byte path maps '' to null (records/attendance.ts). The lookup
      // path handed '' back with source 'lookup'.
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '', 'Blank')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null, uid: 9 })
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

    it('resolves a blank 40-byte user id through the user list by uid', async () => {
      // A blank 40-byte userId field decodes to null (not ''), so it must
      // flow into the same uid-lookup path as the 8-byte dialect rather than
      // being reported as a device-supplied empty identity.
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(5, '000123', 'Dave')],
        records: { size: 40, rows: [rec40(5, '', DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      // 'lookup' (not 'device', not null) proves the blank field was treated
      // as an unresolved identity and successfully matched via uid — the old
      // behaviour reported '' here directly, under userIdSource: 'device',
      // and never consulted the user list at all.
      expect(log).toMatchObject({ userId: '000123', userIdSource: 'lookup', uid: 5 })
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

    it('throws ZkAuthError rather than framing records against a record count from an ACK_UNAUTH reply', async () => {
      // getAttendanceLogs reads the record count FIRST, and parseAttendanceData
      // divides by it -- so a count decoded out of a reply that acknowledged
      // nothing does not merely mislead a caller, it drives the framing guard
      // that exists to catch misaligned records. The ACK_UNAUTH body here is a
      // real encodeFreeSizes() payload, long enough to satisfy getInfo's length
      // check, so without the guard the read proceeds on a record count taken
      // from a reply that acknowledged nothing, instead of failing.
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY)] },
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => [
            reply(state, req, CMD.ACK_UNAUTH, encodeFreeSizes(state.info)),
          ],
        },
      })
      session = await openSession(running.port)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toThrow(/answered ACK_UNAUTH/)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toBeInstanceOf(ZkAuthError)
    })

    it('refuses the read when the record count moved during it', async () => {
      // One record counted, two on the wire: 16 bytes over a count of 1 is
      // "one 16-byte record", a misaligned parse with no error (review R3).
      // The second count read catches it.
      let counts = 0
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, DAY), rec8(2, DAY)] },
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => {
            counts += 1
            const info = { ...state.info, recordCount: counts === 1 ? 1 : 2 }
            return [reply(state, req, CMD.ACK_OK, encodeFreeSizes(info))]
          },
        },
      })
      session = await openSession(running.port)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toThrow(/buffer changed during the read: 1 record\(s\) before, 2 after/)
    })

    it('parses when the record count is unchanged by the read, reading it twice', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 2, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, DAY), rec8(2, DAY)] },
      })
      session = await openSession(running.port)
      const logs = await getAttendanceLogs(session, transportKind, { resolveUserIds: false })
      expect(logs.map((l) => l.uid)).toEqual([1, 2])
      expect(running.received.filter((p) => p.command === CMD.GET_FREE_SIZES)).toHaveLength(2)
    })
  })
}
