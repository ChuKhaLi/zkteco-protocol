import { defineConfig } from 'tsup'

// Two entries with different formats. The library ships ESM and CommonJS
// with a declaration for each; the CLI ships ESM only — `bin` points at
// dist/cli.js, and a CommonJS bundle of it could never run (its import.meta
// is shimmed to {}, so the main-module check is always false). `clean` is
// off here and done by the build script: with an array of configs tsup may
// run them concurrently, and one config's clean would race the other's
// output.
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, target: 'node20', sourcemap: true, clean: false },
  { entry: ['src/cli.ts'], format: ['esm'], dts: false, target: 'node20', sourcemap: true, clean: false },
])
