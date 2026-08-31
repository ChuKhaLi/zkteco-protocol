# Handoff — continuing `zkteco-protocol` past v0.4

**Date:** 2026-08-31
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** v0.4.0 merged and pushed. 539 tests, 1 skipped. Zero runtime dependencies.
**Not published to npm.** The name is still unclaimed.

This continues `2026-08-30-continuing-past-v0.3-HANDOFF.md`, which continues two before it. All
remain accurate about everything they describe. Read them — they are extended here, not superseded.

---

## 1. The one fact that should shape what you pick up next

**No physical ZKTeco device has ever been connected to this library.** True at v0.1, true at v0.3,
true today.

What changed in v0.4 is that this is now the *only* thing standing between the project and answers.
Before, the first hour with hardware would have started with Wireshark and hand-correlation.
Now it starts with one command.

**The checklist stands at 23 items.** v0.4 is the first release in this project's history that adds
none. That was the point of the scope: it exists to answer the twenty-three already there.

---

## 2. What v0.4 added

A read-only bring-up kit, published as a CLI entry point:

```
npx zkteco-protocol 192.168.1.201
npx zkteco-protocol 192.168.1.201 --raw-capture trace.jsonl
```

It walks the checklist and emits two artifacts: a shareable Markdown report plus a JSON sidecar, and
an opt-in unredacted raw capture. `src/diagnostics/` holds the tracing decorator, the probe, and the
renderers; `src/cli.ts` is the one impure module and owns the clock, the filesystem, argument
parsing and exit codes.

**The piece that earns the release** is §4.2's request-shape A/B. Checklist item 18 — whether a
device accepts a `CMD_OPTIONS_RRQ` keyword bare or NUL-terminated — is the library's one shipped
protocol guess, chosen between two disagreeing oracles on an argument `PROVENANCE.md` records as
parser speculation. Two extra round trips settle it, across all four outcomes.

### 2.1 The design decision the whole tool rests on

**Two artifacts, because one cannot satisfy both requirements.** Checklist item 2 reconciles a
checksum over exact bytes, so redacting anything inside a payload destroys the evidence being
verified. But the Markdown report is meant to be pasted into a public issue by a stranger who owns a
terminal. So: the report carries structural facts and sanctioned identity values; the capture
carries everything and is opt-in, with a header line saying in words that it holds the comm key and
employee data.

**Redaction is enforced at the source, never in the renderer.** A renderer that stripped secrets
would be one edit from leaking them and would imply `Findings` cannot be trusted. Three leaks were
fixed upstream instead (§4).

### 2.2 Item 20 without shipping employee names

Answering "what encoding does this device use for strings" sounds like it needs the strings. It does
not: UTF-8 has a strict continuation-byte grammar and GB2312 does not, so the bytes are tested and
only a verdict returned. This is possible *only* because v0.3 moved `readNulTerminated` to `latin1`;
under `ascii` the high bit was gone before anyone could look.

`validUtf8: null` means "no evidence either way" and is a different answer from "not UTF-8". Do not
collapse them.

---

## 3. Verified against a packed tarball, not just from source

Before publishing anything, run `tools/emulator-serve.ts` and drive the **installed** CLI against
it. Every other check in this repo runs the CLI from source, sharing node_modules, tsconfig and
build output; a published consumer has none of those.

That gap is not hypothetical — see §4's plan defect 8. Done for v0.4.0 from a clean directory:
install pulls 1 package and 0 transitive dependencies; the default run exits 0 with the serial
appearing zero times in stdout *and* the JSON sidecar while `deviceName` appears twice (so the
absence is meaningful, not vacuous); item 1 reads "not answered" naming `--raw-capture` as the
remedy; and with the flag, item 1 flips to "answered" naming the real file while the serial's hex
*is* present in the capture.

---

## 4. What this cycle actually taught, which is the most useful thing here

The previous handoffs named one defect shape — **code, a test, or a comment that reports success
while proving less than it appears to.** It appeared nine times in v0.1, five in v0.2, six in v0.3.

**In v0.4 it appeared at least nine more times, and every single instance originated in the plan.
Zero originated in an implementer.** Ten implementers transcribed faithfully; what was wrong was
what they were given. This is now the third cycle running with that same asymmetry, and it should
change how you write plans, not how you review implementers.

Worth internalising specifically:

- **A mangled regex.** `/[-ÿ]/` was meant to be the range `U+0080..U+00FF`; as written it matches a
  hyphen or `ÿ`. It would have failed its own task's UTF-8 test. Now written as a code-point check,
  because the class form is what got mangled and an escape sequence can be mangled the same way.
