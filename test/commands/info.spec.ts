import { afterEach, describe, expect, it } from 'vitest'
import { FREE_SIZES_OFFSET, getInfo } from '../../src/commands/info.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkProtocolError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

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

  describe(`getInfo over ${transportKind}`, () => {
    it('reads the three counters the library exposes', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 42, recordCount: 1337, recordCapacity: 100_000 },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(await getInfo(session)).toEqual({
        userCount: 42, recordCount: 1337, recordCapacity: 100_000,
      })
    })

    it('reports a freshly installed device as holding no records', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 0, recordCapacity: 100_000 },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect((await getInfo(session)).recordCount).toBe(0)
    })

    it('throws when the reply is too short to hold the fields it claims', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => [
            reply(state, req, CMD.ACK_OK, Buffer.alloc(8)),
          ],
        },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(getInfo(session)).rejects.toBeInstanceOf(ZkProtocolError)
    })
  })
}

describe('FREE_SIZES_OFFSET', () => {
  it('is exported as a single definition both the library and tests use', () => {
    expect(FREE_SIZES_OFFSET.userCount).toBeTypeOf('number')
    expect(FREE_SIZES_OFFSET.recordCount).toBeTypeOf('number')
    expect(FREE_SIZES_OFFSET.recordCapacity).toBeTypeOf('number')
  })
})
