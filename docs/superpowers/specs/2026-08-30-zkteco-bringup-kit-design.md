# zkteco-protocol — First-Hardware Bring-Up Kit Design Spec (v0.4)

**Date:** 2026-08-30
**Status:** Draft — awaiting owner review
**Builds on:** `2026-08-28-zkteco-protocol-library-design.md` (v0.1),
`2026-08-28-zkteco-realtime-events-design.md` (v0.2) and
`2026-08-29-zkteco-terminal-read-design.md` (v0.3). All three remain the binding authority for
everything they cover. This document adds **no protocol capability**. It adds a tool.
**Handoffs consulted:** `../plans/2026-08-30-continuing-past-v0.3-HANDOFF.md` and its two
predecessors. None is superseded.

---

## 1. Purpose

Make the first hour with a real ZKTeco terminal produce evidence instead of a research project.

The kit is two things: a tracing decorator that records every payload this library sends and
receives, and a read-only probe that walks the first-hardware checklist and emits a report someone
can send back.

### 1.1 Why this scope, and why now

**No physical ZKTeco device has ever been connected to this library.** True at v0.1, true at v0.3,
true today. Three handoffs have now concluded that acquiring a device is worth more than any
feature, and the checklist has grown from seven items to twenty-three while confidence in any
single line of the library has not moved.

The observation that motivates this scope is narrower and more embarrassing: **checklist item 1 is
"capture a raw byte dump of a full handshake and one attendance read", and this library cannot do
it.** There is no tracing hook, no logging, and not one reference to `process.env` anywhere in
`src/`. Every script under `tools/` drives *pyzk and zkteco-js against the emulator*; nothing
points **this** library at a device and records what came back.

So the prerequisite for items 2, 3, 4, 11, 16, 17, 18, 19, 20 and 21 is currently "open Wireshark
and correlate by hand". The kit removes that.

### 1.2 Why a tool rather than more protocol coverage

The reachable unimplemented work — workcodes, SMS, access-control configuration reads — is all
read-only and all buildable today. It was considered and rejected for this cycle. Every one of
those reads would be built from documentation nobody has checked against hardware, so each would
grow the published surface **and** the checklist while confidence stayed flat. This kit is the
only available work that makes the *other* work cheaper rather than adding to the pile, and it
introduces no protocol hypothesis of its own: tracing is observation, not conjecture.

---

## 2. Scope

### 2.1 In scope

- `TracingTransport`, a decorator over the existing `Transport` interface.
- A probe that walks the checklist using only reads the library already implements, plus one
  deliberate exception (§4.2).
- Two output artifacts: a shareable report and an opt-in raw capture.
- A published CLI entry point, so someone who merely installed the package can run it.
- One emulator addition — a `keywordForm` option — without which the A/B's most important outcome
  cannot be tested (§7.1).

### 2.2 Explicitly out of scope

- **Any write path.** Enforced mechanically, not by intention — see §4.4.
- Any new protocol command beyond those v0.1–v0.3 already send.
- Reconnect, retry, or recovery logic. The probe runs once and reports.
- Interpreting the results. The report records what happened; deciding what it means about the
  protocol is a human's job with the specs open.
- Publishing to npm, which is a separate owner decision this document does not make.

---

## 3. Architecture

### 3.1 Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `src/diagnostics/TracingTransport.ts` | Records every payload in and out, and every error | `Transport` |
| `src/diagnostics/probe.ts` | Walks the checklist, returns a result object | `Session`, the command functions |
| `src/diagnostics/report.ts` | Renders a result to Markdown and JSON | nothing |
| `src/cli.ts` | Argument parsing, clock, filesystem, exit codes | all of the above |

`TracingTransport` holds no policy. It records; it does not decide what is interesting. `probe.ts`
performs no I/O and reads no clock. `report.ts` is a pure function of the probe result. Everything
impure lives in `src/cli.ts`, which is the one module that cannot be tested against the emulator —
so it is kept as thin as it can be made.

### 3.2 The probe is separate from the library because their failure contracts are opposites

`getIdentity()` deliberately abandons its remaining reads the moment one fails: there is no partial
result and no salvage, because a function that turned five failures into five absences would be
indistinguishable from a device that exposes nothing (v0.3 §4.2).

A diagnostic needs precisely the inverse. A device that refuses one read must still yield answers
for the other twenty; that is the entire product.

