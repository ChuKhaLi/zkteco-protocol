import { afterEach, describe, expect, it } from 'vitest'
import { readBulk, readBulkBuffered } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD, MAX_CHUNK } from '../../src/codec/commands.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

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

  describe(`buffered bulk read over ${transportKind}`, () => {
    it('reads a body through PREPARE_BUFFER and READ_BUFFER', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2), rec8(3)] },
      })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream.readUInt32LE(0)).toBe(24)
      expect(stream.length).toBe(28)
    })

    it('requests successive offsets when the body exceeds one chunk', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows } })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)
      expect(stream.length).toBe(804)
      const reads = running.received.filter((p) => p.command === CMD.READ_BUFFER)
      expect(reads.length).toBeGreaterThan(1)
      expect(reads[1]!.data.readUInt32LE(0)).toBe(64)
    })

    it('sends the documented PREPARE_BUFFER request shape', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      const prepare = running.received.find((p) => p.command === CMD.PREPARE_BUFFER)!
      expect(prepare.data.length).toBe(11)
      expect(prepare.data.readUInt8(0)).toBe(1)
      expect(prepare.data.readUInt16LE(1)).toBe(CMD.ATTLOG_RRQ)
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })
  })

  describe(`readBulk dispatch over ${transportKind}`, () => {
    it('uses the buffered path when the device supports it', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulk(session, CMD.ATTLOG_RRQ, transportKind)
      expect(running.received.map((p) => p.command)).toContain(CMD.PREPARE_BUFFER)
    })

    it('falls back to the legacy path when the device refuses PREPARE_BUFFER', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2)] },
        supportsBuffer: false,
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      const stream = await readBulk(session, CMD.ATTLOG_RRQ, transportKind)
      expect(stream.readUInt32LE(0)).toBe(16)
      expect(running.received.map((p) => p.command)).toContain(CMD.ATTLOG_RRQ)
    })
  })
}
