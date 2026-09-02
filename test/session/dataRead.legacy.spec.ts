import { afterEach, describe, expect, it } from 'vitest'
import { readBulkLegacy } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
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
      // ACK_OK, not ACK_UNAUTH. This test exists for readBulkLegacy's
      // "expected ACK_DATA or PREPARE_DATA" branch, and Session.execute() now
      // rejects ACK_UNAUTH one layer earlier -- so an ACK_UNAUTH reply here
      // would leave this test green while the branch it is named for went
      // completely unexercised. ACK_OK is an acknowledgment that carries no
      // data, which is exactly what this branch is for.
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('rejects rather than returning when FREE_DATA never answers, and closes the session', async () => {
      // Regression test for a real desync: freeBuffer() used to catch every
      // error indiscriminately, including ZkTimeoutError. That let a FREE_DATA
      // which never answers still resolve the read with the data already in
      // hand -- masking the fact that the device may answer FREE_DATA late,
      // after this call has moved on. A late reply then sits in the transport
      // queue and gets handed to whatever the caller asks for next, silently
      // shifting every reply after it by one. The read must reject instead.
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
        chunkSize: 4096,
        handlers: { [CMD.FREE_DATA]: () => null },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 150 })
      await session.open()
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkTimeoutError)
      // v0.5: a timeout ends the session (spec §5.2), because FREE_DATA's late
      // reply would otherwise be collected by the next request. The next call
      // is refused by the session, not answered off a stale queue.
      const next = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      session = null
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
