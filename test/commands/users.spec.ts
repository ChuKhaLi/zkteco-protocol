import { afterEach, describe, expect, it } from 'vitest'
import { getUsers } from '../../src/commands/users.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkAuthError, ZkFramingError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** Builds an emulator user whose `raw` is the 72-byte record it serves. */
function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
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

  describe(`getUsers over ${transportKind}`, () => {
    it('decodes the enrolled users', async () => {
      running = await startEmulator({
        transport: transportKind,
        users: [emUser(1, '000123', 'Alice'), emUser(2, '007', 'Bob')],
      })
      session = await openSession(running.port)
      const users = await getUsers(session, transportKind, null)
      expect(users.map((u) => [u.uid, u.userId, u.name])).toEqual([
        [1, '000123', 'Alice'],
        [2, '007', 'Bob'],
      ])
    })

    it('returns an empty array on a device with nobody enrolled', async () => {
      running = await startEmulator({ transport: transportKind, users: [] })
      session = await openSession(running.port)
      expect(await getUsers(session, transportKind, null)).toEqual([])
    })

    it('throws ZkAuthError on an unauthorized PREPARE_BUFFER instead of falling back to legacy', async () => {
      // readBulk() falls back from the buffered commands to the legacy
      // exchange on exactly `err instanceof ZkProtocolError`. Before the guard
      // in Session.execute(), an ACK_UNAUTH reply to PREPARE_BUFFER failed the
      // 4-byte size check AS a ZkProtocolError -- so an authentication failure
      // was read as "this firmware does not implement 1503", and the legacy
      // path below (still served by the default handler) answered it
      // SUCCESSFULLY. The call resolved with a full user list and the caller
      // never learned the device had refused it.
      running = await startEmulator({
        transport: transportKind,
        users: [emUser(1, '000123', 'Alice')],
        handlers: {
          [CMD.PREPARE_BUFFER]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)],
        },
      })
      session = await openSession(running.port)
      // The guard's own message: Session.open() also throws ZkAuthError, so a
      // class-only assertion could go green for a failed handshake instead.
      await expect(getUsers(session, transportKind, null)).rejects.toThrow(/answered ACK_UNAUTH/)
      // And the fallback must never have been attempted. USERTEMP_RRQ is the
      // legacy request readBulkLegacy would send; its absence is what proves
      // the auth failure propagated rather than being retried down a path that
      // could not have worked either.
      expect(running.received.some((pkt) => pkt.command === CMD.USERTEMP_RRQ)).toBe(false)
    })
  })

  describe(`user record width (${transportKind})`, () => {
    /** Eighteen users: 18 x 28 = 504 = 7 x 72, the ambiguous length. */
    const eighteen = Array.from({ length: 18 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
    /** Seven users at 72 bytes: also 504. A legitimate device that must keep working. */
    const seven = Array.from({ length: 7 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))

    it('refuses a 28-byte device rather than returning seven fabricated users', async () => {
      // Before v0.6 this RESOLVED to seven ZkUser objects whose uid, name and
      // printed id were sliced out of the middle of other people's records.
      running = await startEmulator({ transport: transportKind, users: eighteen, userRecordSize: 28 })
      session = await openSession(running.port)
      await expect(getUsers(session, transportKind, null)).rejects.toThrow(ZkFramingError)
    })

    it('names the 28-byte dialect when the count settles it', async () => {
      running = await startEmulator({ transport: transportKind, users: eighteen, userRecordSize: 28 })
      session = await openSession(running.port)
      // Not /28-byte/: the "neither width" refusal names the dialect as well,
      // so that pattern cannot tell the two refusals apart. This is the
      // 28-branch's own sentence.
      await expect(getUsers(session, transportKind, 18)).rejects.toThrow(
        /implies 28-byte user records\. This library decodes only 72-byte records and will not guess/,
      )
    })

    it('reads seven 72-byte users when the count settles it', async () => {
      // The other direction: without this, refusing everything would pass.
      running = await startEmulator({ transport: transportKind, users: seven, userRecordSize: 72 })
      session = await openSession(running.port)
      const got = await getUsers(session, transportKind, 7)
      expect(got.map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('refuses seven 72-byte users with no count, because the length is undecidable', async () => {
      running = await startEmulator({ transport: transportKind, users: seven, userRecordSize: 72 })
      session = await openSession(running.port)
      await expect(getUsers(session, transportKind, null)).rejects.toThrow(/undecidable/)
    })

    it('reads an unambiguous list with no count, exactly as before', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
      running = await startEmulator({ transport: transportKind, users: eight, userRecordSize: 72 })
      session = await openSession(running.port)
      expect((await getUsers(session, transportKind, null)).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })
  })
}