These cannot both live in one code path, and the library's contract is not the one to weaken. So
the probe calls the library's reads and supplies its own per-step isolation on top (§6). Where the
batching would defeat that — the parameter sweep — the probe calls `getParameters` **one key at a
time** rather than passing the whole list, so a single hard failure cannot end the sweep.

### 3.3 The tracing seam: a decorator

`Transport` is a five-method interface (`connect`, `send`, `receive`, `listen`, `close`) and is not
exported from `index.ts`. A decorator implementing it wraps the real transport and sees every
payload.

Three approaches were considered.

- **A decorator (chosen).** Zero change to the published surface and zero change to the transports.
  This matters more than it sounds: the transports are the most delicate code in the repository —
  one-way `listen`, sticky failures, desync teardown — and three of the six items carried on the
  outstanding list have lived there. The decorator is testable in isolation against the emulator.
- **A `trace` callback on `ZkDeviceOptions`.** Rejected. It puts a callback type and an option on
  the published API to serve a use case nobody has asked for, and the CLI does not need it. That is
  surface bought on speculation.
- **A wire-level hook inside both transports.** Rejected for now. It would capture true wire bytes
  including TCP framing, and would cost nothing publicly since `TransportOptions` is not exported
  either — but it means editing `send`, `absorb` and the dgram `message` path, which is where this
  project's bugs actually live.

**The decorator's limitation, stated rather than hidden.** It observes payloads, not wire bytes:
TCP framing is applied inside `TcpTransport.send`. For sends this is reconstructible, because
`frameTcp` is deterministic. For receives the checksum is computed over the payload, so items 2 and
19 are fully served. Item 5 — the TCP declared-size cap rejecting legitimate traffic — is the one
case that wants the prefix, and it is already covered: **both throw sites in `tryUnframeTcp` attach
`buf.subarray(0, 8)` as the error's `raw` hex**, so the rejected declared size arrives with the
error. If a real device raises a framing question this cannot answer, revisit the wire-level hook
then, with evidence.

### 3.4 Packaging

- `tsup` entry becomes `['src/index.ts', 'src/cli.ts']`.
- `package.json` gains `bin: { "zkteco-protocol": "./dist/cli.js" }`. `files` already ships `dist`.
- **Zero runtime dependencies is preserved.** Argument parsing uses `node:util`'s `parseArgs`;
  output uses `node:fs`. Nothing else is added.
- The package is already `"type": "module"`, so the bin is plain ESM with a shebang.

`src/diagnostics/` lives under `src/` rather than `tools/` because unlike the oracle scripts it must
be built and shipped. `index.ts` never imports it, so tree-shaking keeps it out of the library
bundle — asserted in the smoke test (§7.2) so it cannot drift onto the published surface unnoticed.

---

## 4. The probe

### 4.1 Sequence

Ordering principle: cheapest and least disturbing first, and the control read before the reads it
controls for.

1. **Connect and handshake.** Records whether the device answered `ACK_UNAUTH` and demanded a comm
   key.
2. **`CMD_GET_VERSION`.** First among the reads, deliberately, because it is the control — see
   §4.2.
3. **The request-shape A/B** (§4.2).
4. **Parameter sweep**, one key at a time across `DEVICE_PARAM`. Items 15, 16, 17, 20.
5. **`CMD_GET_TIME`**, recording device time and local time side by side without judging the
   difference. Item 21.
6. **`CMD_GET_FREE_SIZES`**, retaining the raw body so `FREE_SIZES_OFFSET` can be checked against
   reality. Item 4.
7. **Users**, then **attendance** (§4.3). Items 3, 11, 20, and which bulk path the firmware took —
   which also answers item 23. `CMD_PREPARE_BUFFER` carries an 11-byte, odd-length payload, so item
   19 is exercised whether or not anyone thinks about it.
8. **Realtime and second-connection probes — opt-in only**, via `--realtime <seconds>` and
   `--concurrent`, and last. Registering for events flips the socket one-way and cannot be undone;
   that must not happen to someone who typed the bare command. Items 8, 9, 10, 12, 13, 14.

### 4.2 The request-shape A/B, which is the point of the probe

Send `~SerialNumber` NUL-terminated, then send it again bare.

