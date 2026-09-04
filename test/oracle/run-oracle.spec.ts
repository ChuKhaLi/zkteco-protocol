import { describe, expect, it } from 'vitest'
import { describeFailure, run, succeeded } from '../../tools/oracle/run-oracle.js'

describe('run', () => {
  it('reports a clean exit', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("fine")'])
    expect(r).toMatchObject({ spawned: true, code: 0 })
    expect(succeeded(r)).toBe(true)
  })

  it('reports a non-zero exit and keeps the last stderr line', async () => {
    // The defect: capture.ts resolved on close regardless of the code, so a
    // driver that raised after CMD_CONNECT still had its partial packet list
    // written into test/fixtures/oracle/ and announced as written.
    //
    // process.exit() immediately after an async stderr write can truncate the
    // pipe before the parent reads it (task 12 hit this in the drill), so the
    // stub writes synchronously via fs.writeSync(2, ...) instead of
    // process.stderr.write before exiting.
    const r = await run(process.execPath, [
      '-e', "require('node:fs').writeSync(2, 'pyzk stopped: boom\\n'); process.exit(2)",
    ])
    expect(r).toMatchObject({ spawned: true, code: 2 })
    expect(succeeded(r)).toBe(false)
    expect(r.stderrTail).toContain('pyzk stopped: boom')
  })

  it('reports a spawn failure as not spawned', async () => {
    const r = await run('definitely-not-a-real-binary-zzz', [])
    expect(r.spawned).toBe(false)
    expect(succeeded(r)).toBe(false)
  })

  it('names the script and what happened', () => {
    expect(describeFailure('tools/oracle/capture_pyzk.py', { spawned: true, code: 2, stderrTail: 'boom' }))
      .toMatch(/capture_pyzk\.py.*exit 2.*boom/)
  })
})
