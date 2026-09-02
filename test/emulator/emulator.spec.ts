import net from 'node:net'
import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeUser28, startEmulator, type Emulator } from './index.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { Session } from '../../src/session/Session.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
let transport: TcpTransport | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await transport?.close(); transport = null
  await running?.close(); running = null
})

/** Sends one raw payload and resolves with the first reply payload. */
function roundTripTcp(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(frameTcp(payload))
    })
    let acc = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk])
      const framed = tryUnframeTcp(acc)
      if (framed) { sock.destroy(); resolve(framed.payload) }
    })
    sock.on('error', reject)
  })
}

function roundTripUdp(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    sock.on('message', (msg) => { sock.close(); resolve(Buffer.from(msg)) })
    sock.on('error', reject)
    sock.send(payload, port, '127.0.0.1')
  })
}

describe('emulator', () => {
  it('answers CMD_CONNECT with ACK_OK carrying its session id over TCP', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0xbeef })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })),
    )
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0xbeef)
  })

  it('answers CMD_CONNECT over UDP with no TCP prefix', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x1234 })
    const raw = await roundTripUdp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    // A bare payload: no start marker, and the first two bytes are the command.
    expect(raw.readUInt16LE(0)).toBe(CMD.ACK_OK)
    expect(decodePayload(raw).sessionId).toBe(0x1234)
  })

  it('echoes the reply id it was sent', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 41 })),
    )
    expect(reply.replyId).toBe(41)
  })

  it('records every payload it received, decoded', async () => {
    running = await startEmulator({ transport: 'tcp' })
    await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT])
  })

  it('records raw wire bytes including the TCP prefix', async () => {
    running = await startEmulator({ transport: 'tcp' })
    await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(running.receivedRaw[0]!.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
  })

  it('answers an unknown command with ACK_ERROR', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: 9999, sessionId: 1, replyId: 0 })),
    )
    expect(reply.command).toBe(CMD.ACK_ERROR)
  })

  it('says nothing at all when behavior is silent', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    const port = running.port
    const settled = await Promise.race([
      roundTripTcp(port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })).then(() => 'replied'),
      new Promise((r) => setTimeout(() => r('silent'), 300)),
    ])
    expect(settled).toBe('silent')
  })

  it('binds an ephemeral port and reports it', async () => {
    running = await startEmulator({ transport: 'tcp' })
    expect(running.port).toBeGreaterThan(0)
  })

  it('acknowledges a subscription and records the mask it was given', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(
      encodePayload({
        command: CMD.REG_EVENT,
        sessionId: 1,
        replyId: 0,
        data: Buffer.from([0x01, 0x00, 0x00, 0x00]),
      }),
    )
    const reply = decodePayload(await transport.receive(2000))
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(running.state.eventMask).toBe(1)
    await transport.close()
  })

  // The registration ack and the events are written in one tick, so the
  // client's absorb() consumes the ack with its pending waiter and finds no
  // waiter for the events, which land in the queue. That is the queued-packet
  // race the listen() drain exists for, made deterministic.
  it('can push events in the same write as the registration ack', async () => {
    running = await startEmulator({
      transport: 'tcp',
      pushWithAck: [{ eventType: 1, data: Buffer.from([0x01]) }],
    })
    const transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(
      encodePayload({ command: CMD.REG_EVENT, sessionId: 1, replyId: 0, data: Buffer.alloc(4) }),
    )
    expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
    // The event arrived too, and is waiting.
    expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.REG_EVENT)
    await transport.close()
  })
})