**Item 18 is the library's one shipped protocol guess.** `pyzk` sends the `CMD_OPTIONS_RRQ` keyword
NUL-terminated; `zkteco-js` sends it bare. The decision rule's disagree branch selected the form a
device tolerating either would accept, and `encodeParamRequest` implements pyzk's. `PROVENANCE.md`
records that superset-ness rests on parser speculation and that the losing case is real.

Two extra round trips settle it:

| Outcome | Meaning |
|---|---|
| both answer | devices tolerate either; the assumption the library rests on is confirmed |
| only NUL-terminated answers | the shipped default is correct, and no longer a guess |
| only bare answers | `encodeParamRequest` is wrong; the fix is one line plus two test edits |
| neither answers | the keyword is unsupported; retry the A/B on another key before concluding |

This is the one place the probe issues a request the library would not issue on its own. It is
read-only, it is the same command with a different payload encoding, and it converts the project's
largest open hypothesis into an observation.

**It also disambiguates a trap.** Handoff §3.1 warns that if the shipped default is wrong,
`getIdentity()` returns four nulls plus a real `firmwareVersion` — a plausible device profile
indistinguishable from the answer item 16 exists to collect. Step 2 establishes that
`CMD_GET_VERSION` works, and the A/B then separates "this firmware exposes no parameters" from "we
are asking wrongly". The report must never log the former without the latter having been ruled out.

### 4.3 The attendance guard

The protocol has no "read N records": the device returns its entire buffer. On a terminal holding
100,000 records that is slow and keeps the device busy while people are badging at it.

`--attendance=auto|always|never`, defaulting to `auto`: read the log when `recordCount` is below
**10,000**, skip it otherwise. One option with three values rather than a flag and a `--no-` twin,
because `node:util`'s `parseArgs` has no negated-boolean convention and inventing one here would be
the tool's first piece of surprising behaviour.

**A skip is reported as a skip**, naming the record count and the option that would override it.
Silently omitting it would be the "reports success while proving less than it appears to" shape this
project has caught twenty times.

The 10,000 figure is a guess about politeness and nothing more — see §8, risk 3. It is written here as a
number rather than left to the implementer so that it is one decision in one place, and so that the
first person to find it wrong knows exactly what to change.

### 4.4 The write allowlist

The probe may send exactly these commands: `CONNECT` 1000, `EXIT` 1001, `AUTH` 1102, `OPTIONS_RRQ`
11, `GET_TIME` 201, `GET_VERSION` 1100, `GET_FREE_SIZES` 50, `USERTEMP_RRQ` 9, `ATTLOG_RRQ` 13,
`FREE_DATA` 1502, `PREPARE_BUFFER` 1503, `READ_BUFFER` 1504, and `REG_EVENT` 500 when realtime is
explicitly requested.

`ENABLEDEVICE` 1002 and `DISABLEDEVICE` 1003 are excluded **by name**. v0.1 §6 ruled that disabling
the device before a bulk read locks employees out of badging every poll cycle, and accepted the
interleaved-write risk instead. A diagnostic must not quietly reintroduce what the library
deliberately refuses.

This is enforced by a test, not by intention (§7.2).

### 4.5 Checklist coverage

| Item | Answered by |
|---|---|
| 1 raw byte dump | `--raw-capture` |
| 2 reconcile against §5 | computed locally from the trace |
| 3 record size | attendance read |
| 4 `FREE_SIZES_OFFSET` | `GET_FREE_SIZES` raw body |
| 5 TCP declared-size cap | framing error's `raw`, if it fires |
| 6 oracle divergence §7.3 | the A/B, for item 18's part of it |
| 7 compatibility table | identity values (§5.2) |
| 8, 9, 12, 13, 14 realtime | `--realtime` |
| 10 second connection | `--concurrent` |
| 11 small-dialect uid width | attendance read |
| 15, 16, 17 parameters | parameter sweep |
| 18 keyword shape | the A/B (§4.2) |
| 19 odd-length checksum | `PREPARE_BUFFER`, unavoidably |
| 20 string encoding | structural verdict (§5.3) |
| 21 clock offset and drift | `GET_TIME` |
| 23 `ACK_UNAUTH` as "unsupported" | which bulk path was taken |

### 4.6 What cannot be probed

**Item 22** — a device answering after the deadline — is not deterministically provokable. It is
reported as *not testable by this tool*, explicitly, rather than silently omitted. An absence must
be visible as an absence at the point a reader would otherwise assume presence.

