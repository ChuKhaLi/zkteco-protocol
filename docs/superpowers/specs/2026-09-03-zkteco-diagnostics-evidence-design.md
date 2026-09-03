# Diagnostics evidence — design (v0.5, sub-project B)

**Date:** 2026-09-03
**Status:** approved in brainstorming; implementation plan to follow
**Sibling:** `2026-09-02-zkteco-library-correctness-design.md` (sub-project A, merged into `main` at
30a06d6). That spec deliberately left everything under `src/diagnostics/`, `src/cli.ts`,
`.claude/skills/release-drill/` and `tools/oracle/capture.ts` to this one (its §2.2), and named two
of its own changes the kit now depends on: a framing failure throws `ZkFramingError` (§4.5), and
the bulk reader falls back only on `ACK_ERROR` (§6.2).

---

## 1. Purpose

### 1.1 The problem

The bring-up kit exists to produce evidence about the first physical device. The 2026-09-02 code
review found fourteen places where a report row, a finding, or a drill check reported success while
proving less than it appeared to — the project's named defect shape, in the one product whose only
output is evidence. Three are the worst kind: checklist item 1 reads "answered" for a capture that
contains no attendance read; an `ACK_UNAUTH` with a four-byte body is decoded as the device clock;
and the realtime probe reports a subscription "held open" through a connection that died one second
in.

The release drill has the same shape at the packaging level: its "item 1 flips to answered" check
is green today only because of the item 1 defect, its emulator leaks on every POSIX run, and the
CommonJS-consumer failure the review reproduced (TS1479) is checked by nothing.

### 1.2 What changed underneath the kit

