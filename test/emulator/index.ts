import net from 'node:net'
import dgram from 'node:dgram'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { FREE_SIZES_OFFSET } from '../../src/commands/info.js'
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
  /**
   * Makes the READ_BUFFER reply at the given 1-based call count return
   * exactly `bytes`, ignoring what was actually requested — fewer to
   * exercise a valid short read that doesn't end the transfer, or more to
   * exercise a device that overshoots past the declared total.
   */
  bufferChunkOverride?: { atCall: number; bytes: number }
  handlers?: Partial<HandlerTable>
  info?: { userCount: number; recordCount: number; recordCapacity: number }
}

export interface EmulatorState {
  sessionId: number
  commKey: number
  authenticated: boolean
  users: ZkUser[]
  records: EmulatorRecords | null
  supportsBuffer: boolean
  chunksSent: number
  /** The body a buffered read (PREPARE_BUFFER/READ_BUFFER) is currently serving. */
  pendingBuffer: Buffer | null
  /** Set by the transport layer so a handler can end the connection. */
  dropConnection: boolean
  opts: EmulatorOptions
  info: { userCount: number; recordCount: number; recordCapacity: number }
}

export type Handler = (req: DecodedPacket, state: EmulatorState) => Buffer[] | null
export type HandlerTable = Record<number, Handler>

export interface Emulator {
  readonly port: number
  readonly transport: 'tcp' | 'udp'
  readonly received: DecodedPacket[]
  readonly receivedRaw: Buffer[]
  readonly socketErrors: Error[]
  readonly state: EmulatorState
  /** Live client sockets. TCP only; empty on UDP. Lets a test write raw bytes. */
  readonly sockets: ReadonlySet<net.Socket>
  /** Pushes an unsolicited realtime event to the connected client. */
  pushEvent(eventType: number, data: Buffer): void
  /** Pushes arbitrary bytes as one packet — for the not-an-event scenario. */
  pushRaw(payload: Buffer): void
  close(): Promise<void>
}

/**
 * Abrupt client teardown legitimately produces these; anything else means the
 * emulator itself is unhealthy and must not go unnoticed. Shared by the TCP
 * and UDP error handlers so the ignore list can't drift between them.
 */
function isIgnorableSocketError(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE'
}

/** Prefixes a body with the 4-byte totalSize header the device sends. */
export function withSizeHeader(body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** Builds the attendance body the emulator was configured with. */
export function attendanceBody(records: EmulatorRecords): Buffer {
  const rows = Buffer.concat(records.rows)
  const prefixed = records.junkPrefix
    ? Buffer.concat([Buffer.from([0xff, 0x32, 0x35, 0x35, 0, 0, 0, 0, 0]), rows])
    : rows
  const head = Buffer.alloc(4)
  head.writeUInt32LE(records.totalSizeOverride ?? prefixed.length, 0)
  return Buffer.concat([head, prefixed])
}

/**
 * Builds one unsolicited realtime event.
 *
 * NOTE: this uses the LIBRARY'S OWN encoder, so a test that only round-trips
 * through the emulator proves the plumbing, not the layout. What makes the
 * event-type-in-the-session-id-slot claim evidence is an independent
 * implementation decoding these bytes — see test/oracle/realtime.spec.ts.
 */
export function eventPacket(eventType: number, data: Buffer): Buffer {
  return encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data })
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

/**
 * Builds a CMD_GET_FREE_SIZES reply body using the library's own offsets.
 *
 * Because this reuses FREE_SIZES_OFFSET from src/commands/info.ts rather than
 * an independent encoding, the getInfo tests this backs prove the request/
 * response plumbing — session flow, framing, decoding — NOT that the offsets
 * themselves match a real device. See the provenance note on FREE_SIZES_OFFSET.
 */
export function encodeFreeSizes(info: EmulatorState['info']): Buffer {
  const buf = Buffer.alloc(FREE_SIZES_OFFSET.recordCapacity + 4)
  buf.writeUInt32LE(info.userCount, FREE_SIZES_OFFSET.userCount)
  buf.writeUInt32LE(info.recordCount, FREE_SIZES_OFFSET.recordCount)
  buf.writeUInt32LE(info.recordCapacity, FREE_SIZES_OFFSET.recordCapacity)
  return buf
}

/**
 * Answers a bulk-read command the legacy way: inline when the body is small,
 * otherwise PREPARE_DATA, a run of CMD_DATA chunks, and a closing ACK_OK.
 */
export function serveDataLegacy(
  state: EmulatorState,
  req: DecodedPacket,
  stream: Buffer,
): Buffer[] {
  const chunkSize = state.opts.chunkSize ?? 1024
  if (stream.length <= chunkSize) return [reply(state, req, CMD.ACK_DATA, stream)]

  const size = Buffer.alloc(4)
  size.writeUInt32LE(stream.length, 0)
  const out: Buffer[] = [reply(state, req, CMD.PREPARE_DATA, size)]
  for (let off = 0; off < stream.length; off += chunkSize) {
    state.chunksSent += 1
    if (
      state.opts.behavior === 'dropMidTransfer' &&
      state.chunksSent > (state.opts.dropAfterChunk ?? 1)
    ) {
      state.dropConnection = true
      return out
    }
    out.push(reply(state, req, CMD.DATA, stream.subarray(off, off + chunkSize)))
  }
  out.push(reply(state, req, CMD.ACK_OK))
  return out
}

/** The body a buffered read is currently serving, keyed by nothing — one at a time. */
function bufferedStream(state: EmulatorState, command: number): Buffer {
  if (command === CMD.USERTEMP_RRQ) {
    return withSizeHeader(Buffer.concat(state.users.map((u) => Buffer.from(u.raw, 'hex'))))
  }
  return state.records ? attendanceBody(state.records) : withSizeHeader(Buffer.alloc(0))
}

