import { afterEach, describe, expect, it } from 'vitest'
import { readBulkLegacy } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkConnectionError, ZkProtocolError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** One 8-byte attendance record with the given uid. */
function rec8(uid: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
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

  describe(`readBulkLegacy over ${transportKind}`, () => {
    it('returns an inline ACK_DATA body in one piece', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2)] },
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      const stream = await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(stream.readUInt32LE(0)).toBe(16)
      expect(stream.length).toBe(20)
    })

    it('reassembles a body delivered as several CMD_DATA chunks', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows },
        chunkSize: 32,
      })
      session = await openSession(running.port)
      const stream = await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(stream.readUInt32LE(0)).toBe(400)
      expect(stream.length).toBe(404)
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })

    // Hardcodes a TCP emulator below (a UDP peer has no connection to drop),
    // so this case only makes sense once per transportKind loop, not with a
    // UDP client dialing a TCP server.
    it.skipIf(transportKind !== 'tcp')('rejects when the device disconnects mid-transfer', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: 'tcp',
        records: { size: 8, rows },
        chunkSize: 32,
        behavior: 'dropMidTransfer',
        dropAfterChunk: 2,
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkConnectionError)
      session = null
    })

    it('throws when the device answers with something other than data', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('throws when PREPARE_DATA does not carry a size', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.PREPARE_DATA, Buffer.alloc(2))],
        },
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkProtocolError)
    })
  })
}

// The drop-mid-transfer case is TCP-only: a UDP peer has no connection to drop.