// TCP only. The emulator has one handler table shared by both dispatch
// paths — respond() is the common code the TCP and UDP branches both call
// into — so exercising a handler over TCP exercises the same code UDP would
// reach too. test/commands/device.spec.ts drives these same handlers over
// both transports once the client-facing terminal-read commands exist.
describe('terminal read handlers', () => {
  it('answers a configured keyword and refuses an unconfigured one', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~OS': 'Linux' },
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const ok = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1'))
      expect(ok.command).toBe(CMD.ACK_OK)
      expect(ok.data.toString('latin1').replace(/\0+$/, '')).toBe('~OS=Linux')

      const refused = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SSR', 'latin1'))
      expect(refused.command).toBe(CMD.ACK_ERROR)
    } finally {
      await session.close()
    }
  })

  it('echoes a different keyword when paramEchoOverride is set', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~DeviceName': 'Gate' },
      paramEchoOverride: '~Platform',
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const res = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~DeviceName', 'latin1'))
      expect(res.data.toString('latin1').replace(/\0+$/, '')).toBe('~Platform=Gate')
    } finally {
      await session.close()
    }
  })

  it('serves firmware and the clock, and refuses both when unconfigured', async () => {
    running = await startEmulator({
      transport: 'tcp',
      firmware: 'Ver 6.60 Jun 10 2019',
      deviceTimeRaw: 0x2b1f_c4d0,
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const fw = await session.tryExecute(CMD.GET_VERSION)
      expect(fw.data.toString('latin1')).toBe('Ver 6.60 Jun 10 2019')

      const clock = await session.tryExecute(CMD.GET_TIME)
      expect(clock.data.readUInt32LE(0)).toBe(0x2b1f_c4d0)
    } finally {
      await session.close()
    }
    await running.close()

    // Neither firmware nor deviceTimeRaw is configured on this second
    // instance, so both commands must fall back to ACK_ERROR.
    running = await startEmulator({ transport: 'tcp' })
    const unconfigured = new Session(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      { timeoutMs: 2000 },
    )
    await unconfigured.open()
    try {
      const fw = await unconfigured.tryExecute(CMD.GET_VERSION)
      expect(fw.command).toBe(CMD.ACK_ERROR)

      const clock = await unconfigured.tryExecute(CMD.GET_TIME)
      expect(clock.command).toBe(CMD.ACK_ERROR)
    } finally {
      await unconfigured.close()
    }
  })
})

describe('emulator keywordForm', () => {
  const open = async (port: number): Promise<Session> => {
    const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  it("defaults to tolerating either request shape", async () => {
    running = await startEmulator({ transport: 'tcp', params: { '~SerialNumber': 'ABC' } })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).not.toBe(CMD.ACK_ERROR)
    expect(bare.command).not.toBe(CMD.ACK_ERROR)
  })

  it("refuses the bare shape when keywordForm is 'nul'", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'ABC' },
      keywordForm: 'nul',
    })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).not.toBe(CMD.ACK_ERROR)
    expect(bare.command).toBe(CMD.ACK_ERROR)
  })

  it("refuses the NUL-terminated shape when keywordForm is 'bare'", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'ABC' },
      keywordForm: 'bare',
    })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).toBe(CMD.ACK_ERROR)
    expect(bare.command).not.toBe(CMD.ACK_ERROR)
  })
})

describe('experiment knobs', () => {
  it('can stop echoing the reply id', async () => {
    running = await startEmulator({ transport: 'tcp', echoReplyId: false })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 7 }))
    expect(decodePayload(await transport.receive(2_000)).replyId).toBe(0)
  })

  it('can answer every command after the handshake with a wrong session id', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x1111, replySessionIdOverride: 0x2222 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(decodePayload(await transport.receive(2_000)).sessionId).toBe(0x1111)
    await transport.send(encodePayload({ command: CMD.GET_FREE_SIZES, sessionId: 0x1111, replyId: 1 }))
    expect(decodePayload(await transport.receive(2_000)).sessionId).toBe(0x2222)
  })

  it('serves 28-byte user records when asked to', () => {
    const u: ZkUser = { uid: 3, userId: '42', name: 'Ann', privilege: 0, hasPassword: false, cardNumber: 0, raw: '' }
    const rec = encodeUser28(u)
    expect(rec.length).toBe(28)
    expect(rec.readUInt16LE(0)).toBe(3)
    expect(rec.subarray(8, 16).toString('latin1').replace(/\0+$/, '')).toBe('Ann')
    expect(rec.readUInt32LE(24)).toBe(42)
  })
})
