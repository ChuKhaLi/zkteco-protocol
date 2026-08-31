import { describe, expect, it } from 'vitest'
import {
  ZkAuthError, ZkConnectionError, ZkError, ZkFramingError, ZkProtocolError, ZkTimeoutError,
} from '../../src/errors.js'
import { StepRunner, classifyError, refused, stopsTheRun } from '../../src/diagnostics/step.js'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

describe('classifyError', () => {
  it('maps each error class to its outcome', () => {
    expect(classifyError(new ZkAuthError('x'))).toBe('unauthorized')
    expect(classifyError(new ZkTimeoutError('x'))).toBe('silent')
    expect(classifyError(new ZkConnectionError('x'))).toBe('dropped')
    expect(classifyError(new ZkProtocolError('x'))).toBe('malformed')
    expect(classifyError(new ZkFramingError('x'))).toBe('malformed')
    expect(classifyError(new Error('x'))).toBe('malformed')
  })

  it('keeps the ZkError base class in the fallthrough, where a catch-all would swallow its subclasses', () => {
    // The old name here claimed an ordering between ZkAuthError and
    // ZkProtocolError was load-bearing. It is not: they are mutually exclusive
    // siblings, and ZkProtocolError has no branch at all. What IS load-bearing
    // is that no `err instanceof ZkError` branch precedes the three specific
    // ones -- ZkError is their base, so a catch-all placed first would report
    // every unauthorized device, every timeout and every dropped connection as
    // 'malformed', answering three checklist items with the wrong evidence.
    expect(classifyError(new ZkError('bare base class'))).toBe('malformed')
    for (const err of [new ZkAuthError('x'), new ZkTimeoutError('x'), new ZkConnectionError('x')]) {
      expect(classifyError(err)).not.toBe('malformed')
    }
  })
})

describe('stopsTheRun', () => {
  it('continues whenever the device answered, and stops when it did not', () => {
    expect(stopsTheRun('ok')).toBe(false)
    expect(stopsTheRun('refused')).toBe(false)
    expect(stopsTheRun('unauthorized')).toBe(false)
    expect(stopsTheRun('malformed')).toBe(false)
    expect(stopsTheRun('silent')).toBe(true)
    expect(stopsTheRun('dropped')).toBe(true)
  })
})

describe('StepRunner', () => {
  it('records a value and keeps going', async () => {
    const runner = new StepRunner()
    const value = await runner.run('first', async () => 42)
    expect(value).toBe(42)
    expect(runner.steps[0]).toMatchObject({ name: 'first', outcome: 'ok' })
    expect(runner.truncated).toBeNull()
  })

  it('keeps running after a malformed answer, and records it as malformed', async () => {
    // Named for what it exercises. Under its old name ("a step the device
    // answered with a refusal") a reader grepping for refusal coverage found
    // this test, which throws ZkProtocolError and asserts 'malformed' --
    // 'refused' became a real, distinct outcome in R7 and has its own test
    // below.
    const runner = new StepRunner()
    await runner.run('bad', async () => { throw new ZkProtocolError('nope') })
    const after = await runner.run('good', async () => 7)
    expect(after).toBe(7)
    expect(runner.steps.map((s) => s.outcome)).toEqual(['malformed', 'ok'])
    expect(runner.truncated).toBeNull()
  })

  it('stops the run at a timeout and refuses to execute later steps', async () => {
    // Item 22: a late reply is collected by the NEXT request, so anything
    // after a timeout would be a real answer attributed to the wrong question.
    const runner = new StepRunner()
    await runner.run('quiet', async () => { throw new ZkTimeoutError('no reply within 60ms') })
    let ran = false
    const after = await runner.run('never', async () => { ran = true; return 1 })
    expect(ran).toBe(false)
    expect(after).toBeUndefined()
    expect(runner.truncated).toEqual({ after: 'quiet', reason: 'silent' })
    expect(runner.steps).toHaveLength(1)
  })

  it('keeps a byte count for the raw bytes an error already carries', async () => {
    const runner = new StepRunner()
    await runner.run('framed', async () => {
      throw new ZkProtocolError('TCP start marker mismatch', Buffer.from([1, 2, 3]))
    })
    expect(runner.steps[0]?.rawByteLength).toBe(3)
  })

  it('never lets the raw hex itself reach StepResult, or a serialisation of it', async () => {
    // The regression this guards: StepResult used to copy err.raw's hex
    // verbatim, and ZkError.raw can be an arbitrary slice of a device reply
    // (a mismatched parameter echo, or a slice of real user/attendance record
    // bytes out of parseUserData/parseAttendanceData) that never passed
    // through Findings and so was never redacted. renderJson mirrors `steps`
    // unmodified, so any hex that lands here reaches the shareable sidecar.
    const runner = new StepRunner()
    const secretBytes = Buffer.from('~SerialNumber=SN-42', 'latin1')
    await runner.run('framed', async () => {
      throw new ZkProtocolError('echo mismatch', secretBytes)
    })
    const step = runner.steps[0]!
    expect(step).not.toHaveProperty('raw')
    expect(step.rawByteLength).toBe(secretBytes.length)
    expect(JSON.stringify(runner.steps)).not.toContain(secretBytes.toString('hex'))
    expect(JSON.stringify(runner.steps)).not.toContain('SN-42')
  })

  it("records 'refused', not 'ok', when a callback reports refused(value)", async () => {
    const runner = new StepRunner()
    const value = await runner.run('param:~Foo', async () => refused(null))
    expect(value).toBeNull()
    expect(runner.steps[0]).toMatchObject({ name: 'param:~Foo', outcome: 'refused', value: null })
    expect(runner.truncated).toBeNull()
  })
})