Sub-project A changed what the kit will observe without touching the kit: the bulk reader now falls
back to the legacy exchange only when `PREPARE_BUFFER` answers `ACK_ERROR`, a framing failure is a
`ZkFramingError` that ends the session, `readTransfer` consumes a whole chunk transfer, and
`getAttendanceLogs` reads `GET_FREE_SIZES` twice to bracket the record count. Items 19 and 23 and
the step table describe the previous library until this scope updates them (A's §16).

### 1.3 The rule this document obeys

**A row claims only what the wire shows.** Every checklist state is derived from a traced request
that left the socket, a reply code the device sent, or a count the probe computed from those — never
from a flag the operator passed, a value a library call returned, or the fact that a step callback
ran to completion. Where the wire cannot answer an item, the row says *not testable by this tool*,
and where it produced no evidence either way, the row says *not answered*. This is A's §1.3 applied
to the kit, and it decides every question below.

---

## 2. Scope

### 2.1 In scope

- `src/diagnostics/` (probe, step runner, tracer, report, types) and `src/cli.ts`.
- `.claude/skills/release-drill/scripts/drill.mjs`, `tools/emulator-serve.ts`, and the CI workflow.
- `tools/oracle/capture.ts`.
- `test/diagnostics/` and `test/emulator/` where a new scenario needs a knob.
- The kit's own spec (`2026-08-30-zkteco-bringup-kit-design.md`), `CLAUDE.md`, `README.md`,
  `docs/RELEASING.md`, and the handoff for continuing past v0.5.0.
- Ending the v0.5 cycle: merge, push, and the `v0.5.0` tag (§12).

### 2.2 Explicitly out of scope

- **Any change to what goes on the wire.** No new command, no acknowledgment of realtime events
  (§3), no byte-layout change. The allowlist of §4.4 in the kit spec is unchanged. `PROVENANCE.md`
  is unchanged, because nothing here is a protocol claim.
- **Library behaviour.** `src/` outside `src/diagnostics/` and `src/cli.ts` is read, never edited.
  The one message-shape coupling this scope adds (§4.2) is pinned by a test against the real
  library, the way item 5's is.
- **New checklist items.** The twenty-three stand (kit spec §9).
- **A 28-byte user record decoder, reply-id matching, and every other item A's §2.2 excluded.**

---

## 3. Decisions taken in brainstorming

1. **Item 8 is not testable by this tool.** The library never acknowledges a realtime event
   (`ackEvent` is implemented and called from nowhere, by the v0.2 design's ruling), so a completed
   window says nothing about whether acknowledgment is required. The row joins item 22 as *not
   testable by this tool*, and the realtime observation names the symptom without claiming it:
   the event count, and that this library sent no acknowledgment. An opt-in acknowledging mode was
   considered and rejected for this cycle: it would put a packet on the wire that neither reference
   implementation sends, on no evidence.
2. **The cycle ends with the tag.** Once this plan's final review is clean and `main` is merged and
   pushed, the last task pushes `v0.5.0`. The pipeline runs the drill on Linux and then waits for
   the operator's approval of the `npm-publish` environment; nothing is published without it.
3. **Approach: evidence from the wire.** Targeted fixes at each finding's source, structural only
   where the review found duplication (the findings booleans, the answered-or-not ternary, the
   allowlist test's coverage), and no rebuild of the report from the raw trace — the trace is
   unredacted, and a renderer that read it would sit exactly where the project's redaction rule
   says nothing may be filtered.

---

## 4. The probe

### 4.1 The attendance read is a wire fact

`getAttendanceLogs` returns `[]` without issuing a read when the device reports zero records
(`src/commands/attendance.ts:66-67`). Today `probeBulk` records `read: true` whenever that call
returns, so a zero-record device — the drill's emulator — answers item 1 with a capture that holds
no attendance request.

`findings.attendance.read` becomes true only when an attendance request left the socket: a direct
`ATTLOG_RRQ` (13) send, or a `PREPARE_BUFFER` send whose body wraps 13, in the trace span the step
produced. `probe.ts` gains `attendanceRequested(events)` beside `inferBulkPath`, built the same way
(`decodePayload` of the sent hex, command at data offset 1). When the step completed but nothing
was requested, the finding is:

```ts
{ read: false, skippedReason: 'the device reported 0 records; no read was issued', detectedRecordSize: null, rowCount: 0 }
```

A step that threw leaves `findings.attendance` null, as now; `attendanceAbsence` already names the
step and its outcome.

Item 4's observation and the step table gain one sentence: `GET_FREE_SIZES` is sent again after the
attendance read to bracket the count (A §7.2), which is why the attendance step shows one more
exchange than its command suggests.

### 4.2 Refusals are refusals

Two paths report a refusal as something else.

**Inline-decoded steps.** `probeState`'s clock and free-sizes steps call `tryExecute`, which returns
`ACK_ERROR` and `ACK_UNAUTH` rather than throwing, and then `return null` on `ACK_ERROR` — outcome
`ok` — and never look at `ACK_UNAUTH` at all, so a four-byte `ACK_UNAUTH` body is decoded as the
clock. `step.ts`'s `refused(value)` marker generalises to `declined(outcome, value)` with
`outcome: 'refused' | 'unauthorized'` (`refused(value)` stays as `declined('refused', value)`), and
`step.ts` exports `replyOutcome(command): 'refused' | 'unauthorized' | null` mapping the two ack
codes. Every step that decodes a `tryExecute` reply inline — firmware, keyword A/B, each parameter,
clock, free-sizes — checks `replyOutcome` first and returns `declined(...)`; a body too short to
decode after a real acknowledgment throws `ZkProtocolError`, which is `malformed`, which is what it
is. `probeIdentity`'s two `throw new ZkAuthError` sites become `declined('unauthorized')`, so the
step table stops attributing a throw to a reply that was answered.

**Library calls.** `Session.execute` throws `ZkProtocolError('device rejected command N')` on
`ACK_ERROR`; `classifyError` has no branch for it, so a refused user-list read reports `malformed`.
`classifyError` maps a `ZkProtocolError` whose message matches `/^device rejected command \d+/` to
`refused`. This is a message coupling of the same kind as item 5's `DECLARED_SIZE_CAP_MESSAGE`, and
it is pinned the same way: a test drives the real `Session` against an emulator answering
`ACK_ERROR` to `USERTEMP_RRQ`, so a reworded throw site reddens the test rather than silently
turning refusals back into `malformed`.

**Attribution.** `StepRunner.attribute` takes the step's first send and its reply. For a step that
did not end `ok`, the exchange a reader needs is the one that produced the outcome. On a non-`ok`
outcome, `command` and `ackCode` describe the **last** send in the span and its reply; on `ok` they
describe the first, as now. `exchanges` is unchanged. The step table's column headings say so:
"Command (deciding exchange)".

### 4.3 The second connection carries the comm key

`probeConcurrent` opens its session with no comm key, so against a keyed device item 10 reads "a
second connection was refused: device requires a comm key" when a second connection would have been
accepted. Its options gain `commKey`, passed from the CLI's, and the session is opened with it. The
transport comes from `createTransport` (A §4.7).

### 4.4 The realtime probe observes a subscription

`probeRealtime` passes a no-op error handler, counts every pushed packet as an event, and sleeps the
whole window regardless. Three changes:

- Only packets `isEventPacket` (`src/codec/events.ts`) accepts are counted as events; anything else
  pushed is counted in a new `nonEventPackets`.
- The error handler is real: it records the error, marks the window as not held open, and ends the
  window at once. The window is `Promise.race` between the sleep and that failure.
- `findings.realtime` becomes:

```ts
{
  windowSeconds: number
  registered: boolean          // REG_EVENT acknowledged
  heldOpen: boolean            // the window elapsed with the subscription still alive
  endedAfterMs: number         // when the window ended, by the injected sleep's clock
  eventsObserved: number
  nonEventPackets: number
  eventTypes: number[]
  desyncOnRegister: boolean
  error: string | null
}
```

`registered` remains the wire fact it was (the acknowledgment arrived); `heldOpen` is the new one.

### 4.5 Clock and zone

`probeState` treats the device's naive local time as UTC and compares it with the host's UTC time,
so a synchronised device at UTC+7 reports a skew of 25200 s and the field named `hostLocal` is not
local. The host clock is injected as `{ epochSeconds, utcOffsetMinutes }` (the CLI supplies
`Date.now()` and `-new Date().getTimezoneOffset()`; `src/cli.ts` stays the only clock reader).
`hostLocal` is the host's naive local time formatted exactly as the device's; `skewSeconds` is
naive-to-naive (device minus host local); `findings.clock` gains `hostUtcOffsetMinutes`, and item
21's observation prints all four so a reader can separate drift from zone.

### 4.6 A device that answers without echoing is not a refusal

`answeredKeyword` treats a reply that does not start with `keyword=` as unanswered, so a firmware
replying `DeviceName=MB360` to `~DeviceName` lands as `answered: false` — indistinguishable from an
`ACK_ERROR`, on item 15, whose whole question is whether the device echoes.
`ParameterFinding` becomes `{ key, outcome: 'answered' | 'refused' | 'mismatched-echo', empty }`.
The step outcome for a mismatched echo stays `ok` (the device answered); the finding says what it
answered with. Items 15–17 read the three outcomes apart: item 15 is answered when any keyword drew
a reply, echoing or not, and its summary counts "N echoed, M answered without the keyword, K
refused"; item 16 is answered when at least one keyword was refused or came back empty; item 17
lists the keys that answered.

### 4.7 Encoding

`encodingVerdict` is unchanged. Item 20's state follows its own observation: `not answered` when no
name carried a high byte, `answered` only when `validUtf8` is a boolean.

### 4.8 Findings shape

Beyond §4.4–§4.6: `concurrent.attempted` is deleted (it was always true and read nowhere). The
`(no message)` fallbacks in the report that the producer can never reach are deleted with it.

### 4.9 The one bounded exception to the redaction rule

`findings.freeSizes.rawHex` is a verbatim device payload in the always-written sidecar, sanctioned
by the kit spec (§4.5: item 4 needs the bytes) and bounded to `FREE_SIZES_RAW_MAX_BYTES`. The code
records this; `CLAUDE.md`'s redaction rule does not. It will (§11).

---

## 5. The tracer

### 5.1 A send is recorded after the write

`TracingTransport.send` records the `send` event before awaiting the inner write, so a write the
socket refused is in the trace as sent, and `bulkPrepareAttempted` — item 19 — goes to answered on
it. The record moves after the await. A failed write records only the `error` event, which gains an
`attemptedCommand` field so the capture still says what was tried without listing it as sent.

### 5.2 The rejected framing prefix reaches the raw capture

Item 5 tells the operator the rejected 8-byte prefix is in the raw capture; nothing writes it
there. `tryUnframeTcp` attaches the prefix as `err.raw`; the tracer's `receive` error path records
`hex: err.raw` on the `error` event when the error is a `ZkError` carrying `raw`. The raw capture is
unredacted by contract (kit spec §5.4), and `TraceEvent` never reaches `Findings` or `StepResult`
(the runner keeps only `rawByteLength`), so the redaction boundary is untouched.

---

## 6. The report

### 6.1 States

| Item | State rule after this scope | Was |
|---|---|---|
| 1 | answered iff a capture path was given **and** `attendance.read` (§4.1) | same rule on a `read` that was not a wire fact |
| 4 | unchanged; observation names the second `GET_FREE_SIZES` (§4.1) | — |
| 5 | unchanged; observation's pointer is now true (§5.2) | pointer to bytes nobody wrote |
| 8 | **not testable by this tool**; observation gives the count and says no acknowledgment was sent | answered on any completed window |
| 9 | answered iff `registered`: held open for the window, **or** dropped after `endedAfterMs` with the error — a drop answers the question | answered on any completed window |
| 13 | answered iff `eventsObserved > 0`; observation lists `eventTypes` and `nonEventPackets` | answered on a zero-event window |
| 10 | unchanged; the probe now carries the comm key (§4.3) | — |
| 15, 16, 17 | per §4.6 | one boolean |
| 19 | unchanged rule; observation: a refusal that produced a fallback was an `ACK_ERROR` (A §6.2), and a framing failure on the buffered path is named as `ZkFramingError`, not as a fallback | described the pre-v0.5 fallback |
| 20 | answered iff `validUtf8 !== null` (§4.7) | answered on "no evidence either way" |
| 21 | unchanged rule; observation adds the host offset (§4.5) | — |
| 23 | answered iff `bulkPath === 'legacy'`; observation says the refusal was necessarily `ACK_ERROR` under v0.5, so "check the per-step table for `ACK_UNAUTH`" is replaced by: an `ACK_UNAUTH` to `PREPARE_BUFFER` now ends the read as `unauthorized` and never reaches the legacy path — that step outcome is the observation | pointed the reader at a table entry that can no longer occur |

The "answered-or-not" ternary spelled thirteen times becomes one `answeredIf(ok)` helper beside
`push`; item 12 is written inline the way item 22 is.

### 6.2 Device strings cannot forge the report

`escapeCell` escapes only `|`. Device name, platform, OS and firmware are latin1-decoded device
bytes that stop only at NUL, so a name containing `\n| 3 | … | answered |` inserts a checklist row
into a report meant to be pasted into a public issue, and `[MB360](https://…)` renders as a link.

Two layers, each doing its own job:

- **At the source**, where redaction belongs: `probeIdentity` passes the four identity values and
  the firmware string through `sanitizeDeviceString`, which replaces every code point in
  0x00–0x1F and 0x7F–0x9F with U+FFFD. Bytes at and above 0xA0 are kept: item 7 needs the model
  name as the device spells it and item 20's evidence is those bytes.
- **In the renderer**, as presentation: every device-sourced value is emitted as a code span whose
  backtick fence is one longer than the longest backtick run inside the value, with a leading and
  trailing space when the value starts or ends with a backtick (CommonMark's rule), in both the
  Device section and the checklist cells. `escapeCell` also replaces `\r` and `\n` with a space,
  because `errorMessage` can still carry them.

The test is the review's exploit: a device name carrying a newline and a table row must produce a
report with exactly twenty-three checklist rows and the name rendered inert.

---

## 7. The CLI

- `--raw-capture=` with an empty value survives the null check as `''`; the write is skipped and
  item 1 reports a capture at `,`. `parseCliArgs` rejects an empty value the way it rejects a
  non-numeric port.
- `makeTransport` in `src/cli.ts` and the inline ternary in `probeConcurrent` both become
  `createTransport(kind, { host, port })`.
- `main()`'s `connected` flag is provably true where it is read; the exit code is set in the catch
  and the flag goes. `exitCodeFor` collapses to one expression. Exit-code semantics (kit spec §5.5)
  are unchanged.
- `probeState` receives the host clock as §4.5 describes; `probeConcurrent` receives the comm key.

---

## 8. The release drill and CI

### 8.1 The emulator serves a record

`tools/emulator-serve.ts` gains one 40-byte attendance record and `info.recordCount: 1`, so the
kit's item 1 is answered by a read that happened. A new check reads the raw capture and asserts an
attendance request is in it (a `PREPARE_BUFFER` wrapping 13, or a direct 13) — the positive control
that turns "item 1 flips to answered" from a claim about the renderer into a claim about the wire.

### 8.2 The emulator is killed on POSIX

`emulator.kill('SIGTERM')` signals only the `npx` wrapper of a detached process group; the `tsx`
child stays bound to its port after every run. The emulator is spawned `detached: true` on POSIX and
killed with `process.kill(-emulator.pid, 'SIGTERM')`; Windows keeps `taskkill /T`.

### 8.3 Paths are quoted on Windows

With `shell: true`, an unquoted temp path splits on the space in a user name. Every argument handed
to a shell is quoted by one helper.

### 8.4 An abort flushes before it exits

`must()` calls `process.exit(2)` immediately after `stderr.write`, which can truncate the message on
a pipe. It exits from the write's callback.

### 8.5 A CommonJS consumer is typechecked

The TS1479 case the review reproduced — a consumer without `type: module`, compiling under
`module: node16`, importing `zkteco-protocol` — is checked by nothing. The drill writes into the
consumer directory a `consumer.ts` containing `import { ZkDevice } from 'zkteco-protocol'` and one
typed use, and a `tsconfig.json` with `module` and `moduleResolution` `node16`, `strict`, `noEmit`,
and `typeRoots` pointing at the repository's `node_modules/@types` (for `Buffer`), then runs the
repository's own `tsc` (`typescript` is a devDependency) with `-p` on it. Exit 0 is the check.

### 8.6 The tarball carries no CommonJS CLI

`npm pack --json` lists the tarball's files; the drill asserts none matches `dist/cli.cjs` or
`dist/cli.d.*` (A §10.2 named this assertion as the sibling's).

### 8.7 The drill runs in CI

A second job in `ci.yml`, `drill`, runs `pnpm release:drill` on `ubuntu-latest` and
`windows-latest` with Node 24 — one leg per OS, because the drill is about packaging, not the
2×3 matrix's job. The tag pipeline keeps its drill step. A CLI or bundler regression is found on the
push that introduces it instead of on a burned version number.

### 8.8 Check list

Eleven today, fourteen after: `dist/index.cjs` exists; install pulls one package; default run
exits 0; serial absent from Markdown; serial absent from JSON; model present (positive control);
item 1 not answered and names `--raw-capture`; `--raw-capture` run exits 0; item 1 flips to
answered and names the file; **the capture contains an attendance request** (§8.1); Markdown still
hides the serial with a capture written; the capture contains the serial; **the CommonJS consumer
typechecks** (§8.5); **no `dist/cli.cjs` or `cli.d.*` in the tarball** (§8.6).

---

## 9. The capture tool

`tools/oracle/capture.ts`'s `run()` resolves on process close regardless of exit code, so a driver
that raised after `CMD_CONNECT` still has its partial packet list written as a fixture and
announced as written. `run()` resolves with the exit code; `runOracleScript` returns it; each
capture function skips `writeFixture` on a non-zero code, prints the script name, the code and the
driver's last stderr line, and the tool exits non-zero at the end if any run failed. A spawn
failure is a non-zero code too. The existing fixtures are regenerated once under the corrected tool
and must be byte-identical — the check that the change altered the tool and not the evidence.

---

## 10. Testing

Every fix has a test in both directions: the test passes after the fix, and once against the
pre-fix code (the named mutation) it fails for the reason named. Tests live in the existing
`test/diagnostics/` suites and drive the real probe against the emulator; new emulator knobs are
listed.

| Fix | Test | Mutation | Red for |
|---|---|---|---|
| §4.1 attendance read | emulator `info.recordCount: 0`; `probeBulk`; `attendance.read === false` with the zero-record reason; item 1 not answered with a capture path | set `read` from the return value | `read` true, item 1 answered |
| §4.2 inline refusals | emulator answers `GET_TIME` with `ACK_UNAUTH` carrying 4 bytes (new knob `clockReply: 'unauth4'`); clock step `unauthorized`, `findings.clock` null | drop the `replyOutcome` check | step `ok`, clock populated |
| §4.2 library refusals | emulator `supportsBuffer: false` and legacy `USERTEMP_RRQ` answering `ACK_ERROR` (new knob `refuseLegacyUsers`); users step `refused` with the deciding exchange's command 13 | remove the message mapping | `malformed`, command 1503 |
| §4.2 pinning | the real `Session.execute` against that emulator throws with the matched message | reword the regex | the pin test fails |
| §4.3 comm key | keyed emulator; `--concurrent`; item 10 accepted | drop `commKey` from the second session | item 10 refused |
| §4.4 event filter | emulator pushes one attendance event, one `ACK_OK` push, one event (new knob `pushNonEvent`); `eventsObserved === 2`, `nonEventPackets === 1` | count every push | 3 |
| §4.4 mid-window failure | emulator closes the socket 100 ms into a 2 s window (new knob `dropAfterRegisterMs`); `heldOpen === false`, `endedAfterMs < 2000`, item 9 answered "dropped", item 13 per events | no-op handler and unconditional sleep | held open, window full |
| §4.5 zone | host injected at `utcOffsetMinutes: 420` with a device time equal to host local; `skewSeconds === 0`, `hostUtcOffsetMinutes === 420` | compare with UTC | skew 25200 |
| §4.6 mismatched echo | emulator `paramEchoOverride`; finding `mismatched-echo`, item 15 answered with "answered without the keyword" | one boolean | indistinguishable from refused |
| §4.7 item 20 | ASCII names; item 20 `not answered` | old ternary | answered |
| §5.1 tracer order | a transport whose `send` rejects; no `send` event, one `error` event with `attemptedCommand`; `bulkPrepareAttempted` false | record first | true |
| §5.2 prefix | `tryUnframeTcp` failure through the tracer; the `error` event carries the prefix hex; `renderRawCapture` prints it | drop `hex` | absent |
| §6.2 injection | device name `MB360\n\| 3 \| x \| answered \| y` and `[a](b)`; exactly 23 rows; the name inert in a code span; JSON carries the sanitised value | no sanitise, no code span | 24 rows |
| §6.1 items 8/9/13 | state table rows above | old `realtimeGeneralState` | wrong states |
| §7 `--raw-capture=` | `parseCliArgs(['h','--raw-capture='])` throws | `?? null` | `''` accepted |
| §7 exit code | existing `exitCodeFor` tests unchanged | — | — |
| §8 drill | the drill is its own test; a unit test pins the consumer file and tsconfig it writes | — | — |
| §9 capture tool | a driver stub exiting 1; no fixture written, non-zero exit | resolve regardless | fixture written |
| invariants | the allowlist test drives all five probes, with `--concurrent` and `--realtime` equivalents | three probes | REG_EVENT untested |

The realtime tests use the injected `sleep` to keep windows short; nothing waits on a real clock.

---

## 11. Documentation

- **Kit spec** (`2026-08-30-zkteco-bringup-kit-design.md`): a dated amendment section: item 8 joins
  item 22 in §4.6 as not testable; the §4.5 coverage table marks items 8 and 20's conditions; §5.2
  records the `rawHex` exception; §9 names both items.
- **`CLAUDE.md`**: the redaction rule records the bounded `freeSizes.rawHex` exception; the drill
  sentence says fourteen checks and that it runs in CI on both operating systems on every push.
- **`README.md`**: the flag table's `--raw-capture` row says an empty path is rejected; the
  Diagnostics section's exit-code sentence is unchanged; the checklist link is unchanged.
- **`docs/RELEASING.md` §5**: the CommonJS bullet is replaced by what the drill now proves and the
  narrower caveat that the consumer check runs one TypeScript version.
- **`PROVENANCE.md`**: unchanged.
- **Handoff**: `docs/superpowers/plans/2026-09-03-continuing-past-v0.5.0-HANDOFF.md`, written as
  the plan's last documentation task, continuing the existing handoffs.

---

## 12. Release shape and ending

The version stays 0.5.0 (A §10.3 bumped it). The plan's final tasks: the full check and the drill
on the merged tree, the whole-branch review, merge to `main`, push, then `git push origin v0.5.0`.
The release workflow verifies the tag against `package.json`, runs the drill on Linux, and waits at
the `npm-publish` environment for the operator's approval; publishing and the GitHub Release follow
that click and nothing else.

---

## 13. First-hardware checklist impact

No item is added. Item 8's state changes from answerable to *not testable by this tool*, with the
symptom named in the realtime observation. Item 20's state now matches its own observation. Items
19 and 23 describe the v0.5 library. Item 22 is unchanged.

---

## 14. Sources

- The 2026-09-02 multi-agent code review (sections: Security; Confirmed defects 7, 8, 9, 11, 15;
  Further confirmed defects: step.ts, cli.ts:293, TracingTransport.ts:76, drill.mjs; Sweep
  additions: report.ts:455, :557, probe.ts:283, cli.ts:102, report.ts:85, capture.ts:66; Design
  and conventions; Simplification proposals).
- `2026-09-02-zkteco-library-correctness-design.md` §1.2, §2.2, §4.5, §4.7, §6.2, §7.2, §10.2,
  §10.3, §16.
- `2026-08-30-zkteco-bringup-kit-design.md` §4.4, §4.5, §4.6, §5.2, §5.4, §5.5, §9.
- `2026-08-28-zkteco-realtime-events-design.md` on `ackEvent`.
