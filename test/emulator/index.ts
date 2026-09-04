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
   * Makes the READ_BUFFER reply at the given 1-based call count carry
   * exactly `bytes` of DATA for that chunk's transfer, ignoring what was
   * actually requested — fewer than requested is a short chunk, which
   * `readTransfer` refuses as ended early; more is an overshoot, judged
   * against the requested chunk size rather than against the overall total.
   * Exists to exercise both of `readTransfer`'s refusals.
   */
  bufferChunkOverride?: { atCall: number; bytes: number }
  /**
   * Where the PREPARE_BUFFER reply carries its size. 'size-at-1' is the
   * reference's layout (zkteco-js reads `readUIntLE(1, 4)`), five bytes with
   * byte 0 written as 0x00 — its meaning is not recorded anywhere readable.
   * 'size-at-0' is the four-byte layout this library believed before v0.5,
   * kept for experiment E2 (spec v0.5 §12) and deletable after it.
   */
  prepareBufferReply?: 'size-at-1' | 'size-at-0'
  /**
   * How each READ_BUFFER request is answered. 'transfer' is the reference's
   * shape: PREPARE_DATA, DATA packets, ACK_OK (spec v0.5 §6.1 point 3).
   * 'single-packet' is one ACK_DATA carrying the chunk, the v0.4 model, kept
   * for experiment E3 and deletable after it.
   */
  chunkReply?: 'transfer' | 'single-packet'
  /** Answers PREPARE_BUFFER with the whole body inline as CMD_DATA (§6.1 point 2). */
  prepareBufferInline?: boolean
  handlers?: Partial<HandlerTable>
  /**
   * Device parameters, keyed by keyword. A keyword NOT present here is
   * answered with ACK_ERROR — which is how a firmware that does not expose a
   * parameter is modelled. Whether real devices refuse or answer with an
   * empty value is checklist item 16; configure `'~OS': ''` to model the
   * other branch.
   */
  params?: Record<string, string>
  /** Firmware string for CMD_GET_VERSION. Absent or null answers ACK_ERROR. */
  firmware?: string | null
  /**
   * The packed uint32 CMD_GET_TIME answers with, supplied directly.
   *
   * Deliberately raw: this library has no time ENCODER and does not need one,
   * so a test pins a fixed packed value against fixed decoded fields rather
   * than round-tripping through code under test. Absent answers ACK_ERROR.
   */
  deviceTimeRaw?: number
  /**
   * Makes a CMD_OPTIONS_RRQ reply echo THIS keyword instead of the one that
   * was requested — a device answering the wrong question. Exists so the
   * echo guard in src/codec/params.ts has something to catch.
   */
  paramEchoOverride?: string
  /**
   * Which CMD_OPTIONS_RRQ request shape this device understands.
   *
   * Defaults to 'either', which models the tolerant device v0.3 §8.1's
   * "they disagree" branch assumed — pyzk sends the keyword NUL-terminated,
   * zkteco-js sends it bare, and the library ships pyzk's form as a guess
   * (first-hardware checklist item 18). 'nul' and 'bare' model a device that
   * understands only one, so the probe's A/B can be tested against all four
   * outcomes instead of only the one the tolerant default produces.
   */
  keywordForm?: 'nul' | 'bare' | 'either'
  info?: { userCount: number; recordCount: number; recordCapacity: number }
  /**
   * Events written in the SAME handler return as the registration ack, so
   * they land while the client still has no listener attached. Deterministic:
   * the ack consumes the pending waiter, the events find none and queue.
   */
  pushWithAck?: Array<{ eventType: number; data: Buffer }>
  /**
   * Events written BEFORE the registration ack, in the same handler return —
   * a device that pushes in the window between reading CMD_REG_EVENT and
   * writing its acknowledgment. The first event consumes the waiter the
   * registration is holding and the ack lands behind it, which desynchronises
   * every later reply on the session. This is the race Session.subscribe
   * detects and tears the session down for; do not confuse it with
   * `pushWithAck`, which is the benign queue-drain case.
   */
  pushBeforeAck?: Array<{ eventType: number; data: Buffer }>
  /** When true, CMD_REG_EVENT is refused with ACK_ERROR instead of accepted. */
  refuseRegEvent?: boolean
  /**
   * Packets pushed to a subscribed client that are NOT realtime events —
   * a stray acknowledgment interleaved into a listening connection. The probe
   * must count these separately from events (checklist item 13).
   */
  pushNonEvent?: Buffer[]
  /**
   * Destroys the client socket this many milliseconds after acknowledging
   * CMD_REG_EVENT: a subscription that dies mid-window. TCP only.
   */
  dropAfterRegisterMs?: number
  /**
   * Delays every reply by this many milliseconds. For the in-flight guard
   * (spec v0.5 §5.1) and for a reply that lands after the deadline (§5.2).
   */
  replyDelayMs?: number
  /** Extra zero bytes sent as one more DATA packet before the legacy ACK_OK. Spec v0.5 §6.3. */
  legacyOvershootBytes?: number
  /** When false, every reply carries reply id 0 instead of echoing the request's. Experiment E1. */
  echoReplyId?: boolean
  /**
   * Session id written into every reply EXCEPT CONNECT and AUTH, which carry
   * the real one so the client adopts it first. Experiment E1's second half:
   * does the client notice that later replies disagree with what it learned?
   */
  replySessionIdOverride?: number
  /**
   * The user record layout served. 72 is what this library reads. 28 is what
   * zkteco-js decodes over UDP (helper/utils.js:114-126); encoded here from
   * the ZkUser fields ONLY so experiment E4 can serve it to pyzk. This library
   * has no 28-byte decoder and adding one would be a new hypothesis.
   */
  userRecordSize?: 72 | 28
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
  /** The fct field of the last PREPARE_BUFFER request, so a test can pin it. */
  lastPrepareFct: number | null
  /** Set by the transport layer so a handler can end the connection. */
  dropConnection: boolean
  opts: EmulatorOptions
  info: { userCount: number; recordCount: number; recordCapacity: number }
  /** The mask the client last registered with, or null if it never did. */
  eventMask: number | null
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
 *
 * ECONNABORTED belongs here for a specific reason, not as a general widening:
 * the CMD_EXIT handler below writes its ACK_OK back in the same tick it
 * decodes the request, and a subscribed session's `Session.close()` sends
 * EXIT without awaiting a reply (the socket is listening, so a reply would
 * arrive at the listener, not at a receive()) and then destroys the client
 * socket. That write-back can lose the race against the destroy, and on
 * Windows — where this was observed — the loser sees ECONNABORTED rather
 * than the ECONNRESET/EPIPE this project had already seen for the same kind
 * of abrupt goodbye elsewhere. It is a platform code for an existing case,
 * not a new one: do not add further codes here without the same kind of
 * traced mechanism.
 */