- **A verification step that could not fail.** The plan told an implementer to break the
  checksum-slot zeroing and watch a test go red. It does not go red — `checksum16` already skips
  that word unconditionally. The countermeasure designed to catch the defect shape *was* an instance
  of it.
- **A snippet that broke a published artifact.** A top-level `await main()` made the CJS build fail
  and silently drop `dist/index.cjs`, the package's own `main` entry, with no test failing.
- **A prescribed mutation that never reached its assertion.** Three times. In one, the leak was
  overwritten by a later branch before the assertion ran, so the test went red for the wrong reason
  and proved nothing about the guard. **Always check the mutation reaches the assertion it targets.**

### 4.1 Three data leaks, each through a different channel

None was caught by a test that existed beforehand. All three were found by human-directed review.

1. A device serial reaching the report via a step's return value.
2. An entire user list reaching it the same way.
3. Device bytes reaching it via `ZkError.raw`.

**The rulings that closed them share one shape: uniform beats special case.** The parameter sweep
returns `null` for *every* key, not just the serial. `StepResult` carries a byte count, never hex.
A per-key allowlist would have leaked `~MAC` the moment someone added it; the uniform rule did not.
The final review confirmed this independently across all four channels, including `errorMessage`,
which had never been audited.

### 4.2 Four confidently-wrong findings

Worse than leaks for this tool, because its only product is evidence:

- `bulkPath` hardcoded so it could never report `legacy` — the opposite of the truth on exactly the
  firmware it characterises.
- Item 12 reporting `answered` when the library has **no unsubscribe primitive at all**.
- Item 5's detector matching `ZkFramingError` for a cap that throws `ZkProtocolError` — wrong in
  both directions, and `ZkFramingError` is thrown only in the two record parsers.
- Item 1 claiming "see the accompanying raw capture" on a default run that never writes one.

**Every checklist fix needs a test in both directions.** A single test fixes one direction and ships
the other; that is precisely how `bulkPath` reached review.

---

## 5. Outstanding items

Accepted rather than fixed. None blocks anything.

1. `classifyChecksum` tests `'ambiguous'` before comparing to the transmitted checksum. Carried from
   v0.3.
2. The oracle fixture count guard cannot notice a misfiled fixture whose packets are all
   `replyId === 0`. Carried from v0.1.
3. A recorded UDP transport failure — fixed in v0.3.2; TCP's remains sticky, deliberately.
4. The desync teardown's guarantee is enforced one layer below where its JSDoc states it. Carried
   from v0.2.
5. Item 2's third part — comm-key mixing — is still not audited. The row says so rather than letting
   `answered` cover it.
6. `formatStepTable` does not render command or ack code; those live on `TraceEvent`, not
   `StepResult`. The comment names the gap rather than implying the requirement is met.

**And one decision, not a task.** Whether to publish to npm is the owner's call. The argument for it
is now stronger than vanity: the README's own instruction is `npx zkteco-protocol <host>`, and that
command works for nobody today. A tool built for a stranger who owns a terminal is reachable only by
someone who clones the repo.

---

## 6. What is not implemented

Unchanged from v0.3 except that the bring-up kit now exists. `terminal.md` writes, `data-user.md`
writes, `access.md`, `ex_data.md`, `other.md`, ADMS. Reading biometric templates is read-only but
needs its own privacy design pass.

**The write-path prohibition is unchanged and absolute.** The probe enforces it mechanically: a test
asserts every command it sends is on an allowlist, and names `ENABLEDEVICE`/`DISABLEDEVICE` as
forbidden — v0.1 §6 ruled that disabling the device locks employees out of badging every poll cycle,
and a diagnostic must not quietly reintroduce what the library refuses.

---

## 7. Recommended next scope

**First choice: get a device and run the kit.** This is no longer the same recommendation the last
three handoffs made. It used to mean "start a research project". It now means "run one command and
send back two files". Every item in §4 exists to make that hour productive.

**Second: publish, so someone else can.** See §5. The reachable-but-unbuilt read commands —
workcodes, SMS, access-control config — remain the wrong next move: each is built from documentation
nobody has checked against a device, so each grows the published surface *and* the checklist while
confidence stays flat.

**Do not** start access control or write paths. **Do not** add checklist items; the twenty-three
existing ones are the backlog.

---

## 8. Sources

Unchanged. `adrobinoga/zk-protocol` carries no license — read for understanding, restate in our own
words. `zkteco-js` is MIT. **`pyzk` is GPL-2.0: execute it, never read it.** v0.4 added no oracle
capture and read no new source.

The binding authority for everything v0.4 added is
`docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md`. Read §12 of the v0.1 spec — all
twenty-three items — before trusting any reading from a real device.
