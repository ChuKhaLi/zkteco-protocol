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

const event = (eventType: number, byte: number): Buffer =>
  encodePayload({
    command: CMD.REG_EVENT,
    sessionId: eventType,
    replyId: 0,
    data: Buffer.from([byte]),
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
  // UDP has no connection to lose and no socket-level failure to replay, so
  // these two are TCP-only by nature rather than by omission. On UDP a dead
  // device is silence, which is what SubscribeOptions.idleTimeoutMs is for.
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
