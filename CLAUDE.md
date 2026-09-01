# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm build        # tsup -> dist/ (ESM + CJS + d.ts)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm test:watch
```

**Run `pnpm build` before `pnpm test`.** `test/smoke.spec.ts` reads `dist/index.js` to assert the
diagnostics and CLI code stayed out of the library bundle. With no `dist/` it fails with ENOENT;
with a stale one it passes against a bundle that no longer matches `src/`. CI runs build first for
this reason — that ordering is load-bearing, not cosmetic.

Single file or single test:

```bash
npx vitest run test/session/subscribe.spec.ts
npx vitest run -t 'refuses a request after an ordinary close'
```

Tests bind real localhost sockets against the emulator in `test/emulator/`, and most suites run
every scenario over both TCP and UDP. There is no internal mocking; a stub transport appears only
where the point is that the transport must *not* be what refuses (`test/session/session.spec.ts`).

## Before any release

Run the packed-tarball drill. Every other check runs the CLI from source, sharing `node_modules`,
`tsconfig` and build output; a published consumer has none of those, and a broken CJS build once
silently dropped `dist/index.cjs` with no test failing.

```bash
pnpm build && npm pack --pack-destination <tmp>
cd <tmp>/consumer && npm install <tmp>/zkteco-protocol-<v>.tgz    # expect 1 package, 0 transitive
npx tsx tools/emulator-serve.ts <port-file>                        # from the repo, in another shell
npx zkteco-protocol 127.0.0.1 --port <port> --out <tmp>/report.md  # the INSTALLED cli
```

Then check the report: the emulator's serial appears zero times while `MB360` appears twice (so the
absence is meaningful, not vacuous), and item 1 names `--raw-capture` as the remedy.

`package.json`'s `version` and `src/index.ts`'s `VERSION` must be bumped together; `test/smoke.spec.ts`
asserts they agree.

That drill is scripted: `pnpm release:drill` runs all eleven checks and exits 1 with a named temp
directory on failure. It also runs in CI on every tag, which is the only reason it has ever run on
Linux.

**The package is published, and releases go through the tag — never by hand.** Bump `version` and
`VERSION` together, push `v<version>`, approve the `npm-publish` environment; the pipeline publishes
with provenance and creates the GitHub Release. `docs/RELEASING.md` is the procedure, and its §5
lists what the pipeline does *not* prove. 0.4.2 is the only version without a provenance
attestation, because npm cannot configure a trusted publisher for a package that does not yet exist.

## Architecture

Four layers, each unaware of the one above it:

- **`src/codec/`** — pure encode/decode. Payload framing, checksum, comm-key mixing, command
  numbers, and the record parsers (`records/user.ts`, `records/attendance.ts`). No I/O.
- **`src/transport/`** — the only thing that touches a socket. `Transport` hides the two real
  differences between TCP and UDP: the 8-byte length-prefixed header, and how bytes arrive. At most
  one `receive()` may be outstanding. `listen()` is **one-way, once per socket** — that single
  irreversible transition is why a subscribed device cannot also be polled.
- **`src/session/`** — one request-response conversation: session-id acquisition, reply-id
  sequencing, per-request deadlines. `execute()` throws on ACK_ERROR and ACK_UNAUTH; `tryExecute()`
  returns them for call sites where a refusal is a normal answer. `dataRead.ts` holds `readBulk`,
  which tries the buffered path (PREPARE_BUFFER / READ_BUFFER / FREE_DATA) and falls back to the
  legacy exchange on exactly `ZkProtocolError`.
- **`src/commands/` + `src/ZkDevice.ts`** — the public facade. `src/index.ts` is the entire
  published surface; `test/smoke.spec.ts` pins it.

`src/realtime/Subscription.ts` sits beside the session and owns the event stream's lifetime.

**`src/diagnostics/` and `src/cli.ts` are a separate product**, not part of the library. The bring-up
kit walks the first-hardware checklist and emits a shareable Markdown report plus a JSON sidecar.
`TracingTransport` is a decorator over `Transport` that records every payload; `StepRunner` isolates
each probe step and attributes the trace span it produced. **`src/cli.ts` is the only impure module**
— it alone reads the clock, the filesystem, and argv, and `test/diagnostics/invariants.spec.ts`
enforces that.

`test/oracle/` and `tools/oracle/` are the evidence layer: captures from two independent
implementations, used to adjudicate protocol questions neither documentation nor this library can
settle alone.

## Rules that override normal judgment

These are project decisions with reasons recorded; do not relax them without reading the reason.

- **No runtime dependencies.** `node:net` and `node:dgram` only, never a native module.
- **Never return a `Date`.** Devices record wall-clock time with no zone; `ZkNaiveTime` keeps it
  naive rather than binding it to whatever timezone the process happens to run in.
- **Never fabricate an identity.** An unresolvable user id is `null`, and every attendance record
  carries `userIdSource` saying where its identity came from.
- **Refuse rather than guess.** Data failing a framing check throws; it is never parsed into
  plausible-looking garbage.
- **Do not read `pyzk` source. It is GPL-2.0.** Running it as a black box is fine and
  `tools/oracle/.venv/` exists for exactly that. `adrobinoga/zk-protocol` carries no license — read
  for understanding, restate in our own words. `zkteco-js` is MIT.
- **No write paths.** Not access control, not clock-setting, not user writes. The diagnostic probe
  enforces this mechanically with a command allowlist that names `ENABLEDEVICE`/`DISABLEDEVICE` as
  forbidden — disabling a device locks employees out of badging every poll cycle.
- **Do not add first-hardware checklist items.** The twenty-three existing ones are the backlog.
- **Redaction happens at the source, never in a renderer.** `Findings` is redacted where it is
  produced, so the renderers can trust it. Booleans and counts travel; device bytes and secrets do
  not. The unredacted bytes belong in the opt-in raw capture.

## The defect shape this project keeps catching

**Code, a test, or a comment that reports success while proving less than it appears to.** It has
been found at least 32 times across v0.1–v0.4.3 (9, 5, 6, 9, 3), and in three of those cycles every
instance originated in the plan rather than in an implementer. The v0.4.3 three are the worst so
far, because one of them was in the shipped product: the CLI exited 0 having done nothing at all on
every platform but Windows. Concretely, when working here:

- Check that a failing test fails for the *reason intended*. A prescribed mutation that never
  reaches its assertion turns a test red while proving nothing.
- A fix needs a test in **both** directions. A single test fixes one direction and ships the other.
- Distinguish "no evidence either way" from "evidence of absence" — `validUtf8: null` is not
  `false`, and `'ambiguous'` is not `'neither'`.
- A flag is not evidence that the thing it enables happened. `--comm-key` against a device that
  never demands one exercises the mixing zero times.
- **A check that has only ever run in one environment has established something about that
  environment and nothing else.** Every green run of the packed-tarball drill before 2026-09-01 was
  a fact about Windows. The first time it ran on Linux — because the release pipeline put it in CI —
  it found a CLI that had never worked there and would have been published that way.
- When you fix a recorded defect, delete its entry rather than rewriting it into its aftermath.

## Docs

`docs/superpowers/specs/` holds the binding design authority — the v0.1 spec's §12 is the
twenty-three-item first-hardware checklist. `docs/superpowers/plans/` holds one handoff per release
cycle; the newest continues the others rather than superseding them. `PROVENANCE.md` records which
protocol claims rest on byte-level evidence, which on source reading, and which on nothing yet —
update it when the answer to any of those changes.

**No physical ZKTeco device has ever been tested against this library.** Every byte layout is a
hypothesis. Keep the README's compatibility table honest.
