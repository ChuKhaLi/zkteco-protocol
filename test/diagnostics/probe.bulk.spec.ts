import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload, type DecodedPacket } from '../../src/codec/packet.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { TracingTransport } from '../../src/diagnostics/TracingTransport.js'
import {
  ATTENDANCE_AUTO_THRESHOLD, emptyFindings, encodingVerdict, inferBulkPath, probeBulk,
} from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'latin1')
  b.write(userId, 48, 8, 'latin1')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'latin1')
  b.writeUInt32LE(t, 27)
  return b
}

/** A clock that advances 1ms per call, so trace offsets are predictable. */
function fakeClock(): () => number {
  let t = 0
  return () => t++
}

/** Opens a session through a TracingTransport, so a test can inspect the wire trace. */
async function open(port: number): Promise<{ session: Session; traced: TracingTransport }> {
  const traced = new TracingTransport(new TcpTransport({ host: '127.0.0.1', port }), fakeClock())
  const session = new Session(traced, { timeoutMs: 2000 })
  await session.open()
  return { session, traced }
}

/**
 * True when this wire packet is a request for the attendance log, whether
 * sent as the legacy CMD_ATTLOG_RRQ or wrapped in a buffered-read
 * CMD_PREPARE_BUFFER (whose body embeds the target command as a uint16 at
 * offset 1). A skip that still sends either of these hit the wire, which is
 * not a skip -- and a bare `not.toContain(CMD.PREPARE_BUFFER)` would produce
 * a false failure here regardless, since the user-list read this probe
 * always performs first also goes out wrapped in CMD_PREPARE_BUFFER.
 */
function requestsAttendance(pkt: DecodedPacket): boolean {
  if (pkt.command === CMD.ATTLOG_RRQ) return true
  return pkt.command === CMD.PREPARE_BUFFER && pkt.data.length >= 3 && pkt.data.readUInt16LE(1) === CMD.ATTLOG_RRQ
}

/** Builds a synthetic 'send' TraceEvent for a direct (legacy-shaped) command. */
function directSend(command: number): TraceEvent {
  const payload = encodePayload({ command, sessionId: 1, replyId: 1 })
  return { seq: 0, direction: 'send', offsetMs: 0, hex: payload.toString('hex'), command }
}

/** Builds a synthetic 'send' TraceEvent for a PREPARE_BUFFER wrapping `targetCommand`. */
function bufferedSend(targetCommand: number): TraceEvent {
  // <int8 1><int16 command><int32 fct><int32 ext>, the layout readBulkBuffered writes.
  const body = Buffer.alloc(11)
  body.writeUInt8(1, 0)
  body.writeUInt16LE(targetCommand, 1)
  body.writeUInt32LE(0, 3)
  body.writeUInt32LE(0, 7)
  const payload = encodePayload({ command: CMD.PREPARE_BUFFER, sessionId: 1, replyId: 1, data: body })
  return { seq: 0, direction: 'send', offsetMs: 0, hex: payload.toString('hex'), command: CMD.PREPARE_BUFFER }
}

describe('encodingVerdict', () => {
  it('reports pure ASCII as no high bytes and no UTF-8 verdict', () => {
    expect(encodingVerdict(['Alice', 'Bob'])).toEqual({
      namesInspected: 2, withHighBytes: 0, validUtf8: null,
    })
  })

  it('recognises latin1-carried UTF-8 as valid UTF-8', () => {
    // The name arrives as latin1 (byte-preserving), so re-encoding to latin1
    // recovers the device's exact bytes -- which is what makes this decidable
    // without ever shipping the name.
    const utf8 = Buffer.from('Nguyễn', 'utf8').toString('latin1')
    expect(encodingVerdict([utf8])).toMatchObject({ withHighBytes: 1, validUtf8: true })
  })

  it('recognises a non-UTF-8 high-byte sequence as not valid UTF-8', () => {
    const gb = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]).toString('latin1')
    expect(encodingVerdict([gb])).toMatchObject({ withHighBytes: 1, validUtf8: false })
  })

  it('never returns the names themselves', () => {
    const verdict = encodingVerdict(['Alice'])
    expect(JSON.stringify(verdict)).not.toContain('Alice')
  })
})

