import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkAuthError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
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

  describe(`Session over ${transportKind}`, () => {
    it('acquires the session id the device issues', async () => {
      running = await startEmulator({ transport: transportKind, sessionId: 0x4242 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(session.sessionId).toBe(0x4242)
    })

    it('sends the acquired session id on subsequent commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        sessionId: 0x0abc,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      expect(running.received[1]!.sessionId).toBe(0x0abc)
    })

    it('transmits a reply id one ahead of the one its checksum covers', async () => {
      // The reply-id quirk, observed end to end: the wire packet carries N+1
      // while its checksum was computed over N. See spec §5.1.
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)

      const sent = running.received[1]!
      const asTransmitted = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId,
      })
      const asChecksummed = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId - 1,
      })
      expect(sent.checksum).not.toBe(checksum16(asTransmitted))
      expect(sent.checksum).toBe(checksum16(asChecksummed))
    })

    it('increments the reply id across commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      await session.execute(CMD.GET_FREE_SIZES)
      const ids = running.received.map((p) => p.replyId)
      expect(ids[2]).toBe(ids[1]! + 1)
    })

    it('throws ZkProtocolError when the device replies ACK_ERROR', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('returns ACK_DATA replies verbatim rather than treating them as failures', async () => {
      const payload = Buffer.from([1, 2, 3])
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_DATA, payload)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const res = await session.execute(CMD.ATTLOG_RRQ)
      expect(res.command).toBe(CMD.ACK_DATA)
      expect(res.data).toEqual(payload)
    })

    it('throws ZkAuthError when the device demands a comm key', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.CONNECT]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })

    it('times out on a silent device instead of hanging', async () => {
      running = await startEmulator({ transport: transportKind, behavior: 'silent' })
      session = new Session(makeTransport(running.port), { timeoutMs: 200 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkTimeoutError)
      session = null
    })

    it('is safe to close twice', async () => {
      running = await startEmulator({ transport: transportKind })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.close()
      await expect(session.close()).resolves.toBeUndefined()
      session = null
    })
  })
}
