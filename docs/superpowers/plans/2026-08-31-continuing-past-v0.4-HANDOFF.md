# Handoff — continuing `zkteco-protocol` past v0.4

**Date:** 2026-08-31
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** v0.4.1. 570 tests, 1 skipped. Zero runtime dependencies.
**Updated 2026-08-31 (later the same day), for v0.4.1:** §3, §4.3, §5, §7 and §8 were rewritten.
Everything else describes v0.4.0 and is unchanged, and still accurate.
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

**Re-run for v0.4.1**, same result on every check above, plus the two the release added: item 2's
comm-key row renders the no-key sentence, and the step table's new columns are populated —
`keyword-shape-ab` as `11 x2` and `users` as `1503 x3`, which is the request-shape A/B and the
buffered read counted correctly. **Run it again for every release.** It is the only check in this
repository that exercises what a stranger actually installs.

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

### 4.3 What v0.4.1 added to this, which is about §5 rather than about code

v0.4.1 fixed five of the six items §5 carried. The lesson is not in any of the five. It is that
**§5's own one-line summaries undersold what was in them, and the summaries were written by the
people who had just decided not to fix them.** That is this document's defect shape — a record that
reports less trouble than it holds — occurring in the register of known defects.

Two of the six were not what they said:

- **Item 4 read as a doc inaccuracy and was a live bug.** "The desync teardown's guarantee is
  enforced one layer below where its JSDoc states it" sounds like a comment pointing at the wrong
  file. What it actually meant: nothing on the request path read `open_`, so a session torn down for
  desync *resolved* the next `execute()` with the stranded ACK_OK — the precise off-by-one the
  teardown exists to prevent. Every real transport masked it by having a dead socket, and the
  existing test asserted `ZkConnectionError`, which the dead socket supplies. The test would have
  passed with nothing in this library refusing at all.
- **Item 3 outlived its own resolution.** The v0.2 and v0.3 handoffs listed a real defect: "a
  recorded UDP transport failure is sticky and never cleared". v0.3.2 fixed it. What v0.4's §5 then
  carried forward was the residue — TCP's stickiness, which is not a defect at all but the argued
  counterpart of that fix, spelled out on `TcpTransport.fail` in a docblock ending "the difference is
  a considered one, not drift". The entry survived the thing it described, shed the word "defect"
  nowhere, and cost every later reader the time to work out that there was nothing to do.

**So: when you accept an item instead of fixing it, write down what it costs if you are wrong — and
when you fix one, delete it rather than rewriting it into its own aftermath.** "Accepted rather than
fixed. None blocks anything" was true of four items, false of item 4, and inapplicable to item 3,
and nothing in the wording distinguished the three cases.

One trap from the fixes worth keeping, because it will recur wherever argv meets the wire:
**a flag is not evidence that the thing it enables happened.** `Session.open` sends CMD_AUTH only
when the device answers CONNECT with ACK_UNAUTH, so `--comm-key` against a device that never demands
one exercises `mixCommKey` zero times — and the operator who passed the flag is the likeliest reader
of all to assume it was checked. Item 2's comm-key verdict is read off the trace for that reason,
with `configured` taken from argv only because the wire cannot show it.

Also worth knowing: the cycle's tests were written first and each red was checked for the *reason*
it was red, per §4's standing instruction. That is how item 4's live bug surfaced — the fix was
scoped as a docblock edit until a transport that answers everything showed `execute()` resolving.

---

## 5. Outstanding items — cleared in v0.4.1

All six were accepted rather than fixed at v0.4.0. Five are now fixed; the sixth was never a
defect. **None of them was the reason to pick this repository up — §7 still is.**

1. **Fixed.** `classifyChecksum` tested the arithmetical tie before comparing anything to the
   transmitted checksum, so a `replyId === 0` packet matching NEITHER hypothesis came back
   `'ambiguous'` — the class the adjudication drops as uninformative — instead of `'neither'`, the
   class that means investigate. A corrupt capture was reported as a benign one, and dropped in
   silence. Carried from v0.3.
