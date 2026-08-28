import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { ZkAuthError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`comm-key authentication over ${transportKind}`, () => {
    it('connects without CMD_AUTH when the device does not ask', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 0 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT])
    })

    it('answers ACK_UNAUTH with a mixed comm key and completes the handshake', async () => {
      running = await startEmulator({
        transport: transportKind, commKey: 1234, sessionId: 0x0777,
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 1234 })
      await session.open()
      expect(session.sessionId).toBe(0x0777)
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT, CMD.AUTH])
    })

    it('mixes the key against the session id the device issued', async () => {
      running = await startEmulator({
        transport: transportKind, commKey: 4321, sessionId: 0x0abc,
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 4321 })
      await session.open()
      const auth = running.received.find((p) => p.command === CMD.AUTH)!
      expect(auth.data).toEqual(mixCommKey(4321, 0x0abc))
    })

    it('throws ZkAuthError on a wrong comm key', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 1234 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 9999 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })

    it('throws ZkAuthError when the device asks and no key was configured', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 1234 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })
  })
}
