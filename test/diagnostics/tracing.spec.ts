import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkTimeoutError } from '../../src/errors.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { TracingTransport } from '../../src/diagnostics/TracingTransport.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** A clock that advances 1ms per call, so offsets are predictable. */
function fakeClock(): () => number {
  let t = 0
  return () => t++
}

describe('TracingTransport', () => {
  it('records both directions of a request-response exchange', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    session = new Session(traced, { timeoutMs: 2000 })
    await session.open()

    const sends = traced.events.filter((e) => e.direction === 'send')
    const recvs = traced.events.filter((e) => e.direction === 'recv')
    expect(sends[0]?.command).toBe(CMD.CONNECT)
    expect(recvs.length).toBeGreaterThan(0)
    // Every event carries the bytes, because item 2 reconciles a checksum over
    // exact bytes and a decoded header alone cannot be re-checksummed.
    expect(sends[0]?.hex).toMatch(/^[0-9a-f]+$/)
  })

  it('numbers events in order and stamps each from the injected clock', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    session = new Session(traced, { timeoutMs: 2000 })
    await session.open()
    const seqs = traced.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    // Verify offsetMs values are stamped from the injected clock
    const offsets = traced.events.map((e) => e.offsetMs)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(Math.max(...offsets)).toBeGreaterThan(0)
  })

  it('records a timeout as an error event rather than swallowing it', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    await traced.connect()
    await traced.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    await expect(traced.receive(60)).rejects.toBeInstanceOf(ZkTimeoutError)
    await traced.close()

    const errors = traced.events.filter((e) => e.direction === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.errorClass).toBe('ZkTimeoutError')
  })

  it('passes pushed packets through to the listener and records them', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    await traced.connect()
    const seen: Buffer[] = []
    traced.listen((p) => seen.push(p), () => {})
    running.pushRaw(encodePayload({ command: CMD.REG_EVENT, sessionId: 1, replyId: 0 }))
    await new Promise((r) => setTimeout(r, 100))
    await traced.close()

    expect(seen).toHaveLength(1)
    expect(traced.events.filter((e) => e.direction === 'push')).toHaveLength(1)
  })

  it('records synchronous throws from listen() as error events', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    await traced.connect()
    traced.listen(() => {}, () => {})
    // A second listen() on the same socket synchronously throws per spec
    expect(() => traced.listen(() => {}, () => {})).toThrow()
    await traced.close()

    // Verify the throw was recorded as an error event
    const errors = traced.events.filter((e) => e.direction === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[errors.length - 1]?.errorClass).toBe('ZkConnectionError')
  })
})
