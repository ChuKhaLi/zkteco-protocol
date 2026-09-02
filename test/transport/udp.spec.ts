import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError, ZkTimeoutError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: UdpTransport | null = null
afterEach(async () => {
  await transport?.close(); transport = null
  await running?.close(); running = null
})

const connectPayload = () => encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })

describe('UdpTransport', () => {
  it('round-trips a payload', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x99 })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    expect(decodePayload(await transport.receive(2000)).sessionId).toBe(0x99)
  })

  it('sends the bare payload with no TCP start marker', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await transport.receive(2000)
    const raw = running.receivedRaw[0]!
    expect(raw.length).toBe(8)
    expect(raw.readUInt16LE(0)).toBe(CMD.CONNECT)
  })

  // `sock.connect(port, host, cb)` hands its callback an error on a lookup or
  // connect failure and emits no 'error'. The callback ignored that argument,
  // so connect() resolved on a host that does not exist and the failure only
  // surfaced from the first send(), as a RangeError about the port — not a
  // ZkError, so Session.open() rethrew it raw (spec §4.3 wants a
  // ZkConnectionError). `.invalid` is reserved by RFC 2606 and never resolves,
  // so this is a deterministic lookup failure rather than a hang.
  it('rejects a connect whose lookup fails, naming the host', async () => {
    transport = new UdpTransport({ host: 'nonexistent.invalid', port: 4370 })
    const err = await transport.connect(2_000).then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(ZkConnectionError)
    expect(err!.message).toMatch(/nonexistent\.invalid/)
  })

  it('times out rather than hanging when the device stays silent', async () => {
    running = await startEmulator({ transport: 'udp', behavior: 'silent' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('queues a datagram that arrived before receive was called', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await new Promise((r) => setTimeout(r, 100))
    expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
  })

  it('is safe to close twice', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
    transport = null
  })

  it('rejects a second concurrent receive without disturbing the first', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x66 })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const first = transport.receive(2000)
    await expect(transport.receive(2000)).rejects.toBeInstanceOf(ZkConnectionError)
    await transport.send(connectPayload())
    const reply = decodePayload(await first)
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0x66)
  })

  // Any host that could reach the client's ephemeral port used to be the
  // device: the socket was bound on every interface and the message handler
  // never looked at the sender. A connected socket lets the kernel drop the
  // forgery before this library sees it.
  it('ignores a datagram from a peer that is not the device', async () => {
    running = await startEmulator({ transport: 'udp', behavior: 'silent' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const clientPort = (transport as unknown as { socket: dgram.Socket }).socket.address().port

    const pending = transport.receive(300)
    const forger = dgram.createSocket('udp4')
    const forged = encodePayload({ command: CMD.ACK_OK, sessionId: 0xbad, replyId: 0 })
    await new Promise<void>((r) => forger.send(forged, clientPort, '127.0.0.1', () => r()))
    try {
      // The emulator is silent, so the ONLY thing that could resolve this is
      // the forgery. A timeout is the pass.
      await expect(pending).rejects.toBeInstanceOf(ZkTimeoutError)
    } finally {
      forger.close()
    }
  })
})
