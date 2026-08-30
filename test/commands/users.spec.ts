import { afterEach, describe, expect, it } from 'vitest'
import { getUsers } from '../../src/commands/users.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkAuthError } from '../../src/errors.js'
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
      const users = await getUsers(session, transportKind)
      expect(users.map((u) => [u.uid, u.userId, u.name])).toEqual([
        [1, '000123', 'Alice'],
        [2, '007', 'Bob'],
      ])
    })

    it('returns an empty array on a device with nobody enrolled', async () => {
      running = await startEmulator({ transport: transportKind, users: [] })
      session = await openSession(running.port)
      expect(await getUsers(session, transportKind)).toEqual([])
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
      await expect(getUsers(session, transportKind)).rejects.toThrow(/answered ACK_UNAUTH/)
      // And the fallback must never have been attempted. USERTEMP_RRQ is the
      // legacy request readBulkLegacy would send; its absence is what proves
      // the auth failure propagated rather than being retried down a path that
      // could not have worked either.
      expect(running.received.some((pkt) => pkt.command === CMD.USERTEMP_RRQ)).toBe(false)
    })
  })
}