2. **Fixed.** The oracle guard was `discriminatingPackets === 14`, and a fixture whose packets all
   carry `replyId === 0` moves that number by zero. `fixtureInventory()` now pins fixtures, packets,
   ambiguous and discriminating together, plus the exact filename list — `readdirSync` is not
   recursive, so a fixture moved up out of `commkey/`, `params/` or `realtime/` was being adjudicated
   as handshake evidence with nothing to notice. Carried from v0.1.
3. **Not a defect. Ruled, not fixed.** The recorded UDP transport failure was fixed in v0.3.2 and
   TCP's remains sticky. That asymmetry is argued in full on `TcpTransport.fail` — a TCP connection
   really is gone, a UDP socket has no connection to lose — and the docblock already ends "the
   difference is a considered one, not drift". There was nothing to do. **Stop carrying it as an
   outstanding item.**
4. **Fixed.** `subscribe`'s docblock said a desynced session "cannot be polled afterwards", and
   nothing on the request path read `open_`; the refusal came from the destroyed socket, one layer
   down. Untestable as written, too — against a real transport a refusal from the session and one
   from a dead socket are both `ZkConnectionError`. Driven against a transport that answers
   everything and never fails, the old code *resolved* `execute()` with the stranded ACK_OK: the
   exact off-by-one the teardown exists to prevent. `Session.assertOpen` now guards `tryExecute` and
   `receiveMore` (not the private `send` — `close()` clears the flag before sending its goodbye, and
   on UDP that goodbye is the only thing releasing the device's session slot). Carried from v0.2.
5. **Fixed.** Item 2's comm-key third has a verdict, read off the trace. The trap worth remembering:
   **the flag is not the answer.** `Session.open` sends CMD_AUTH only when the device answers CONNECT
   with ACK_UNAUTH, so `--comm-key` against a device that never demands one exercises `mixCommKey`
   zero times — and that operator is the likeliest reader of all to assume it was checked. Four
   states, each rendering differently; booleans only, the key never enters `Findings`.
6. **Fixed.** The step table carries `Command` and `Ack`, attributed from the trace span each step
   produced. First command rather than last (the bulk path ends on FREE_DATA), with an `x3` suffix
   where a step made more than one exchange, because one command with no count reads as one round
   trip. Absent, never `0`, for a step that reached no wire.

**Two things the v0.4.1 pass added that were not on the list.**

- The first test that drives `main()` end to end. Everything else exercises the pure helpers, and
  the invariants suite reassembles the run by hand, so neither would notice `runProbe` dropping an
  audit — `emptyFindings()`'s default would travel to the renderer and read as a legitimate
  "not exercised". Both new findings are wired through it.
- `VERSION` is now pinned to `package.json`'s version. Ruling R3 put both bumps in one task so they
  could not drift and then left the pairing to convention.

**And one decision, still not a task.** Whether to publish to npm is the owner's call, and the name
was still unclaimed as of 2026-08-31. The argument is unchanged and is now slightly stronger: the
README's own instruction is `npx zkteco-protocol <host>`, and that command works for nobody today.

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

**Second: publish, so someone else can.** See the end of §5. The reachable-but-unbuilt read
commands — workcodes, SMS, access-control config — remain the wrong next move: each is built from
documentation nobody has checked against a device, so each grows the published surface *and* the
checklist while confidence stays flat.

**The backlog is no longer a third option, and that is what v0.4.1 changed.** §5 was the only list
of known defects this repository had, and clearing it took one session. Nothing is deferred, nothing
is accepted-but-broken. Whatever you pick up next is a choice between the two above, not a decision
you can postpone by fixing something small first.

**Do not** start access control or write paths. **Do not** add checklist items; the twenty-three
existing ones are the backlog.

---

## 8. Sources

Unchanged. `adrobinoga/zk-protocol` carries no license — read for understanding, restate in our own
words. `zkteco-js` is MIT. **`pyzk` is GPL-2.0: execute it, never read it.** Neither v0.4 nor v0.4.1
added an oracle capture or read a new source.

`PROVENANCE.md` was re-checked against v0.4.1's stricter `classifyChecksum` and needs no change:
the four excluded packets do match the checksum they transmitted, so they stay 'ambiguous' under the
new rule, and the 18 / 14 / 4 split the reply-id adjudication rests on is untouched.

The binding authority for everything v0.4 added is
`docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md`. Read §12 of the v0.1 spec — all
twenty-three items — before trusting any reading from a real device.
