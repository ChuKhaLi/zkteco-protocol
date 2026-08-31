import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('toolchain', () => {
  it('runs tests and resolves source imports', () => {
    expect(VERSION).toBe('0.4.1')
  })

  it('reports the same version the package publishes', async () => {
    // The bring-up kit plan's Ruling R3 moved these two bumps into one task
    // precisely so they could not drift, and then left the pairing to a
    // convention: the literal above pins VERSION, and nothing pinned it to
    // package.json. A consumer reads the version off the report this library
    // writes; npm reads it off the manifest. They have to be the same string.
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('keeps diagnostics and CLI code out of the library bundle', async () => {
    const { readFileSync } = await import('node:fs')
    const bundle = readFileSync('dist/index.js', 'utf8')
    expect(bundle).not.toContain('TracingTransport')
    expect(bundle).not.toContain('ATTENDANCE_AUTO_THRESHOLD')
  })

  it('exports exactly the public surface v0.3.2 promises, unchanged since v0.3', async () => {
    const api = await import('../src/index.js')
    expect(Object.keys(api).sort()).toEqual([
      'DEVICE_PARAM',
      'EVENT_FLAG',
      'VERSION',
      'ZkAuthError',
      'ZkConnectionError',
      'ZkDevice',
      'ZkError',
      'ZkFramingError',
      'ZkProtocolError',
      'ZkTimeoutError',
      'decodeZkTime',
      'decodeZkTime6',
    ])
  })
})
