import { describe, expect, it } from 'vitest'
import {
  ZkAuthError, ZkConnectionError, ZkFramingError, ZkProtocolError, ZkTimeoutError,
} from '../../src/errors.js'
import { StepRunner, classifyError, stopsTheRun } from '../../src/diagnostics/step.js'

describe('classifyError', () => {
  it('maps each error class to its outcome', () => {
    expect(classifyError(new ZkAuthError('x'))).toBe('unauthorized')
    expect(classifyError(new ZkTimeoutError('x'))).toBe('silent')
    expect(classifyError(new ZkConnectionError('x'))).toBe('dropped')
    expect(classifyError(new ZkProtocolError('x'))).toBe('malformed')
    expect(classifyError(new ZkFramingError('x'))).toBe('malformed')
    expect(classifyError(new Error('x'))).toBe('malformed')
  })

  it('classifies ZkAuthError before ZkProtocolError, which are siblings', () => {
    // Both extend ZkError, neither extends the other. An ordering bug here
    // would silently report every unauthorized device as malformed, and the
    // report would answer the wrong checklist item.
    expect(classifyError(new ZkAuthError('unauthorized'))).not.toBe('malformed')
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

  it('keeps running after a step the device answered with a refusal', async () => {
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

  it('keeps the raw hex an error already carries', async () => {
    const runner = new StepRunner()
    await runner.run('framed', async () => {
      throw new ZkProtocolError('TCP start marker mismatch', Buffer.from([1, 2, 3]))
    })
    expect(runner.steps[0]?.raw).toBe('010203')
  })
})
