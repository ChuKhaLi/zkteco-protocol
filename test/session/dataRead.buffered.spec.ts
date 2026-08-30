import { afterEach, describe, expect, it } from 'vitest'
import { readBulk, readBulkBuffered } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD, MAX_CHUNK } from '../../src/codec/commands.js'
import { ZkProtocolError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

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

    it('advances the next offset by what actually arrived, not by what was requested', async () => {
      // The first READ_BUFFER call is answered with 32 bytes instead of the
      // 64 requested — a valid short read that does not end the transfer.
      // The next request must ask for offset 32, the true end of what
      // arrived; a build that tracks progress as `offset += want` would ask
      // for offset 64 instead and silently skip 32 bytes of the body.
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows },
        bufferChunkOverride: { atCall: 1, bytes: 32 },
      })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)
      expect(stream.length).toBe(804)
      const reads = running.received.filter((p) => p.command === CMD.READ_BUFFER)
      expect(reads[1]!.data.readUInt32LE(0)).toBe(32)
    })

    it('throws when a chunk delivers more bytes than the declared total', async () => {
      // A single-chunk transfer whose only READ_BUFFER reply overshoots past
      // the size PREPARE_BUFFER declared. This must fail loudly rather than
      // hand back a silently oversized buffer.
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
        bufferChunkOverride: { atCall: 1, bytes: 40 },
      })
      session = await openSession(running.port)
      await expect(
        readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind]),
      ).rejects.toThrow(ZkProtocolError)
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

    it('still returns the data when the FREE_DATA cleanup is answered ACK_UNAUTH', async () => {
      // freeBuffer() is cleanup, not part of the result: the transfer has
      // already completed and the caller already holds the bytes. It swallows
      // a device-answered failure because an answer proves the reply was
      // consumed and the session is still in sync -- which is as true of
      // ACK_UNAUTH as it is of ACK_ERROR. Session.execute() classes ACK_UNAUTH
      // as ZkAuthError, a sibling of ZkProtocolError rather than a subtype, so
      // swallowing it takes its own branch; without one, a device that
      // refuses only the cleanup throws away a read that fully succeeded.
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2)] },
        handlers: {
          [CMD.FREE_DATA]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)],
        },
      })
      session = await openSession(running.port)
      const stream = await readBulk(session, CMD.ATTLOG_RRQ, transportKind)
      expect(stream.readUInt32LE(0)).toBe(16)
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })
  })
}