const bufferedHandlers: HandlerTable = {
  [CMD.PREPARE_BUFFER]: (req, state) => {
    if (!state.supportsBuffer) return [reply(state, req, CMD.ACK_ERROR)]
    // Request body: <int8 1><int16 command><int32 fct><int32 ext>
    const command = req.data.readUInt16LE(1)
    state.pendingBuffer = bufferedStream(state, command)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(state.pendingBuffer.length, 0)
    return [reply(state, req, CMD.ACK_OK, size)]
  },
  [CMD.READ_BUFFER]: (req, state) => {
    if (!state.supportsBuffer || !state.pendingBuffer) {
      return [reply(state, req, CMD.ACK_ERROR)]
    }
    const offset = req.data.readUInt32LE(0)
    const want = req.data.readUInt32LE(4)
    state.chunksSent += 1
    if (
      state.opts.behavior === 'dropMidTransfer' &&
      state.chunksSent > (state.opts.dropAfterChunk ?? 1)
    ) {
      state.dropConnection = true
      return []
    }
    const override = state.opts.bufferChunkOverride
    const take = override && state.chunksSent === override.atCall ? override.bytes : want
    let slice = state.pendingBuffer.subarray(offset, offset + take)
    // subarray clamps to the buffer's own length, so an override asking for
    // more bytes than remain there needs padding to actually simulate a
    // device sending more bytes than were requested.
    if (slice.length < take) {
      slice = Buffer.concat([slice, Buffer.alloc(take - slice.length)])
    }
    return [reply(state, req, CMD.ACK_DATA, slice)]
  },
}

// CMD.AUTH here validates the mixed key using this library's OWN mixCommKey
// (Task 5). That makes this handler and the tests it backs proof of the
// authentication FLOW — challenge, mixed reply, ACK — not of whether
// mixCommKey computes the bytes a real device expects. The algorithm itself
// is pinned separately by the oracle fixtures in test/oracle/commkey.spec.ts.
const baseHandlers: HandlerTable = {
  ...bufferedHandlers,
  [CMD.CONNECT]: (req, state) => {
    // A CONNECT begins a fresh session, so it must not inherit whatever a
    // PREVIOUS connection to this same emulator instance settled: without
    // this reset, one client authenticating with the right comm key leaves
    // `state.authenticated` true forever, and a LATER connection presenting
    // the wrong key — or none at all — would be waved through instead of
    // challenged.
    state.authenticated = state.commKey === 0
    return [reply(state, req, state.authenticated ? CMD.ACK_OK : CMD.ACK_UNAUTH)]
  },
  [CMD.AUTH]: (req, state) => {
    const expected = mixCommKey(state.commKey, state.sessionId)
    if (req.data.equals(expected)) {
      state.authenticated = true
      return [reply(state, req, CMD.ACK_OK)]
    }
    return [reply(state, req, CMD.ACK_UNAUTH)]
  },
  [CMD.EXIT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
  [CMD.GET_FREE_SIZES]: (req, state) => [
    reply(state, req, CMD.ACK_OK, encodeFreeSizes(state.info)),
  ],
  [CMD.ATTLOG_RRQ]: (req, state) =>
    serveDataLegacy(state, req, state.records ? attendanceBody(state.records) : withSizeHeader(Buffer.alloc(0))),
  [CMD.USERTEMP_RRQ]: (req, state) =>
    serveDataLegacy(state, req, withSizeHeader(Buffer.concat(state.users.map((u) => Buffer.from(u.raw, 'hex'))))),
  [CMD.FREE_DATA]: (req, state) => [reply(state, req, CMD.ACK_OK)],
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
    pendingBuffer: null,
    dropConnection: false,
    opts,
    info: opts.info ?? { userCount: 0, recordCount: 0, recordCapacity: 0 },
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
  const socketErrors: Error[] = []

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
          if (state.dropConnection) {
            state.dropConnection = false
            sock.destroy()
            break // the socket is gone; a further complete frame in `acc` must not be answered
          }
        }
      })
      sock.on('error', (err) => {
        if (isIgnorableSocketError(err as NodeJS.ErrnoException)) return
        socketErrors.push(err)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return {
      port, transport: 'tcp', received, receivedRaw, socketErrors, state, sockets,
      pushRaw: (payload) => { for (const s of sockets) s.write(frameTcp(payload)) },
      pushEvent: (eventType, data) => {
        for (const s of sockets) s.write(frameTcp(eventPacket(eventType, data)))
      },
      close: () => new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
    }
  }

  const sock = dgram.createSocket('udp4')
  // Durable for the socket's whole working life (bind and beyond): a dgram
  // socket with no 'error' listener throws on error and can take the test
  // process down, and the point of socketErrors is that this never happens
  // silently either.
  sock.on('error', (err) => {
    if (isIgnorableSocketError(err as NodeJS.ErrnoException)) return
    socketErrors.push(err)
  })
  let lastClient: { port: number; address: string } | null = null
  sock.on('message', (msg, rinfo) => {
    lastClient = { port: rinfo.port, address: rinfo.address }
    const out = respond(Buffer.from(msg), Buffer.from(msg))
    if (out) for (const p of out) sock.send(p, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve))
  const port = sock.address().port
  return {
    port, transport: 'udp', received, receivedRaw, socketErrors, state, sockets: new Set<net.Socket>(),
    pushRaw: (payload) => {
      if (lastClient) sock.send(payload, lastClient.port, lastClient.address)
    },
    pushEvent: (eventType, data) => {
      if (lastClient) sock.send(eventPacket(eventType, data), lastClient.port, lastClient.address)
    },
    close: () => new Promise<void>((resolve) => { sock.close(() => resolve()) }),
  }
}
