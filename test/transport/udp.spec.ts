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
    await transport.connect()
    await transport.send(connectPayload())
    expect(decodePayload(await transport.receive(2000)).sessionId).toBe(0x99)
  })

  it('sends the bare payload with no TCP start marker', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await transport.receive(2000)
    const raw = running.receivedRaw[0]!
    expect(raw.length).toBe(8)
    expect(raw.readUInt16LE(0)).toBe(CMD.CONNECT)
  })

  it('times out rather than hanging when the device stays silent', async () => {
    running = await startEmulator({ transport: 'udp', behavior: 'silent' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('queues a datagram that arrived before receive was called', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await new Promise((r) => setTimeout(r, 100))
    expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
  })

  it('is safe to close twice', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
    transport = null
  })

  it('rejects a second concurrent receive without disturbing the first', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x66 })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    const first = transport.receive(2000)
    await expect(transport.receive(2000)).rejects.toBeInstanceOf(ZkConnectionError)
    await transport.send(connectPayload())
    const reply = decodePayload(await first)
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0x66)
  })
})
