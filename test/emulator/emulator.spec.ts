import net from 'node:net'
import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { startEmulator, type Emulator } from './index.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'

let running: Emulator | null = null
afterEach(async () => { await running?.close(); running = null })

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
})
