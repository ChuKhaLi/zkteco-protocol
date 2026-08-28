import net from 'node:net'
import dgram from 'node:dgram'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import type { ZkUser } from '../../src/types.js'

export interface EmulatorRecords {
  size: 8 | 16 | 40
  rows: Buffer[]
  /** Overrides the declared totalSize, to exercise the framing guard. */
  totalSizeOverride?: number
  junkPrefix?: boolean
}

export interface EmulatorOptions {
  transport: 'tcp' | 'udp'
  commKey?: number
  sessionId?: number
  users?: ZkUser[]
  records?: EmulatorRecords
  behavior?: 'normal' | 'silent' | 'dropMidTransfer'
  dropAfterChunk?: number
  chunkSize?: number
  /** When false, the buffered-read commands are refused so the caller must
   *  fall back to the legacy path. */
  supportsBuffer?: boolean
  handlers?: Partial<HandlerTable>
}

export interface EmulatorState {
  sessionId: number
  commKey: number
  authenticated: boolean
  users: ZkUser[]
  records: EmulatorRecords | null
  supportsBuffer: boolean
  chunksSent: number
  /** Set by the transport layer so a handler can end the connection. */
  dropConnection: boolean
  opts: EmulatorOptions
}

export type Handler = (req: DecodedPacket, state: EmulatorState) => Buffer[] | null
export type HandlerTable = Record<number, Handler>

export interface Emulator {
  readonly port: number
  readonly transport: 'tcp' | 'udp'
  readonly received: DecodedPacket[]
  readonly receivedRaw: Buffer[]
  readonly state: EmulatorState
  close(): Promise<void>
}

/** Builds one reply payload echoing the request's reply id. */
export function reply(
  state: EmulatorState,
  req: DecodedPacket,
  command: number,
  data?: Buffer,
): Buffer {
  return encodePayload({ command, sessionId: state.sessionId, replyId: req.replyId, data })
}

const baseHandlers: HandlerTable = {
  [CMD.CONNECT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
  [CMD.EXIT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
}

function buildState(opts: EmulatorOptions): EmulatorState {
  return {
    sessionId: opts.sessionId ?? 0x0001,
    commKey: opts.commKey ?? 0,
    authenticated: (opts.commKey ?? 0) === 0,
    users: opts.users ?? [],
    records: opts.records ?? null,
    supportsBuffer: opts.supportsBuffer ?? true,
    chunksSent: 0,
    dropConnection: false,
    opts,
  }
}

export async function startEmulator(opts: EmulatorOptions): Promise<Emulator> {
  const state = buildState(opts)
  // Partial<HandlerTable> makes every value `Handler | undefined` (how
  // Partial distributes over an index signature), even though a caller
  // never legitimately registers an undefined handler. The runtime
  // `if (!handler)` guard in respond() covers that case regardless.
  const handlers = { ...baseHandlers, ...(opts.handlers ?? {}) } as HandlerTable
  const received: DecodedPacket[] = []
  const receivedRaw: Buffer[] = []

  const respond = (raw: Buffer, payload: Buffer): Buffer[] | null => {
    receivedRaw.push(Buffer.from(raw))
    const req = decodePayload(payload)
    received.push(req)
    if (opts.behavior === 'silent') return null
    const handler = handlers[req.command]
    if (!handler) return [reply(state, req, CMD.ACK_ERROR)]
    return handler(req, state)
  }

  if (opts.transport === 'tcp') {
    // Tracked so close() can force-drop connections a test leaves dangling
    // (e.g. a 'silent' emulator that a client never disconnects from):
    // server.close() alone waits for every open socket to end on its own.
    const sockets = new Set<net.Socket>()
    const server = net.createServer((sock) => {
      sockets.add(sock)
      sock.on('close', () => sockets.delete(sock))
      let acc = Buffer.alloc(0)
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk])
        for (;;) {
          const framed = tryUnframeTcp(acc)
          if (!framed) break
          const raw = acc.subarray(0, framed.consumed)
          acc = acc.subarray(framed.consumed)
          const out = respond(Buffer.from(raw), framed.payload)
          if (out) for (const p of out) sock.write(frameTcp(p))
          if (state.dropConnection) { state.dropConnection = false; sock.destroy() }
        }
      })
      sock.on('error', () => { /* client-side resets are expected in tests */ })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return {
      port, transport: 'tcp', received, receivedRaw, state,
      close: () => new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
    }
  }

  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, rinfo) => {
    const out = respond(Buffer.from(msg), Buffer.from(msg))
    if (out) for (const p of out) sock.send(p, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve))
  const port = sock.address().port
  return {
    port, transport: 'udp', received, receivedRaw, state,
    close: () => new Promise<void>((resolve) => { sock.close(() => resolve()) }),
  }
}
