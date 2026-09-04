import { describe, expect, it } from 'vitest'
import { consumerPackageJson, consumerSource, consumerTsconfig } from '../../.claude/skills/release-drill/scripts/consumer-fixture.mjs'

/**
 * The drill compiles this consumer against the packed tarball. The file is
 * pinned here because its two properties are the whole point of the check and
 * are invisible in the drill's output: it must import the package the way a
 * CommonJS consumer does, and it must be compiled under module: node16, which
 * is the resolution mode that produced TS1479 against a single `types`
 * condition.
 *
 * Both properties are pinned, not just the second. The CommonJS-ness is not a
 * tsconfig setting — it is the ABSENCE of `"type": "module"` from the consumer
 * directory's package.json, which used to be a string literal inside drill.mjs
 * that nothing exported and nothing asserted. Adding that one field there
 * would have converted the whole check into an ESM-resolution check with every
 * test still green.
 */
describe('the drill consumer fixture', () => {
  it('imports the published entry point and uses a published type', () => {
    const src = consumerSource()
    expect(src).toContain("from 'zkteco-protocol'")
    expect(src).toContain('ZkDevice')
    expect(src).toContain('ZkAttendanceLog')
  })

  it('declares no module type, so the consumer file really is CommonJS', () => {
    const pkg: Record<string, unknown> = JSON.parse(consumerPackageJson())
    // `toBeUndefined` and not `not.toBe('module')`: `"type": "commonjs"` would
    // pass the looser check while being a claim this fixture does not make,
    // and any future value at all is a change to what the drill exercises.
    expect(pkg.type).toBeUndefined()
    expect(Object.keys(pkg)).not.toContain('type')
    // The positive control on that absence: the object really was parsed and
    // really is the consumer's manifest, so `type` is missing from a file that
    // exists rather than from an empty parse.
    expect(pkg.name).toBe('drill-consumer')
    expect(pkg.private).toBe(true)
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
