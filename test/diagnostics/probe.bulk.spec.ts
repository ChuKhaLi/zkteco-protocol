import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import {
  ATTENDANCE_AUTO_THRESHOLD, emptyFindings, encodingVerdict, probeBulk,
} from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'
import type { DecodedPacket } from '../../src/codec/packet.js'

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

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 2000 })
  await s.open()
  return s
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

describe('probeBulk', () => {
  it('reads users and reports which bulk path the firmware took', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' })
    expect(findings.bulkPath).toBe('buffered')
    expect(findings.attendance).toMatchObject({ read: true, detectedRecordSize: 40 })
  })

  it('skips the attendance read above the threshold and says why', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1_000_000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1_000_000, rawHex: '',
    }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' })
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
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1000, rawHex: '',
    }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'always' })
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
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    const runner = new StepRunner()
    await probeBulk(session, runner, findings, { transport: 'tcp', attendance: 'auto' })
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
