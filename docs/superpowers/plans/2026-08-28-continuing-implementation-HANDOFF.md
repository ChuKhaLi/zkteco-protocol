# Handoff — continuing `zkteco-protocol` past v0.1

**Date:** 2026-08-28
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`, CI green
**State:** v0.1 complete. 242 tests, 1 skipped. Zero runtime dependencies. **Not published to npm.**

---

## 1. Read this before deciding what to build

**No physical ZKTeco device has ever been connected to this library.** Every byte layout in it is
a hypothesis derived from documentation and cross-checked against wire bytes captured from two
third-party implementations. The compatibility table in the README is empty and that is accurate.

That single fact should shape what you pick up next. Everything v0.1 implements is a **read**
path. Every major thing it does not implement involves **writing to a device** — creating users,
setting the clock, opening a door, clearing the log. Getting a read wrong produces bad data you
can throw away. Getting a write wrong changes state on a terminal that people badge into every
morning.

**Recommendation: do not implement any write path until a real device has been observed and the
first-hardware checklist in the spec's §12 has been carried out.** If you want to make progress
before hardware arrives, §7 names the one substantial piece that is read-only.

---

## 2. Constraints that are not yours to relax

These were decided deliberately and each has a reason that cost something to learn.

### 2.1 `pyzk` is GPL-2.0 — execute it, never read it

`pyzk` is used as an oracle: run as a separate process against the test emulator, with the bytes
it puts on the socket recorded as fixtures. **Its source is never opened, read, searched, or
paraphrased** — not to understand an error, not to check a parameter name, not for any reason.

This library is MIT and its first consumer is distributed software. GPL-derived code here would
carry copyleft into that whole product. That is a real legal exposure, not a formality.

Running a program and observing its output is outside the scope of GPL-2.0 §0; reading its source
and writing code shaped by it is not. Only the first is permitted. `zkteco-js` is MIT and carries
no such restriction — it may be read freely, and is.

An independent reviewer audited `tools/oracle/capture_pyzk.py` and confirmed it calls only the
public constructor and lifecycle methods. Keep it that way.

### 2.2 Zero runtime dependencies, permanently

`package.json` has `"dependencies": {}` literally. Only `node:net` and `node:dgram` at runtime.
Never a native module — the consuming Electron app already pays `electron-rebuild` for one native
dependency and will not pay for another.

### 2.3 The library never returns a `Date`

Devices record naive local time with no offset. A `Date` binds that to the decoding process's
timezone: right by accident on a machine near the device, hours wrong in CI, silent either way.
`ZkNaiveTime` is plain data with a `local` string **field** — a field rather than a method so it
survives `JSON.stringify` when a consumer forwards it.

Related and equally deliberate: the device's packed calendar has 31-day months, so decoding can
legitimately produce `2026-02-31`. That is returned verbatim. A `Date` would slide it silently to
3 March.

### 2.4 Fail loud, parse nothing

Record size is derived by dividing the payload length by a count the device reported separately.
A stale count yields a garbage quotient, and a naive loop still runs — emitting misaligned records
with meaningless user ids and believable timestamps that no caller can distinguish from good data.

Every guard throws `ZkFramingError` and parses **nothing**. Never salvage a partial result.

### 2.5 An identity is never fabricated

Device-internal `uid` values are **recycled** when a user is deleted. A punch by the previous
holder of uid 5, read after the swap, resolves against the current table and is attributed to the
wrong person with no error anywhere.

So `ZkAttendanceLog.userId` is `string | null` and carries `userIdSource`: `'device'` when the
record itself supplied it, `'lookup'` when resolved through the user list, `null` when
undetermined. A null beats a plausible wrong name.

### 2.6 The export surface is a promise

`src/index.ts` exports `ZkDevice`, its options, the result types, the error classes, and the two
time decoders. **`Session`, `Transport` and everything under `codec/` stay internal.** Once
published, anything exported is something someone depends on.

`applyReplyIdQuirk` is exported from the `codec/packet.ts` **module** but is deliberately **not**
re-exported from `src/index.ts`, so it does not appear in `dist/index.d.ts` and a consumer cannot
reach it. It is also called from nowhere in `src/`. Both are deliberate — see §4.

---

## 3. What exists

```
src/
  codec/          pure functions, no I/O, no async — the leaf of the dependency tree
    checksum.ts     carry-folding one's complement
    packet.ts       payload encode/decode + applyReplyIdQuirk (unused, see §4)
    framing.ts      TCP start marker 50 50 82 7d + length prefix; UDP passthrough
    commkey.ts      comm-key mixing
    time.ts         uint32 -> ZkNaiveTime, plus the 6-byte form
    records/        attendance (8/16/40-byte dialects), user, shared
  transport/      the ONLY code that touches a socket
  session/        session id, reply-id sequencing, timeouts, bulk reads
  commands/       info, users, attendance
  ZkDevice.ts     the facade
