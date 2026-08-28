import { afterEach, describe, expect, it } from 'vitest'
import { getUsers } from '../../src/commands/users.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
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
  })
}
