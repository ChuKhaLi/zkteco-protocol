import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('toolchain', () => {
  it('runs tests and resolves source imports', () => {
    expect(VERSION).toBe('0.4.3')
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

  it('runs its main entry when the bin is reached through a link, not only by its real path', async () => {
    // npm links a bin as a symlink on POSIX -- node_modules/.bin/zkteco-protocol
    // points at dist/cli.js. Node resolves that link for import.meta.url but
    // leaves process.argv[1] as the path actually invoked, so a main-module
    // guard comparing the two unresolved goes false and the process exits 0
    // having done nothing at all: no report, no message, no failure. On Windows
    // npm writes a .cmd shim naming the real path instead, which is why this
    // shipped green here and did nothing for every other consumer.
    //
    // A directory link, because Windows grants one without privileges, and it
    // reproduces the same divergence: the entry is reached by a path that is
    // not its realpath.
    const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, resolve } = await import('node:path')
    const { spawnSync } = await import('node:child_process')

    const dir = mkdtempSync(join(tmpdir(), 'zk-bin-'))
    try {
      symlinkSync(resolve('dist'), join(dir, 'dist'), 'junction')
      const run = (entry: string) => spawnSync(process.execPath, [entry], { encoding: 'utf8' })

      // The positive control. Without it, a CLI that had stopped refusing a
      // missing host would satisfy the assertion below just as well by being
      // silent in both directions.
      const direct = run(resolve('dist/cli.js'))
      expect(direct.stderr).toContain('a host is required')
      expect(direct.status).toBe(1)

      const throughLink = run(join(dir, 'dist', 'cli.js'))
      expect(throughLink.stderr).toContain('a host is required')
      expect(throughLink.status).toBe(1)

      // --preserve-symlinks-main inverts which of the two paths is the resolved
      // one: Node keeps the link in import.meta.url, so it is now the realpath
      // that differs. Both forms have to be accepted or the fix above merely
      // moves the silent exit 0 to whoever sets that flag.
      const preserved = spawnSync(
        process.execPath,
        ['--preserve-symlinks-main', join(dir, 'dist', 'cli.js')],
        { encoding: 'utf8' },
      )
      expect(preserved.stderr).toContain('a host is required')
      expect(preserved.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
