import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload, decodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError } from '../../src/errors.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import type { Transport } from '../../src/transport/Transport.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: Transport | null = null
afterEach(async () => {
  await transport?.close().catch(() => {}); transport = null
  await running?.close(); running = null
})

/** Resolves once `count` packets have reached the listener. */
function collector(count: number): {
  onPacket: (p: Buffer) => void
  onError: (e: Error) => void
  packets: Promise<Buffer[]>
  errors: Error[]
} {
  const got: Buffer[] = []
  const errors: Error[] = []
  let settle: (v: Buffer[]) => void = () => {}
  const packets = new Promise<Buffer[]>((resolve) => { settle = resolve })
  return {
    packets,
    errors,
    onPacket: (p) => { got.push(p); if (got.length >= count) settle(got) },
    onError: (e) => { errors.push(e) },
  }
}

for (const kind of ['tcp', 'udp'] as const) {
  const make = (port: number): Transport =>
    kind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Transport.listen over ${kind}`, () => {
    it('delivers packets that arrive after listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      // The emulator only knows where to push once it has heard from us.
      await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
      await transport.receive(2000)

      const sink = collector(2)
      transport.listen(sink.onPacket, sink.onError)
      running.pushEvent(1, Buffer.from([0xaa]))
      running.pushEvent(1, Buffer.from([0xbb]))

      const got = await sink.packets
      expect(got.map((p) => decodePayload(p).data.toString('hex'))).toEqual(['aa', 'bb'])
    })

    // A packet that lands between a reply and the listen() call is a real
    // event. Both transports park it in a queue; dropping it on the mode
    // switch would lose a punch with no error anywhere.
    it('drains packets that were queued before listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
      await transport.receive(2000)

      running.pushEvent(1, Buffer.from([0xcc]))
      await new Promise((r) => setTimeout(r, 50)) // let it land in the queue, unclaimed

      const sink = collector(1)
      transport.listen(sink.onPacket, sink.onError)
      const got = await sink.packets
      expect(decodePayload(got[0]!).data.toString('hex')).toBe('cc')
    })

    it('refuses a receive() once listening', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      transport.listen(() => {}, () => {})
      await expect(transport.receive(500)).rejects.toThrow(ZkConnectionError)
    })

    it('refuses a second listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      transport.listen(() => {}, () => {})
      expect(() => transport!.listen(() => {}, () => {})).toThrow(ZkConnectionError)
    })
  })
}

describe('Transport.listen over tcp, failure paths', () => {
  // These two are TCP-only because a peer can only die on a connection, and
  // UDP has none: a dead DEVICE over UDP is silence, which is what
  // SubscribeOptions.idleTimeoutMs is for. A dead SOCKET is a different
  // failure and UDP does report it — see the UDP block below.
  it('reports a socket failure to the listener', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)
    for (const socket of running.sockets) socket.destroy()
    await new Promise((r) => setTimeout(r, 100))
    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
  })

  it('reports a failure that was already recorded before listen()', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    for (const socket of running.sockets) socket.destroy()
    await new Promise((r) => setTimeout(r, 100))

    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)
    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
  })
})

/**
 * A post-bind dgram socket error, SIMULATED rather than reproduced.
 *
 * These emit 'error' on the socket directly. A genuine one — the OS refusing
 * a send, an ICMP port-unreachable surfacing as ECONNREFUSED — cannot be
 * provoked deterministically from a test, so the condition is injected at the
 * point the production code observes it. What that leaves unproven is that
 * such an error really reaches this handler on a real network; what it does
 * prove is everything downstream of the handler, which is where the defect
 * was: the only 'error' listener used to be a pre-connect `once` that closed
 * the socket and rejected an already-settled promise, so after connect an
 * error tore the socket down with nobody told, and `listenerError` — assigned
 * in listen() — was never invoked anywhere in the file.
 */
describe('Transport.listen over udp, failure paths', () => {
  /** The live dgram socket, which UdpTransport keeps private. */
  const socketOf = (t: Transport): dgram.Socket =>
    (t as unknown as { socket: dgram.Socket }).socket

  it('reports a socket error to the listener', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)

    socketOf(transport).emit('error', new Error('simulated socket failure'))

    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
    expect(sink.errors[0]?.message).toMatch(/simulated socket failure/)
  })

  it('reports a failure that was already recorded before listen()', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    socketOf(transport).emit('error', new Error('simulated socket failure'))

    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)
    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
  })

  it('fails a pending receive() rather than leaving it to time out', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    // A 30s deadline: a receive() that resolves through the timeout instead of
    // the failure would blow this test's own budget, so passing means the
    // failure path is what ended it.
    const pending = transport.receive(30_000)
    socketOf(transport).emit('error', new Error('simulated socket failure'))
    await expect(pending).rejects.toThrow(ZkConnectionError)
  }, 5000)
})