---

## 5. Artifacts

### 5.1 The shareable report

Markdown for a human, with a JSON sidecar carrying the same data so reports from different devices
can later be diffed into the compatibility table.

Contents: the checklist walk, each item marked *answered* / *not answered* / *not testable* with the
observation behind it; per-step outcomes (command, ack code, body length); the detected record size
and bulk path; and locally computed checksum and reply-id verdicts **as pass/fail rather than as
bytes**.

### 5.2 The redaction boundary

| Field | Treatment | Why |
|---|---|---|
| `deviceName`, `platform`, `os`, `firmwareVersion` | **value included** | item 7 is unanswerable without them; they describe a model, not a person or a secret |
| `~SerialNumber` | **presence only** | identifies one unit; no checklist item needs the value — item 17 needs only that the key answered |
| user names, user ids, attendance rows | **never** | personal data; counts, record size and field shapes only |
| comm key, `CMD_AUTH` payload | **never** | a secret |

The default output is intended to be safe to paste into a public issue by someone who did not stop
to think about it, because stopping to think is exactly what a stranger doing you a favour will not
do.

### 5.3 Item 20 without shipping employee names

Answering "what encoding does this device use for strings" sounds like it requires the strings. It
does not. The discriminating signal is structural: UTF-8 has a strict continuation-byte grammar and
GB2312 does not.

The probe decodes locally and reports a verdict — *of N names, K carried bytes above 0x7F, and
those byte sequences are (or are not) valid UTF-8* — rather than the content. Item 20 is answered
with zero leakage. This is possible only because v0.3 moved `readNulTerminated` to `latin1`, which
is byte-preserving; under `ascii` the high bit was already gone by the time anyone could look.

### 5.4 The raw capture

Opt-in via `--raw-capture <file>`. JSONL: one record per traced payload — sequence, direction,
monotonic offset, hex, decoded header — preceded by a header line stating in plain words what the
file contains, including the comm-key payload and employee data.

Unredacted by necessity. Item 2's reconciliation is a checksum over exact bytes, and redacting
anything inside a payload destroys the evidence being verified. The two artifacts exist precisely
because these two requirements cannot be met by one file.

JSONL rather than the single JSON array the oracle fixtures use: those are written atomically at the
end of a controlled run against an emulator. This one runs against unknown hardware that may drop
the connection mid-probe, and a partial capture is still evidence. Line-at-a-time means a crash
costs the last line instead of all of them.

### 5.5 Exit codes

`0` when the probe **ran**, even if the device refused everything. A terminal that says no to twenty
reads is a successful diagnostic and the report is the deliverable.

Non-zero only when the probe could not connect at all, or could not write its output. Getting this
backwards would make the tool look broken at exactly the moment it is working.

---

## 6. Error isolation

### 6.1 Continue if the device answered

The predicate is one this codebase already established, in `freeBuffer`: an answer proves the reply
was consumed and the session is still in sync.

- **The device answered** — `ACK_ERROR`, `ACK_UNAUTH`, or a reply that arrived intact and then
  failed a guard (echo mismatch, short body, bad framing) — **record and continue.** A refusal is
  data, and so is a malformed answer.
- **The device did not answer** — timeout, dropped connection — **stop** (§6.2).

**These are two independent axes, and conflating them is the mistake to avoid.** What a step
*recorded* and whether the run *continues* are decided separately:

| Recorded outcome | Meaning | Run continues? |
|---|---|---|
| `ok` | decoded successfully | yes |
| `refused` | `ACK_ERROR` — the device answered no | yes |
| `unauthorized` | `ZkAuthError` — the device answered `ACK_UNAUTH` | yes |
| `malformed` | answered, but a guard rejected it (`ZkProtocolError`, `ZkFramingError`) | yes |
| `silent` | `ZkTimeoutError` — no answer by the deadline | **no** |
| `dropped` | `ZkConnectionError` — socket gone | **no** |

Every outcome carries the error class, message, and any `raw` hex the error already holds. A reader
must be able to tell "the device rejected this" from "the device sent something we could not parse"
without inferring it from a message string — those are different answers to different checklist
items.

### 6.2 Why a timeout truncates the run