function isIgnorableSocketError(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED'
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

/** Builds one reply payload echoing the request's reply id — unless a knob says otherwise. */
export function reply(
  state: EmulatorState,
  req: DecodedPacket,
  command: number,
  data?: Buffer,
): Buffer {
  const handshake = req.command === CMD.CONNECT || req.command === CMD.AUTH
  const sessionId =
    !handshake && state.opts.replySessionIdOverride !== undefined
      ? state.opts.replySessionIdOverride
      : state.sessionId
  const replyId = state.opts.echoReplyId === false ? 0 : req.replyId
  return encodePayload({ command, sessionId, replyId, data })
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
  const overshoot = state.opts.legacyOvershootBytes ?? 0
  if (overshoot > 0) out.push(reply(state, req, CMD.DATA, Buffer.alloc(overshoot)))
  out.push(reply(state, req, CMD.ACK_OK))
  return out
}

/** The 28-byte user record zkteco-js decodes over UDP, for experiment E4 only. */
export function encodeUser28(u: ZkUser): Buffer {
  const b = Buffer.alloc(28)
  b.writeUInt16LE(u.uid, 0)
  b.writeUInt8(u.privilege, 2)
  b.write(u.name, 8, 8, 'latin1')
  b.writeUInt32LE(Number(u.userId) >>> 0, 24)
  return b
}

/** The user list body in the configured record size. */
function userBody(state: EmulatorState): Buffer {
  const size = state.opts.userRecordSize ?? 72
  const records = state.users.map((u) => (size === 28 ? encodeUser28(u) : Buffer.from(u.raw, 'hex')))
  return withSizeHeader(Buffer.concat(records))
}

/** The body a buffered read is currently serving, keyed by nothing — one at a time. */
function bufferedStream(state: EmulatorState, command: number): Buffer {
  if (command === CMD.USERTEMP_RRQ) {
    return userBody(state)
  }
  return state.records ? attendanceBody(state.records) : withSizeHeader(Buffer.alloc(0))
}

const bufferedHandlers: HandlerTable = {
  [CMD.PREPARE_BUFFER]: (req, state) => {
    if (!state.supportsBuffer) return [reply(state, req, CMD.ACK_ERROR)]
    // Request body: <int8 1><int16 command><int32 fct><int32 ext>
    const command = req.data.readUInt16LE(1)
    state.lastPrepareFct = req.data.readUInt32LE(3)
    state.pendingBuffer = bufferedStream(state, command)
    if (state.opts.prepareBufferInline) return [reply(state, req, CMD.DATA, state.pendingBuffer)]
    const layout = state.opts.prepareBufferReply ?? 'size-at-1'
    const size = Buffer.alloc(layout === 'size-at-1' ? 5 : 4)
    size.writeUInt32LE(state.pendingBuffer.length, layout === 'size-at-1' ? 1 : 0)
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
    // bufferChunkOverride overrides the DATA total of this chunk: fewer
    // bytes than asked, or more, to exercise both refusals in readTransfer.
    const override = state.opts.bufferChunkOverride
    const take = override && state.chunksSent === override.atCall ? override.bytes : want
    let slice = state.pendingBuffer.subarray(offset, offset + take)
    if (slice.length < take) slice = Buffer.concat([slice, Buffer.alloc(take - slice.length)])
    if ((state.opts.chunkReply ?? 'transfer') === 'single-packet') {
      return [reply(state, req, CMD.ACK_DATA, slice)]
    }
    // The reference's shape: an announcement (8 bytes, size at 0, rest
    // zero), DATA pieces, ACK_OK. `chunkSize` sizes the pieces, as it does
    // for the legacy transfer.
    const announce = Buffer.alloc(8)
    announce.writeUInt32LE(slice.length, 0)
    const out = [reply(state, req, CMD.PREPARE_DATA, announce)]
    const piece = state.opts.chunkSize ?? 1024
    for (let off = 0; off < slice.length; off += piece) {
      out.push(reply(state, req, CMD.DATA, slice.subarray(off, off + piece)))
    }
    out.push(reply(state, req, CMD.ACK_OK))
    return out
  },
}

/**
 * Terminal read commands.
 *
 * NOTE: these format their replies using THIS LIBRARY'S OWN convention for
 * `keyword=value` — a NUL-terminated latin1 string. So a test that only
 * round-trips through the emulator proves the request/response plumbing, NOT
 * that a real device formats its replies this way. What makes the request
 * shape evidence is an independent implementation sending the same bytes; see
 * test/oracle/params.spec.ts. The reply layout has no such backing at all,
 * because zkteco-js's parser cannot discriminate it (design spec §8.2).
 */
const terminalHandlers: HandlerTable = {
  [CMD.OPTIONS_RRQ]: (req, state) => {
    const raw = req.data.toString('latin1')
    const hasNul = raw.endsWith('\0')
    const keyword = hasNul ? raw.slice(0, -1) : raw
    // A device that understands only one request shape refuses the other
    // outright — indistinguishable, from the client's side, from refusing an
    // unknown keyword. That ambiguity is real and is why the probe's A/B has
    // a 'neither' outcome (design spec §4.2).
    const form = state.opts.keywordForm ?? 'either'
    if (form === 'nul' && !hasNul) return [reply(state, req, CMD.ACK_ERROR)]
    if (form === 'bare' && hasNul) return [reply(state, req, CMD.ACK_ERROR)]
    const params = state.opts.params ?? {}
    if (!Object.hasOwn(params, keyword)) return [reply(state, req, CMD.ACK_ERROR)]
    const echoed = state.opts.paramEchoOverride ?? keyword
    const body = Buffer.from(`${echoed}=${params[keyword]}\0`, 'latin1')
    return [reply(state, req, CMD.ACK_OK, body)]
  },
  [CMD.GET_VERSION]: (req, state) => {
    const firmware = state.opts.firmware
    if (firmware === undefined || firmware === null) {
      return [reply(state, req, CMD.ACK_ERROR)]
    }
    return [reply(state, req, CMD.ACK_OK, Buffer.from(firmware, 'latin1'))]
  },
  [CMD.GET_TIME]: (req, state) => {
    const raw = state.opts.deviceTimeRaw
    if (raw === undefined) return [reply(state, req, CMD.ACK_ERROR)]
    const body = Buffer.alloc(4)
    body.writeUInt32LE(raw >>> 0, 0)
    return [reply(state, req, CMD.ACK_OK, body)]
  },
}

// CMD.AUTH here validates the mixed key using this library's OWN mixCommKey
// (Task 5). That makes this handler and the tests it backs proof of the
// authentication FLOW — challenge, mixed reply, ACK — not of whether
// mixCommKey computes the bytes a real device expects. The algorithm itself
// is pinned separately by the oracle fixtures in test/oracle/commkey.spec.ts.
const baseHandlers: HandlerTable = {
  ...bufferedHandlers,
  ...terminalHandlers,
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
  [CMD.USERTEMP_RRQ]: (req, state) => serveDataLegacy(state, req, userBody(state)),
  [CMD.FREE_DATA]: (req, state) => [reply(state, req, CMD.ACK_OK)],
  [CMD.REG_EVENT]: (req, state) => {
    if (state.opts.refuseRegEvent) return [reply(state, req, CMD.ACK_ERROR)]
    state.eventMask = req.data.length >= 4 ? req.data.readUInt32LE(0) : 0
    const ack = reply(state, req, CMD.ACK_OK)
    const early = (state.opts.pushBeforeAck ?? []).map((p) => eventPacket(p.eventType, p.data))
    const pushes = state.opts.pushWithAck ?? []
    const strays = state.opts.pushNonEvent ?? []
    return [
      ...early,
      ack,
      ...pushes.map((p) => eventPacket(p.eventType, p.data)),
      ...strays,
    ]
  },
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
    lastPrepareFct: null,
    dropConnection: false,
    opts,
    info: opts.info ?? { userCount: 0, recordCount: 0, recordCapacity: 0 },
    eventMask: null,
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

  const respond = (raw: Buffer, payload: Buffer, req: DecodedPacket): Buffer[] | null => {
    receivedRaw.push(Buffer.from(raw))
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
          const req = decodePayload(framed.payload)
          const out = respond(Buffer.from(raw), framed.payload, req)
          if (out) {
            const write = (): void => { if (!sock.destroyed) for (const p of out) sock.write(frameTcp(p)) }
            if (opts.replyDelayMs) setTimeout(write, opts.replyDelayMs)
            else write()
          }
          // A subscription the device kills mid-window: the probe must notice
          // rather than sleep out the rest of it.
          if (opts.dropAfterRegisterMs !== undefined && req.command === CMD.REG_EVENT) {
            setTimeout(() => { if (!sock.destroyed) sock.destroy() }, opts.dropAfterRegisterMs)
          }
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
    const out = respond(Buffer.from(msg), Buffer.from(msg), decodePayload(msg))
    if (out) {
      const write = (): void => { for (const p of out) sock.send(p, rinfo.port, rinfo.address) }
      if (opts.replyDelayMs) {
        setTimeout(() => {
          try { write() } catch { /* emulator closed first */ }
        }, opts.replyDelayMs)
      } else {
        write()
      }
    }
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