describe('inferBulkPath', () => {
  it('reports buffered from a PREPARE_BUFFER send wrapping USERTEMP_RRQ', () => {
    expect(inferBulkPath([bufferedSend(CMD.USERTEMP_RRQ)])).toBe('buffered')
  })

  it('reports legacy from a direct USERTEMP_RRQ send', () => {
    expect(inferBulkPath([directSend(CMD.USERTEMP_RRQ)])).toBe('legacy')
  })

  it('reports legacy for the fallback trace, even though the refused PREPARE_BUFFER attempt sent first', () => {
    // This is the exact shape readBulk produces when the device refuses the
    // buffered commands: a PREPARE_BUFFER send (later answered ACK_ERROR)
    // precedes the legacy fallback's direct send. "First match in trace
    // order" would stop at the PREPARE_BUFFER send and report 'buffered' for
    // a read buffered never actually served -- confidently wrong.
    const events = [bufferedSend(CMD.USERTEMP_RRQ), directSend(CMD.USERTEMP_RRQ)]
    expect(inferBulkPath(events)).toBe('legacy')
  })

  it('reports null when neither shape appears in the trace', () => {
    expect(inferBulkPath([])).toBeNull()
    expect(inferBulkPath([directSend(CMD.GET_VERSION)])).toBeNull()
  })
})

describe('probeBulk', () => {
  it('reads users and reports the buffered path when the device supports it', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    await probeBulk(
      session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' }, opened.traced.events,
    )
    expect(findings.bulkPath).toBe('buffered')
    expect(findings.attendance).toMatchObject({ read: true, detectedRecordSize: 40 })
  })

  it('reports the legacy path when the device refuses the buffered commands', async () => {
    running = await startEmulator({
      transport: 'tcp',
      supportsBuffer: false,
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    await probeBulk(
      session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' }, opened.traced.events,
    )
    expect(findings.bulkPath).toBe('legacy')
  })

  it('skips the attendance read above the threshold and says why', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1_000_000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1_000_000, rawHex: '',
    }
    await probeBulk(
      session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' }, opened.traced.events,
    )
    expect(findings.attendance).toMatchObject({ read: false })
    // A skip must be visible as a skip, naming the count and the override.
    expect(findings.attendance?.skippedReason).toContain('--attendance=always')
    // And it must be a REAL skip: no attendance request of either shape may
    // have reached the wire. findings.attendance.read being false only shows
    // what the caller was TOLD -- this is what actually happened on the
    // socket.
    expect(running.received.some(requestsAttendance)).toBe(false)
  })

  it('reads anyway when attendance is forced', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1000, rawHex: '',
    }
    await probeBulk(
      session, new StepRunner(), findings, { transport: 'tcp', attendance: 'always' }, opened.traced.events,
    )
    expect(findings.attendance?.read).toBe(true)
    // The force override must genuinely reach the wire, mirroring the skip
    // assertion above.
    expect(running.received.some(requestsAttendance)).toBe(true)
  })

  it('keeps no user names or ids in findings', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, 'EMP-9931', 'Zaphod')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    const runner = new StepRunner()
    await probeBulk(
      session, runner, findings, { transport: 'tcp', attendance: 'auto' }, opened.traced.events,
    )
    const serialisedFindings = JSON.stringify(findings)
    expect(serialisedFindings).not.toContain('Zaphod')
    expect(serialisedFindings).not.toContain('EMP-9931')
    // Task 4's leak reached the report through StepResult.value rather than
    // `findings` -- a `runner.run` callback's return flows into
    // `runner.steps` independently of `findings`, and a redaction test that
    // only inspects `findings` would miss it. Assert against a serialisation
    // of the steps too.
    const serialisedSteps = JSON.stringify(runner.steps)
    expect(serialisedSteps).not.toContain('Zaphod')
    expect(serialisedSteps).not.toContain('EMP-9931')
  })
})
