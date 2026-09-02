import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TcpTransport } from '../../src/transport/tcp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { frameTcp, START_MARKER } from '../../src/codec/framing.js'
import { ZkConnectionError, ZkFramingError, ZkTimeoutError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: TcpTransport | null = null
afterEach(async () => {
  await transport?.close(); transport = null
  await running?.close(); running = null
})

const connectPayload = () => encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })

describe('TcpTransport', () => {
  it('sends a framed payload and receives a bare one back', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x77 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    const reply = decodePayload(await transport.receive(2000))
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0x77)
  })

  it('reassembles a reply delivered in several TCP chunks', async () => {
    // A server that deliberately dribbles one framed packet out byte by byte.
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 5, replyId: 0 })
    const framed = frameTcp(payload)
    // Tracked so the finally block can force the connection closed: plain
    // server.close() waits for open sockets to end on their own, and nothing
    // here closes this one until the transport does, later, in afterEach.
    // (An object field, not a bare `let`, because TS narrows a `let` that's
    // only ever reassigned inside a closure to its initializer's type.)
    const conn: { sock: net.Socket | null } = { sock: null }
    const server = net.createServer((sock) => {
      conn.sock = sock
      sock.on('data', () => {
        for (const byte of framed) sock.write(Buffer.from([byte]))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect(2_000)
      await transport.send(connectPayload())
      expect(decodePayload(await transport.receive(2000)).sessionId).toBe(5)
    } finally {
      conn.sock?.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('separates two replies that arrived coalesced in one chunk', async () => {
    const a = frameTcp(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 0 }))
    const b = frameTcp(encodePayload({ command: CMD.ACK_DATA, sessionId: 2, replyId: 1 }))
    // Tracked for the same reason as above: force-close before server.close().
    const conn: { sock: net.Socket | null } = { sock: null }
    const server = net.createServer((sock) => {
      conn.sock = sock
      sock.on('data', () => sock.write(Buffer.concat([a, b])))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect(2_000)
      await transport.send(connectPayload())
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_DATA)
    } finally {
      conn.sock?.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('times out rather than hanging when the device stays silent', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('reports a refused connection as ZkConnectionError', async () => {
    // Port 1 on loopback is not listening.
    transport = new TcpTransport({ host: '127.0.0.1', port: 1 })
    await expect(transport.connect(2_000)).rejects.toBeInstanceOf(ZkConnectionError)
    transport = null
  })

  it('rejects a pending receive when the device disconnects mid-exchange', async () => {
    const server = net.createServer((sock) => { sock.on('data', () => sock.destroy()) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect(2_000)
      await transport.send(connectPayload())
      await expect(transport.receive(2000)).rejects.toBeInstanceOf(ZkConnectionError)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('is safe to close twice', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
    transport = null
  })

  it('rejects a second concurrent receive without disturbing the first', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x55 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const first = transport.receive(2000)
    await expect(transport.receive(2000)).rejects.toBeInstanceOf(ZkConnectionError)
    await transport.send(connectPayload())
    const reply = decodePayload(await first)
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0x55)
  })

  // A rejected declared length used to leave every byte of the offending
  // chunk in the accumulator forever: the permanent-hang defect was fixed in
  // v0.1 but the growth was not. `buffered` is private, and this asserts on
  // it deliberately — the finding is specifically about that field, and a
  // behavioural proxy would pass while the leak remained.
  it('releases the accumulator when a declared length is rejected', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const pending = transport.receive(2000)

    const bogus = Buffer.alloc(8 + 64)
    START_MARKER.copy(bogus, 0)
    bogus.writeUInt32LE(0xffffff, 4) // far past MAX_DECLARED_SIZE
    for (const socket of running.sockets) socket.write(bogus)

    await expect(pending).rejects.toThrow(ZkFramingError)
    expect((transport as unknown as { buffered: Buffer }).buffered.length).toBe(0)
  })

  // After a framing failure the stream is misaligned. A good packet that was
  // queued before the junk is individually valid but belongs to an exchange
  // the session is about to tear down; serving it first is what let seventeen
  // further probe steps run on a broken stream (review R2).
  it('ends the transport on a framing failure: queue dropped, socket gone, send refused', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x11 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await new Promise((r) => setTimeout(r, 100)) // the ACK_OK lands in the queue, unclaimed

    for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
    await new Promise((r) => setTimeout(r, 100))

    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkFramingError)
    await expect(transport.send(connectPayload())).rejects.toBeInstanceOf(ZkFramingError)
    expect((transport as unknown as { socket: net.Socket | null }).socket).toBeNull()
  })

  // A socket 'error' is followed by a 'close'. The first is the informative
  // one; the second is generic. Last-wins overwrote the reason with
  // "connection closed by peer" on every socket error.
  it('keeps the first failure it saw, not the last', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const sock = (transport as unknown as { socket: net.Socket }).socket
    sock.emit('error', new Error('simulated ECONNRESET'))
    sock.emit('close')
    await expect(transport.receive(200)).rejects.toThrow(/simulated ECONNRESET/)
  })

  // 192.0.2.1 is TEST-NET-1 (RFC 5737): not routable, so the SYN goes out and
  // nothing answers. Without a deadline this hangs ~21 s on Windows and ~127 s
  // on Linux. On a host with no default route the connect fails fast with
  // ENETUNREACH instead — still a ZkConnectionError, so the assertion below
  // holds either way, but only the hanging case exercises the timer, which is
  // why the elapsed time is asserted too.
  it('rejects a connect that does not complete within the deadline', async () => {
    transport = new TcpTransport({ host: '192.0.2.1', port: 4370 })
    const started = Date.now()
    await expect(transport.connect(200)).rejects.toBeInstanceOf(ZkConnectionError)
    expect(Date.now() - started).toBeLessThan(1_500)
    transport = null
  }, 5_000)

  it('names the deadline in the message when the deadline is what ended it', async () => {
    transport = new TcpTransport({ host: '192.0.2.1', port: 4370 })
    const err = await transport.connect(200).then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(ZkConnectionError)
    // Either the timer fired (the message names it) or the network refused
    // outright (the message names the errno). Never a bare hang.
    expect(err!.message).toMatch(/within 200ms|E[A-Z]+/)
    transport = null
  }, 5_000)
})