The instinct is to press on to the next step. **Item 22 is why we must not.**
`TcpTransport.receive` clears its waiter on timeout, so a late reply queues and the *next* request
collects it as its own. Continuing past a timeout would produce a report full of real answers
attributed to the wrong questions — the single worst failure mode for a tool whose only product is
evidence, and one that would be invisible to the reader.

So a timeout truncates: the run stops, and the report states that it was truncated and where. A
short honest report beats a complete misleading one.

---

## 7. Testing

Everything except `src/cli.ts` is tested against the existing emulator, on both transports.

### 7.1 Scenarios

1. Full probe end to end, producing a complete report.
2. Per-step isolation: the emulator refuses one command; the report still carries results for the
   rest.
3. Truncation: the emulator goes silent on one command; the probe stops and the report says so.
4. `TracingTransport` alone: both directions recorded, errors recorded, `listen()` passes through.
5. The request-shape A/B, exercised across all four outcomes in §4.2's table.

**Scenario 5 requires an emulator change, and the plan must budget for it.** The emulator's
`CMD_OPTIONS_RRQ` handler currently strips a single trailing NUL before matching, deliberately
modelling a device tolerant of either form (v0.3 §8.1's "they disagree" branch). That is the right
default and must stay the default — but it means the A/B always reports "both answer" against the
emulator as it stands, so three of the four outcomes would be untestable and the branch that
matters most could never be shown to work.

A `keywordForm: 'nul' | 'bare' | 'either'` option is needed, defaulting to `'either'` so every
existing test is unaffected. Without it, scenario 5 is a test that passes while proving one quarter
of what its name claims.

### 7.2 The two invariant tests

**The write allowlist.** Run the full probe, assert every command in `emulator.received` is in the
§4.4 list. This is the test that fails the day someone adds a convenient `DISABLEDEVICE`.

**Redaction, with its control.** Configure the emulator with a distinctive serial number and user
names. Assert those strings appear nowhere in the report or its JSON sidecar — **and assert they do
appear in the raw capture.** Without the second half the test passes vacuously if the probe
captured nothing at all, which is exactly the defect shape this project has caught in every cycle
so far.

A third, smaller assertion belongs in the existing smoke test: `dist/index.js` contains no
diagnostics code.

### 7.3 The purity constraint that makes the above possible

`Date.now()` and all filesystem access live **only** in `src/cli.ts`. The probe takes a clock value
and returns data; the report renderer is a pure function of that data. Without this, every report
test becomes timestamp-sensitive and someone starts asserting on substrings instead of structure.

### 7.4 The countermeasure

Unchanged and still the only thing that catches the recurring defect: break the code a test guards,
confirm it goes red **on the assertion you intended**, and say in the commit that you did. The
redaction test in particular must be verified by disabling redaction and watching it fail, not by
watching it pass.

---

## 8. Risks and open questions

1. **The probe's value is unverifiable until it meets hardware.** Every scenario here runs against
   an emulator built from the same assumptions the library holds, so a passing suite proves the tool
   works against *our model* of a device. That is the same limitation every other line of this
   project carries, and it is not a reason to defer — but the report must never read as though it
   were validated.
2. **The A/B could be misread.** If a device answers neither form, that is a keyword question, not a
   shape question. §4.2's table says so and the report must repeat it, or the first real result will
   be logged as an item-18 answer when it is an item-17 one.
3. **The 10,000-record threshold in §4.3 is arbitrary.** No device has been observed, so no record
   count is known to be slow, and no terminal's tolerance for being kept busy is known either. It is
   a guess about politeness, documented as one, and `--attendance=always|never` exists because of
   it. The first real device should be treated as evidence about this number, not as a run that
   happened to fall on one side of it.
4. **The redaction boundary is a judgement, not a standard.** `deviceName` and `platform` are
   admitted because item 7 needs them. If a firmware puts a customer name in `deviceName`, that
   judgement is wrong and the boundary must move.

---

## 9. First-hardware checklist impact

This scope adds **no new checklist items**. It is the first scope in the project's history that
adds none, which is the point: it exists to answer the twenty-three that are already there, not to
add a twenty-fourth.

Item 22 gains a note that it is not testable by this tool (§4.6). No other item's text changes.

---

## 10. Sources

Unchanged from v0.3. `adrobinoga/zk-protocol` carries no license — read for understanding, restate
in our own words. `zkteco-js` is MIT. **`pyzk` is GPL-2.0: execute it, never read it.** This scope
adds no new oracle capture and reads no new source.
