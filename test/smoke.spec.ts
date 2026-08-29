import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('toolchain', () => {
  it('runs tests and resolves source imports', () => {
    expect(VERSION).toBe('0.2.0')
  })

  it('exports exactly the public surface v0.2 promises', async () => {
    const api = await import('../src/index.js')
    expect(Object.keys(api).sort()).toEqual([
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
