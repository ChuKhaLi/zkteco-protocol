/**
 * The CommonJS consumer the drill typechecks against the packed tarball.
 *
 * Kept beside the drill and exported so test/release-drill/consumer-fixture.spec.ts
 * can pin what it contains: the drill prints "ok" for a check whose subject is
 * a file nobody sees, and a consumer that imported nothing would pass it.
 *
 * The failure this exists to catch: a package with `"type": "module"` and a
 * single top-level `types` condition sends a `require()`-style consumer to the
 * ESM declaration, and `tsc` rejects it with TS1479. Nothing in the suite
 * compiles a consumer, so only this runs the resolution a real consumer uses.
 */

/** The consumer's source: one import of the published entry, one typed use. */
export function consumerSource() {
  return [
    "import { ZkDevice } from 'zkteco-protocol'",
    "import type { ZkAttendanceLog } from 'zkteco-protocol'",
    '',
    'export async function poll(host: string): Promise<ZkAttendanceLog[]> {',
    '  const device = new ZkDevice({ host })',
    '  await device.connect()',
    '  try {',
    '    return await device.getAttendanceLogs()',
    '  } finally {',
    '    await device.disconnect()',
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * The consumer's tsconfig.
 *
 * `module`/`moduleResolution` are `node16`: that is the mode TS1479 appears
 * in, and the consumer directory has no `"type": "module"`, so the file is a
 * CommonJS module and resolution takes the `require` condition.
 *
 * `typeRoots` points back at this repository because the consumer directory
 * holds only the tarball — installing `@types/node` there would need the
 * network, and the drill must run offline.
 */
export function consumerTsconfig(repoRoot) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: 'node16',
        moduleResolution: 'node16',
        target: 'ES2022',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        typeRoots: [`${repoRoot}/node_modules/@types`],
        types: ['node'],
      },
      files: ['consumer.ts'],
    },
    null,
    2,
  )}\n`
}