/**
 * Design spec 5.1 asks for "per-step outcomes (command, ack code, body
 * length)". Only the body length was ever there: StepResult did not carry the
 * other two, they live on TraceEvent, and TraceEvent reaches only the opt-in
 * raw capture. The comment in formatStepTable named that gap rather than
 * citing the requirement as met -- this closes it.
 *
 * Numbers only, never bytes. A command and an ack code carry no identity, so
 * this adds nothing to the redaction surface the report has to defend.
 */
describe('StepRunner with a trace', () => {
  /** Mirrors what TracingTransport.record produces for a decodable payload. */
  function traced(): { events: TraceEvent[]; exchange: (command: number, ack: number) => void } {
    const events: TraceEvent[] = []
    const record = (direction: TraceEvent['direction'], command: number): void => {
      const payload = encodePayload({ command, sessionId: 1, replyId: events.length })
      events.push({
        seq: events.length,
        direction,
        offsetMs: 0,
        hex: payload.toString('hex'),
        command,
        sessionId: 1,
        replyId: events.length,
      })
    }
    return {
      events,
      exchange: (command, ack) => { record('send', command); record('recv', ack) },
    }
  }

  it('records the command a step sent and the code the device answered', async () => {
    const t = traced()
    const runner = new StepRunner(() => t.events)
    await runner.run('firmware', async () => { t.exchange(CMD.GET_VERSION, CMD.ACK_OK); return 'x' })

    expect(runner.steps[0]).toMatchObject({
      name: 'firmware', outcome: 'ok', command: CMD.GET_VERSION, ackCode: CMD.ACK_OK, exchanges: 1,
    })
  })

  it('reports the FIRST command of a multi-exchange step, and how many there were', async () => {
    // readBulk's buffered path is PREPARE_BUFFER, READ_BUFFER, FREE_DATA in
    // one step. Printing the last command would name the cleanup; printing
    // one command with no count would read as a single round trip.
    const t = traced()
    const runner = new StepRunner(() => t.events)
    await runner.run('users', async () => {
      t.exchange(CMD.PREPARE_BUFFER, CMD.ACK_OK)
      t.exchange(CMD.READ_BUFFER, CMD.ACK_OK)
      t.exchange(CMD.FREE_DATA, CMD.ACK_ERROR)
      return []
    })

    expect(runner.steps[0]).toMatchObject({
      command: CMD.PREPARE_BUFFER, ackCode: CMD.ACK_OK, exchanges: 3,
    })
  })

  it('attributes only the events a step produced, not the ones before it', async () => {
    const t = traced()
    const runner = new StepRunner(() => t.events)
    await runner.run('firmware', async () => { t.exchange(CMD.GET_VERSION, CMD.ACK_OK); return 'x' })
    await runner.run('clock', async () => { t.exchange(CMD.GET_TIME, CMD.ACK_UNAUTH); return 'y' })

    expect(runner.steps[1]).toMatchObject({
      command: CMD.GET_TIME, ackCode: CMD.ACK_UNAUTH, exchanges: 1,
    })
  })

  it('leaves the fields absent for a step that reached no wire at all', async () => {
    // Absent, not zero: 0 is a command number, and a reader cannot tell a
    // fabricated one from a real one.
    const t = traced()
    const runner = new StepRunner(() => t.events)
    await runner.run('skipped', async () => 'nothing sent')

    const step = runner.steps[0]!
    expect(step.command).toBeUndefined()
    expect(step.ackCode).toBeUndefined()
    expect(step.exchanges).toBeUndefined()
  })

  it('records the command even when the step then threw', async () => {
    // The failing step is the one a reader most needs the command for.
    const t = traced()
    const runner = new StepRunner(() => t.events)
    await runner.run('clock', async () => {
      t.exchange(CMD.GET_TIME, CMD.ACK_ERROR)
      throw new ZkProtocolError('device rejected command 201')
    })

    expect(runner.steps[0]).toMatchObject({
      outcome: 'malformed', command: CMD.GET_TIME, ackCode: CMD.ACK_ERROR,
    })
  })

  it('works with no trace supplied, leaving the fields absent', async () => {
    // Every existing caller constructs StepRunner with no arguments.
    const runner = new StepRunner()
    await runner.run('firmware', async () => 'x')

    expect(runner.steps[0]).toMatchObject({ name: 'firmware', outcome: 'ok' })
    expect(runner.steps[0]!.command).toBeUndefined()
  })
})