```

Dependencies flow one way: `ZkDevice → commands → session → transport → node:net/dgram`, with
`codec` a leaf everything may use. `codec` being pure is what makes byte-level oracle comparison
expressible at all — keep it that way.

**Implemented commands (9 outbound):** `CONNECT`, `EXIT`, `AUTH`, `GET_FREE_SIZES`, `ATTLOG_RRQ`,
`USERTEMP_RRQ`, `FREE_DATA`, `PREPARE_BUFFER`, `READ_BUFFER`.

`DISABLEDEVICE` and `ENABLEDEVICE` are defined in the `CMD` table and **deliberately never sent**.
Many implementations disable a device before a bulk read so its buffer cannot shift mid-transfer;
on a five-minute poll cycle that locks employees out of badging every cycle. If you ever add it,
it defaults to off and its JSDoc says why.

### 3.1 The emulator

`test/emulator/index.ts` is a scriptable device speaking the real protocol over real localhost
sockets, TCP and UDP. Every test in this project drives the library through it — nothing is
mocked. Eight tasks extended it; follow its shape.

It already supports: comm keys, all three record dialects, junk prefixes, chunked and buffered
reads, short chunks, oversized chunks, silent devices, and dropping a connection mid-transfer.

**Its limits are worth knowing.** It answers using the library's own encoder, so a test that only
round-trips through it proves the plumbing, not the protocol. Where that matters — the
`CMD_GET_FREE_SIZES` offsets, the comm-key algorithm — the code says so in a comment. Keep saying
so when you add more.

### 3.2 The oracle harness

`tools/oracle/` drives `pyzk` and `zkteco-js` as black boxes against the emulator and records
their wire bytes into `test/fixtures/oracle/`. Those fixtures are the only evidence in this
project. Regenerate with:

```bash
python -m venv tools/oracle/.venv
tools/oracle/.venv/Scripts/pip install -r tools/oracle/requirements.txt   # Windows
pnpm oracle:capture
```

A change to those fixtures is a change in what the library believes devices expect. Explain it in
the commit message.

**Note the directory split.** `test/fixtures/oracle/*.json` is scanned wholesale by the checksum
adjudication test, which asserts an exact count of 14 discriminating packets. The comm-key
variants live in `test/fixtures/oracle/commkey/` precisely so they do not inflate that count. If
you add fixtures, think about which side they belong on.

---

## 4. The evidence discipline, and the two adjudications

This is the part most worth carrying forward.

Where documentation and reality could disagree, the project wrote down a decision rule **before**
capturing data, then followed it. Two questions were settled that way and they went opposite
directions — which is the reason to trust the method. An oracle that confirms everything is
confirming your assumptions back at you.

**The reply-id quirk was refuted.** The documentation asserts devices expect a packet whose
checksum covers the *previous* reply id. Fourteen discriminating packets across two independent
implementations and both transports all carry checksums matching the reply id **actually
transmitted**; four more were arithmetically ambiguous and excluded (one's-complement arithmetic
makes reply ids `0` and `0xffff` produce identical checksums). `Session.send` transmits the
payload unmodified.

`applyReplyIdQuirk` is retained and tested but used by nothing, and it is internal to the package —
not part of the published API. If the first real terminal refuses self-consistent packets,
restoring the behaviour is one call site in `Session.send`. **Do not delete it, do not wire it
back in without new evidence, and do not promote it to the public export surface** — an internal
escape hatch is not an API, and the export surface cannot cheaply be withdrawn.

**The comm-key mixing was vindicated.** As specified, the low byte of the session id has no effect
on the mixed key. That looked like a defect in the prose, and three people independently suspected
it. `pyzk`'s captured `CMD_AUTH` matches the implementation byte for byte, and a follow-up capture
at a session id differing only in the low byte produced an identical payload — so the invariance
is real, confirmed at one pair with two controls.

It rests on **one** external oracle: `zkteco-js` has no comm-key support and captured zero
`CMD_AUTH` packets. `PROVENANCE.md` says so; keep it saying so.

**If you settle a third question this way:** write the decision rule down first, record the raw
figures in `PROVENANCE.md`, and scope the claim to exactly what the data supports. The final
review of v0.1 caught a sentence claiming an invariance that one data point could not establish.

---

## 5. Traps that cost real time

One defect shape appeared **nine times** during v0.1, always in different clothes: **code or a
test that reports success while proving less than it appears to.** None was caught by the test
suite; every one was caught by somebody reading carefully.

The instances, so you recognise the shape:

- An error handler that swallowed every socket error, including real ones.
- A test asserting a plaintext password was absent from **hex-encoded** data. It passed, and would
  have passed with the password fully intact.
- A capture that wrote silently empty fixtures when a `spawn` failed, while the suite stayed green.
- A checksum classifier that resolved a genuine tie by silently picking one side.
- That same classifier ignoring packet data because it took it as an optional parameter defaulting
  to empty — which misread the most important evidence in the project as `neither`.
- A scenario fixture one order of magnitude too small to exercise the chunk loop it was named for.
- A disconnect assertion loose enough to be satisfied by an unrelated timeout — in a test that had
  already passed for exactly that wrong reason once.
- An assertion inside the `else` of the same predicate it re-tested, true by construction.
- `expect(emulator.transport).toBe('tcp')` on an emulator constructed with `transport: 'tcp'`.

**The working countermeasure:** for every regression test you write, temporarily break the code it
guards and confirm it goes red — and red on the assertion you intended, not collaterally. Say in
the commit or the PR that you did. A claim is not a check.

The second recurring family was **sockets left open on failure paths**, which surfaces as a test
suite that hangs in teardown rather than fails. It appeared roughly nine times too. `server.close()`
waits for existing connections; if something hangs, suspect an undestroyed socket before your own
logic.

---

## 6. What is not implemented

The reference specification (`adrobinoga/zk-protocol`) covers seven areas. v0.1 implements one of
them fully — `data-record.md`, the smallest — plus the read half of a second.

| Area | Status | Notes |
|---|---|---|
| `data-record.md` — attendance logs | ✅ complete | all three dialects |
| `data-user.md` — users | ◐ read only | no create, delete, modify; no fingerprint, face, or photo templates |
| `terminal.md` — device control | ✗ | parameters, name, serial, firmware, platform, **set clock**, restart, power off, sleep |
| `realtime.md` — live events | ✗ | `CMD_REG_EVENT` — see §7 |
| `access.md` — access control | ✗ | door open, time zones, groups, unlock combinations |
| `ex_data.md` — bulk transfer variants | ✗ | |
| `other.md` | ✗ | SMS, workcodes |
| Clearing the attendance log | ✗ | deliberately omitted — destructive |
| ADMS / push | ✗ | a different protocol entirely; the device calls a server, not port 4370 |

---

## 7. Recommended next scope: realtime events

`CMD_REG_EVENT` (500), documented in `realtime.md`.

**Why this one.** It is read-only, so it carries none of the risk in §1. And it removes the
sharpest limitation v0.1 shipped with: the protocol has no read-from-timestamp, so
`getAttendanceLogs({ since })` filters **client-side after downloading the entire buffer**. On a
device holding 100,000 records that is a full re-read every poll. Realtime subscription replaces
polling with a push, which is what the consumer actually wants.

**What it will need:**

- A **streaming** transport shape. v0.1's `Transport` is strictly request-response and rejects two
  concurrent `receive()` calls outright — a guard added after overlapping receives were found to
  misroute replies and report a spurious timeout. A subscription that receives unsolicited packets
  does not fit that contract. Plan on an event-emitting transport alongside the existing one, not
  a modification of it. The architecture anticipated this: adding a transport is cheap, and
  everything above it is transport-agnostic.
- Emulator support for pushing unsolicited events, including out of order and interleaved with a
  request-response exchange.
- A decision about what happens when the connection drops mid-subscription. v0.1's answer
  everywhere else is *fail loudly*; a silent reconnect that drops events would violate that.
- Oracle capture, if either reference implementation supports realtime. If neither does, say so in
  `PROVENANCE.md` the way the comm-key single-oracle caveat is recorded — do not let an absence of
  evidence look like evidence.

**What is genuinely unknown:** whether the event payload format matches the attendance record
dialects or is its own thing, and whether a device keeps the subscription alive across an idle
period. Neither can be settled without hardware. Write the parser defensively and add both to §12.

---

## 8. Conventions to keep

- **Every test runs over both transports** unless the scenario is genuinely TCP-only, in which
  case skip it explicitly rather than letting it misfire. There is exactly one such skip today.
- **New unverified assumptions go into the spec's §12 first-hardware checklist.** That list is the
  mechanism that catches documentation-derived guesses when a device finally arrives. v0.1 added
  two items to it late, after a reviewer noticed assumptions had been introduced without being
  recorded.
- **New evidence goes into `PROVENANCE.md`**, scoped to exactly what it supports.
- English everywhere, including commit messages.
- `pnpm test` and `pnpm typecheck` clean before every commit. CI runs Node 20.19/22/24 across
  Ubuntu and Windows — Windows is there for a real reason, since this library sits directly on
  `node:net` and `node:dgram` where `ECONNRESET` timing and TCP segmentation differ by platform.

---

## 9. Outstanding items from v0.1

Two minor findings were accepted rather than fixed, both recorded in the final review:

1. `TcpTransport.buffered` still grows when an oversized declared length is rejected. The
   permanent-hang defect is fixed; the unbounded growth is not. Low impact, real.
2. The oracle fixture count guard cannot notice a misfiled fixture whose packets are all
   `replyId === 0` — such a fixture contributes no discriminating evidence either way, so the
   claim is not corrupted, but the guard is weaker than it looks.

Neither blocks anything. Both are the sort of thing to fix while you are already in that file.

---

## 10. Sources

- Protocol specification: https://github.com/adrobinoga/zk-protocol — no license, so read for
  understanding and restate in your own words; never copy its prose.
- ZK Communication Protocol Manual:
  https://usermanual.wiki/Pdf/ZKCommunicationprotocolmanualCMD.100804048/html
- Vendor SDK: https://github.com/ZKTeco/Standalone-SDK — no license, dormant since 2018, lookup only.
- Security analysis: https://securelist.com/biometric-terminal-vulnerabilities/112800/
- `zkteco-js`: https://github.com/coding-libs/zkteco-js — MIT, readable, second oracle.
- `pyzk`: https://github.com/fananimi/pyzk — **GPL-2.0, black-box execution only** (§2.1).

The design spec at `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md` is the
binding authority for everything above, and `PROVENANCE.md` is the record of what is actually
known versus assumed. Read §12 of the spec before trusting any reading from a real device.
