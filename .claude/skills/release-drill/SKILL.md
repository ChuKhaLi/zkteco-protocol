---
name: release-drill
description: Verify zkteco-protocol against a packed tarball by installing it into a clean directory and driving the INSTALLED cli against the emulator. Use this before any release, version bump, publish, or npm pack — and any time work touches src/cli.ts, src/diagnostics/, tsup.config.ts, the package.json bin/exports/files fields, or the redaction rules. Also use it when asked whether a change is safe to ship, whether the package works for a consumer, or why something works locally but not when installed. The test suite structurally cannot answer these questions, so do not treat a green `pnpm test` as a substitute.
---

# Release drill

## Why this exists

Every check in this repository runs the cli from source, inside the repo, sharing its
`node_modules`, its `tsconfig` and its build output. **A published consumer has none of those.**
Nothing in `pnpm test` can tell you whether `npx zkteco-protocol <host>` — the command the README
gives as its first instruction — works for a stranger who ran `npm install`.

That gap is not theoretical. During the v0.4 cycle a top-level `await main()` made the CJS build
fail and silently drop `dist/index.cjs`, the package's own `main` entry. Nothing went red. The
package was broken for every CommonJS consumer and the whole suite passed.

## Running it

From the repository root:

```bash
node .claude/skills/release-drill/scripts/drill.mjs
```

It builds, packs, installs the tarball into a fresh temp directory that shares nothing with this
repo, starts `tools/emulator-serve.ts`, drives the **installed** cli against it twice, and checks
eleven things. Exit 0 means all of them passed; exit 1 prints which failed and leaves the artifacts
in a temp directory named in the output. Set `KEEP_DRILL_ARTIFACTS=1` to keep them on success too,
which is what you want when a check fails in a way the summary line does not explain.

Takes about a minute, most of it the build and the install.

## What it checks, and why each one is there

**The package as an artifact.** That `dist/index.cjs` exists after the build, and that installing
the tarball pulls exactly one package with zero transitive dependencies. The second is the
zero-runtime-dependencies rule observed from outside, rather than asserted from the
`package.json` this repo controls.

**The default run.** Exit 0, a Markdown report and a JSON sidecar written, and item 1 reading
"not answered" while naming `--raw-capture` as the remedy — it once claimed "see the accompanying
raw capture" on a run that wrote no such file.

**Redaction, in both directions.** The emulator's serial must appear in neither artifact, and
`MB360` must appear in the Markdown. The second is not decoration: it is the positive control. A
renderer that wrote an empty file would satisfy every absence check just as well, and "contains no
secrets" is worth nothing until you know the file contains anything at all.

**The `--raw-capture` run.** Item 1 flips to "answered" and names the real file, the Markdown still
hides the serial — and the capture itself **does** contain the serial's bytes. That last one looks
backwards and is deliberate. The capture is unredacted by design; that is why it is opt-in and
carries a header saying it holds the comm key and employee data. Checking only that the report
hides things would leave the capture free to quietly stop capturing.

## Interpreting a failure

Read which check failed before changing anything — they fail for quite different reasons.

- **`dist/index.cjs` missing** — the CJS pass of the build failed. Look for syntax that is legal ESM
  and illegal CJS; top-level `await` is the one that has actually happened here. `pnpm test` will
  not reproduce this.
- **More than 1 package installed** — a runtime dependency crept into `package.json`. This library
  ships `node:net` and `node:dgram` and nothing else.
- **A redaction check failed** — a device value reached an artifact it must never reach. Fix it
  **at the source**, in the code that produced the value, never in the renderer. A renderer that
  strips secrets is one edit away from leaking them and implies `Findings` cannot be trusted on its
  own. Three leaks were closed this way in v0.4, each by making the rule uniform rather than
  special-casing the key that leaked.
- **The positive control failed while the absence checks passed** — treat this as the most serious
  result, not the mildest. The artifacts are empty or the renderer is broken, and every other check
  in that run just passed vacuously.
- **Item 1 wrong in either direction** — the checklist row is claiming evidence the run did not
  produce, or failing to claim evidence it did. Both are the defect shape this project keeps
  catching; `src/diagnostics/report.ts` is where the row is decided.

## Keeping the drill honest

The script hardcodes `SN-PACKTEST-001` and `MB360` to match `tools/emulator-serve.ts`. If those
values change there and not here, the redaction checks go vacuous — they would be searching for a
string the device never sends, and would pass forever. **Change both together.**

To confirm the drill can still fail, point `SERIAL` at a value the report legitimately does contain
(`MB360` works) and run it: the three redaction checks should go red and the script should exit 1.
A check that cannot fail is worse than no check, because it reports safety it never established.
