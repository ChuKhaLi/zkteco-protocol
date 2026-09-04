import { describe, expect, it } from 'vitest'
import { consumerSource, consumerTsconfig } from '../../.claude/skills/release-drill/scripts/consumer-fixture.mjs'

/**
 * The drill compiles this consumer against the packed tarball. The file is
 * pinned here because its two properties are the whole point of the check and
 * are invisible in the drill's output: it must import the package the way a
 * CommonJS consumer does, and it must be compiled under module: node16, which
 * is the resolution mode that produced TS1479 against a single `types`
 * condition.
 */
describe('the drill consumer fixture', () => {
  it('imports the published entry point and uses a published type', () => {
    const src = consumerSource()
    expect(src).toContain("from 'zkteco-protocol'")
    expect(src).toContain('ZkDevice')
    expect(src).toContain('ZkAttendanceLog')
  })

  it('is not an ES module, so require-condition resolution is what gets tested', () => {
    const cfg = JSON.parse(consumerTsconfig('C:/repo'))
    expect(cfg.compilerOptions.module).toBe('node16')
    expect(cfg.compilerOptions.moduleResolution).toBe('node16')
    expect(cfg.compilerOptions.noEmit).toBe(true)
    expect(cfg.compilerOptions.strict).toBe(true)
  })

  it('points at the repository types rather than expecting a network install', () => {
    const cfg = JSON.parse(consumerTsconfig('C:/repo'))
    expect(cfg.compilerOptions.typeRoots).toEqual(['C:/repo/node_modules/@types'])
    expect(cfg.compilerOptions.types).toEqual(['node'])
  })
})
