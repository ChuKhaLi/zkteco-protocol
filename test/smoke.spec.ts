import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('toolchain', () => {
  it('runs tests and resolves source imports', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
