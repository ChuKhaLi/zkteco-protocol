import { afterEach, describe, expect, it } from 'vitest'
import { readBulk, readBulkBuffered } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD, MAX_CHUNK } from '../../src/codec/commands.js'
import { ZkFramingError } from '../../src/errors.js'
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
      // This is the test that actually pins offset 1: the 5-byte reply here
      // is `00 1C 00 00 00` (total 28 at offset 1). An offset-0 reader gets
      // 0x1C00 = 7168 instead, and would go on to request and receive that
      // many (zero-padded) bytes — passing the readUInt32LE(0) assertion
      // below on the real header it copied through, but only this stream
      // length assertion catches the wrong total.
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1), rec8(2), rec8(3)] } })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream).not.toBeNull()
      expect(stream!.readUInt32LE(0)).toBe(24)
      expect(stream!.length).toBe(28)
    })

    it('refuses a four-byte PREPARE_BUFFER reply', async () => {
      // 'size-at-0' is the four-byte layout this library believed before
      // v0.5. The reference's reply is five bytes; this only proves the
      // length guard rejects a too-short one, not that offset 1 is what gets
      // read on a five-byte reply — the "reads a body" test above is the one
      // that pins that.
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, prepareBufferReply: 'size-at-0' })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).rejects.toThrow(/did not report a size/)
    })

    it('accepts an inline CMD_DATA answer to PREPARE_BUFFER as the whole body', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1), rec8(2)] }, prepareBufferInline: true })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream!.readUInt32LE(0)).toBe(16)
      expect(stream!.length).toBe(20) // 4-byte header + two 8-byte records
      expect(running.received.map((p) => p.command)).not.toContain(CMD.READ_BUFFER)
    })

    it('requests successive offsets when the body exceeds one chunk', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows }, chunkSize: 16 })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)
      expect(stream!.length).toBe(804)
      const reads = running.received.filter((p) => p.command === CMD.READ_BUFFER)
      expect(reads.length).toBe(13) // ceil(804 / 64)
      expect(reads[1]!.data.readUInt32LE(0)).toBe(64)
    })

    it('refuses a chunk that ends before the requested size', async () => {
      // 32 bytes served for 64 asked. The reference would wait for its timer;
      // this library says so at once (spec v0.5 §6.1 point 3).
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows }, bufferChunkOverride: { atCall: 1, bytes: 32 } })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)).rejects.toThrow(/ended after 32 of 64/)
    })

    it('refuses a chunk that delivers more than the requested size', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, bufferChunkOverride: { atCall: 1, bytes: 40 } })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).rejects.toThrow(/delivered 40 bytes, expected 12/)
    })

    it('sends the reference request shape: fct 0 for attendance, 5 for users', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, users: [] })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      const prepare = running.received.find((p) => p.command === CMD.PREPARE_BUFFER)!
      expect(prepare.data.length).toBe(11)
      expect(prepare.data.readUInt8(0)).toBe(1)
      expect(prepare.data.readUInt16LE(1)).toBe(CMD.ATTLOG_RRQ)
      expect(running.state.lastPrepareFct).toBe(0)
      await readBulkBuffered(session, CMD.USERTEMP_RRQ, MAX_CHUNK[transportKind])
      expect(running.state.lastPrepareFct).toBe(5)
      // And the buffered path was what served both: no legacy command went out.
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('returns null when the device refuses PREPARE_BUFFER', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, supportsBuffer: false })
      session = await openSession(running.port)
      expect(await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).toBeNull()
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] } })
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

    it.skipIf(transportKind !== 'tcp')('does not fall back when the buffered read fails for any reason but a refusal', async () => {
      // A framing failure during the buffered read used to be caught as a
      // ZkProtocolError and retried down the legacy path on a broken stream
      // (review R2). Only an ACK_ERROR to PREPARE_BUFFER is a refusal.
      running = await startEmulator({
        transport: 'tcp',
        records: { size: 8, rows: [rec8(1)] },
        handlers: { [CMD.PREPARE_BUFFER]: () => null },
      })
      session = await openSession(running.port)
      const pending = readBulk(session, CMD.ATTLOG_RRQ, 'tcp')
      await new Promise((r) => setTimeout(r, 50))
      for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
      await expect(pending).rejects.toBeInstanceOf(ZkFramingError)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.ATTLOG_RRQ)
      session = null
    })
  })
}
