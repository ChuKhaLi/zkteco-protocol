# zkteco-protocol — Design Spec (v0.1)

**Date:** 2026-08-28
**Status:** Approved — ready for implementation planning
**Package:** `zkteco-protocol` (MIT, npm name verified available 2026-08-28)
**Upstream handoff:** `2026-08-27-zk-protocol-ts-library-HANDOFF.md` (private repo `be-chamcong`)

---

## 1. Purpose

A dependency-free TypeScript library that speaks the ZKTeco binary protocol over LAN port 4370,
well enough to put a payroll-grade data pipeline on top of it, published as open source.

The first consumer is an internal Electron background agent that polls devices roughly every five
minutes and forwards attendance batches to a server. That consumer is out of scope here; it is
described only so the reader knows what shape of use the API is built for.

### 1.1 Why this package exists

No existing Node package fits. Surveyed 2026-08-26/27, re-verified 2026-08-28:

| Package | Latest release | License (GitHub API) | Why not |
|---|---|---|---|
| `node-zklib` | 2020-02-14 | **none in repo** | six years untouched; `package.json` claims ISC but the repo carries no LICENSE file, which defaults to all rights reserved |
| `zkteco-js` | 2026-06-22 | MIT | its own README states it is "not recommended for use in production… may contain bugs" |
| `zklib-js` | — | — | negligible adoption |
| `pyzk` (Python) | 2026-05-02 | **GPL-2.0** | highest quality (654 stars), but copyleft — see §8 |

None ship TypeScript types. None model the naive-local-time problem described in §4.1.

---

## 2. Scope

### 2.1 In scope for v0.1

- TCP **and** UDP transport to port 4370.
- Handshake, session acquisition, comm-key authentication when the device demands it.
- Read the full attendance log, decoding all three record-size dialects (8 / 16 / 40 bytes).
- Read the user list — required, not optional, because 8- and 16-byte records do not carry the
  printed user identifier (§4.2).
- Read device counters: user count, record count, record capacity.
- Clean disconnect, idempotent.
- Complete types; no `any` on the public surface.
- A scriptable socket-level device emulator for tests (§7) — the single most important deliverable.
- Byte-level fixtures captured from two independent implementations (§7.3).

### 2.2 Explicitly out of scope for v0.1

Fingerprint/face enrolment; creating or deleting users; clearing the attendance log; access
control; ADMS/push; setting the device clock; SMS; realtime event subscription (`CMD_REG_EVENT`,
a v0.2 candidate).

---

## 3. Architecture

### 3.1 Modules

```
src/
  index.ts              public exports
  ZkDevice.ts           facade — the only surface consumers touch
  types.ts  errors.ts

  codec/                -- depends on NOTHING. No sockets, no async, no I/O.
    checksum.ts           carry-folding one's complement
    packet.ts             8-byte payload header <-> { command, checksum, sessionId, replyId, data }
    framing.ts            TCP 8-byte prefix wrap/unwrap; UDP passthrough
    commkey.ts            comm-key mixing
    time.ts               uint32 -> ZkNaiveTime, plus the 6-byte variant
    records/
      attendance.ts       size detection + 8/16/40-byte decoding
      user.ts

  transport/            -- the ONLY place that touches a socket
    Transport.ts          interface: connect / send / receive / close
    tcp.ts                node:net, plus an accumulating buffer for split packets
    udp.ts                node:dgram

  session/
    Session.ts            session id, reply id, send-await-timeout
    dataRead.ts           bulk reads: 1503/1504 with a legacy 13 + 1500/1501 fallback

  commands/
    info.ts  users.ts  attendance.ts
```

### 3.2 Dependency direction

One way, no cycles:

```
ZkDevice -> commands -> session -> transport -> node:net / node:dgram
               |           |
               +-----------+------> codec   (leaf; depends on nothing)
```

`codec/` being a leaf is the load-bearing decision of this design, and it is driven by testing
rather than by tidiness. Oracle verification compares byte strings:
`expect(encodePayload({...})).toEqual(fixture)`. That test is only expressible if the encoder is a
pure synchronous function. If `codec/` knew about sockets, the highest-risk code in the project
would be reachable only through integration tests.

The three riskiest pieces of the protocol — checksum, comm-key mixing, TCP framing including the
reply-id quirk — all land inside `codec/`. The most dangerous area becomes the most testable one.

### 3.3 Why `transport` is separated from `session`

TCP and UDP differ in exactly two ways: the presence of the 8-byte length-prefixed header, and how
bytes arrive. Confining both differences behind one interface means `session` and everything above
it never learn which transport is in play. The entire test suite then runs against both transports
by swapping one object, so UDP support costs roughly 20% more work rather than double.

### 3.4 Why `dataRead` is separated from `commands`

The bulk-read mechanism (1503/1504, with the legacy fallback for older firmware) is shared by the
attendance log and the user list. Leaving it inside `attendance.ts` would force `users.ts` to
duplicate it.

### 3.5 Read flow

```
dev.getAttendanceLogs()
   |
   +- commands/info      getInfo() for recordCount            (mandatory first step)
   |                     recordCount === 0 -> return [] immediately, issue no further commands
   |
   +- session/dataRead   1503 prepare, loop 1504 read, 1502 free.
   |                     Older firmware -> fall back to CMD_ATTLOG_RRQ (13) + 1500/1501.
   |                     Concatenate chunks into one buffer.
   |
   +- codec/records      first 4 bytes are totalSize
   |                     GUARD: totalSize % recordCount === 0
   |                            recordSize in {8, 16, 40}
   |                     violated -> throw ZkFramingError, parse NOTHING
   |
   +- commands/users     only when recordSize is 8 or 16: resolve uid -> printed user id
```

---

## 4. Public API

```ts
import { ZkDevice } from 'zkteco-protocol'

const dev = new ZkDevice({
  host: '192.168.1.201',
  port: 4370,          // default
  transport: 'tcp',    // 'tcp' | 'udp' — default 'tcp'
  commKey: 0,          // integer; 0 means unset
  timeoutMs: 5_000,
})

await dev.connect()                    // throws ZkAuthError on a wrong comm key
const info  = await dev.getInfo()      // { userCount, recordCount, recordCapacity }
const users = await dev.getUsers()     // ZkUser[]
const logs  = await dev.getAttendanceLogs()
await dev.disconnect()                 // safe to call twice
```

```ts
interface ZkUser {
  /** Device-internal key. Recycled after deletion — NOT an identity. */
  uid: number
  /** The identifier printed on the device. A string, so leading zeros survive. */
  userId: string
  name: string
  /** Raw privilege level. Model-dependent, not decoded. */
  privilege: number
  /** True when a password is set. The password itself is never returned. */
  hasPassword: boolean
  /** Raw card number, 0 when unset. */
  cardNumber: number
  /**
   * Hex of the record bytes, **with the 8-byte password field zeroed**.
   *
   * Not a byte-for-byte copy, deliberately. `raw` exists to be persisted and
   * forwarded for reconciliation, so a credential must not ride along with it —
   * hiding the password behind `hasPassword` while republishing it in hex would
   * hide nothing. Note that a test asserting the plaintext password is absent
   * from a serialised user passes whether or not the bytes are redacted, since
   * `raw` is hex: assert on the encoded form.
   */
  raw: string
}
```

### 4.1 The library never returns `Date`

ZKTeco devices record **naive local time** — no offset, no zone. Returning a JavaScript `Date`
would silently bind that reading to the Node process timezone: correct by accident on a lab
machine, seven hours wrong in CI, and nothing anywhere reports an error. The data keeps flowing and
keeps looking plausible.

```ts
interface ZkNaiveTime {
  readonly year: number;  readonly month: number;  readonly day: number
  readonly hour: number;  readonly minute: number; readonly second: number
  /** "2026-08-27T08:01:00" — deliberately carries NO offset. */
  readonly local: string
}
```

`local` is a **field, not a `toString()` method**. Consumers serialise these records with
`JSON.stringify` to ship them onward; a method disappears across that boundary while a field
survives.

### 4.2 Attendance records carry the provenance of their identity

40-byte records embed the printed user id as a string. 8- and 16-byte records do **not** — the id
must be resolved through the user list.

That resolution has a failure mode worth encoding in the type. The device-internal `uid` is
**recycled**: delete an employee, add another, and the new person inherits the old `uid`. So a punch
recorded by the previous holder of `uid` 5, read back after the swap, resolves against the *current*
user table and is attributed to the wrong person — with no error anywhere.

```ts
interface ZkAttendanceLog {
  /** The identifier printed on the device. `null` when the device did not send it
   *  and no lookup matched. Never fabricated — a null beats a wrong name. */
  userId: string | null

  /** Where `userId` came from:
   *  'device' — sent verbatim in the record (40-byte dialect). Trustworthy.
   *  'lookup' — resolved via getUsers(). MAY BE WRONG if the uid was recycled.
   *  null     — could not be determined. */
  userIdSource: 'device' | 'lookup' | null

  /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
  uid: number | null

  timestamp: ZkNaiveTime

  /** Raw status code (check-in / check-out / …). Meaning VARIES BY MODEL — not decoded. */
  status: number

  /** Raw verification method (finger / card / face / password). Also model-dependent. */
  verifyMode: number

  /** Which dialect this record was decoded from. */
  recordSize: 8 | 16 | 40

  /** Hex of the original record bytes, for reconciliation. */
  raw: string
}
```

`userIdSource` is a warning label, not decoration. A consumer that maintains effective-dated
identity mappings can only apply them if it knows which records to distrust.

`status` and `verifyMode` stay raw. Their meanings differ across models; guessing produces data
that is confidently wrong. A best-effort `decodeVerifyMode()` helper may ship, clearly labelled as
best-effort.

### 4.3 `since` is a client-side filter and says so

The ZK protocol has no "read from timestamp X" capability. `CMD_ATTLOG_RRQ` returns the entire
buffer.

```ts
getAttendanceLogs({ since?: ZkNaiveTime, resolveUserIds?: boolean })
```

The JSDoc for `since` must state plainly that filtering happens **after downloading everything**,
and quantify it: capacious models hold up to 100,000 records, so every poll re-reads the whole
buffer. Hiding this leads users to set a ten-second poll interval and then wonder why the terminal
stops responding to employees.

`resolveUserIds` defaults to `true` — a caller should be able to just read logs — but it is an
extra device round-trip, so it must be switchable off.

### 4.4 Errors

```
ZkError
├─ ZkConnectionError   socket refused / closed / unreachable
├─ ZkTimeoutError      device silent past the deadline
├─ ZkAuthError         comm key rejected
├─ ZkProtocolError     device replied CMD_ACK_ERROR, or a malformed packet arrived
└─ ZkFramingError      record framing failed validation (§5.3)
```

`ZkFramingError` is deliberately its own class rather than a `ZkProtocolError` subtype: it is the
library's most important guard, and callers need to distinguish "the device reported a failure"
from "the bytes may be misaligned, do not trust anything parsed from them". Every error carries the
relevant `raw` hex where one exists.

---

## 5. Codec: risk areas and guards

### 5.1 The reply-id quirk — asserted by the documentation, refuted by the wire

**Superseded by oracle evidence. Recorded rather than deleted, because how this was decided
matters more than the conclusion.**

The protocol write-ups this project was built from state that reference implementations compute the
checksum over a packet carrying the **previous** reply id, then overwrite the reply-id field with
the incremented value without recomputing the checksum — so the transmitted packet carries a
checksum disagreeing with its own contents. This spec originally instructed that the behaviour be
preserved, isolated in a named `applyReplyIdQuirk()` function so nobody would later "clean it up".

It also instructed that the claim be treated as a hypothesis for the oracles to adjudicate, and
committed to the decision rule before any data existed. The data arrived and the rule fired.

Two independent third-party implementations, driven as black boxes against the emulator over both
transports, emit checksums matching the reply id they actually transmit:

| Oracle | Packet | Observed | Matches self | Matches previous |
|---|---|---|---|---|
| `pyzk` | cmd 1001, reply id 1 | 56551 | **56551** | 56552 |
| `zkteco-js` | cmd 1000, reply id 1 | 64534 | **64534** | 64535 |
| `zkteco-js` | cmd 1001, reply id 2 | 56550 | **56550** | 56551 |

The two start their reply-id counters at different values, so this is agreement across different
data rather than a coincidence. A fourth captured packet — `pyzk` cmd 1000 reply id 0 — is not
discriminating: one's-complement arithmetic makes reply ids 0 and 0xffff produce the same checksum.

`Session.send` therefore transmits the encoded payload unmodified. `applyReplyIdQuirk()` is
retained and tested internally in `src/codec/packet.ts` — not part of the public API, since the
export surface is a promise that cannot cheaply be withdrawn and an internal escape hatch does not
belong in it — and is used by nothing. That is deliberate: the evidence is two implementations and
a handshake, not a device. If the first real terminal refuses self-consistent packets, restoring
the behaviour is one call site.

Both ways of being wrong here fail loudly — a bad checksum means the device refuses everything,
which surfaces on first contact rather than corrupting data quietly. That symmetry is what made it
safe to follow the evidence.

### 5.2 The 31-day pseudo-calendar can produce dates that do not exist

Timestamps unpack from a uint32 through a packed pseudo-calendar of 31-day months and 12-month
years. A consequence worth stating explicitly: decoding can legitimately yield **2026-02-31**. That
is not a bug — it is how the device packs the value, and a drifted or power-cycled clock will
produce such combinations.

The library does **not** correct, filter, or reject them. It returns them verbatim alongside `raw`,
and lets the consumer decide.

This is also a second, independent reason not to return `Date`: `new Date(2026, 1, 31)` silently
becomes 3 March. `ZkNaiveTime` preserves `2026-02-31` intact, so the layer above sees the problem
instead of receiving a quietly normalised value.

Time tests must cover: `t = 0` (yields `2000-01-01T00:00:00`, the state of a device after a power
loss), day 31, month 12, a year boundary, and a value that produces a non-existent date.

### 5.3 Parse nothing that cannot be validated

| Guard | On violation |
|---|---|
| `totalSize % recordCount === 0` | `ZkFramingError` |
| `recordSize` is one of 8, 16, 40 | `ZkFramingError` |
| `buffer.length >= 4 + totalSize` | `ZkFramingError` |
| TCP prefix matches the expected start marker | `ZkProtocolError` |
| declared payload size matches actual length | `ZkProtocolError` |

`recordSize` is derived by division. If `recordCount` is even slightly stale — someone badged
between the counter read and the buffer read — the quotient is garbage and the parse loop **still
runs**, emitting misaligned records with meaningless identifiers and nonsense timestamps, and
raising nothing. No data is better than wrong data.

One known exception: 40-byte payloads may begin with a junk prefix. That is skipped rather than
thrown on, because it is documented device behaviour rather than evidence of corruption.

---

## 6. Transport and session

`TcpTransport` accumulates incoming bytes and only surfaces a packet once the length-prefixed
header says a complete one has arrived — TCP splits and coalesces freely, and a naive
one-`data`-event-per-packet assumption breaks under load. `UdpTransport` treats each datagram as a
whole packet.

`Session` owns the session id issued at handshake, owns reply-id sequencing including the quirk of
§5.1, and enforces `timeoutMs` per request. A device that goes silent must produce a
`ZkTimeoutError` on schedule and never hang.

**The library does not disable the device before reading.** Many implementations send
`CMD_DISABLEDEVICE` before a bulk read so the buffer cannot shift mid-transfer. With a five-minute
poll cycle that means employees are locked out of badging for a moment every five minutes. The
interleaved-write risk is accepted instead: consumers deduplicate on their own keys, and §5.3
catches the misalignment case. If ever needed this becomes an option, **defaulting to off**, with
the consequence spelled out in its JSDoc.

Device clocks drift and reset. The library never filters on that basis; it returns readings
verbatim with `raw` attached so the cause stays traceable.

---

## 7. Testing

### 7.1 A scriptable emulator, not a ZKTeco reimplementation

No physical device is available, so the emulator is the only thing separating a usable library from
a guess. It is a `net.Server` plus a `dgram` socket that speaks the protocol; tests drive the whole
library through real sockets on localhost, with no internal mocking or stubbing.

```ts
const device = await startEmulator({
  transport: 'tcp',
  commKey: 0,
  users: [...],
  records: { size: 16, rows: [...] },
})
```

Scenarios must be able to declare *broken* behaviour, since that is the hard part to test:

```ts
{ records: { totalSizeOverride: 999 } }        // must throw ZkFramingError
{ behavior: 'silent' }                          // must throw ZkTimeoutError on schedule
{ behavior: 'dropMidTransfer', afterChunk: 2 }
{ records: { size: 40, junkPrefix: true } }
```

The emulator records every byte it receives. That same capability serves both the test suite and
the oracle harness.

### 7.2 Required scenarios

1. Handshake without auth, and with auth (correct and incorrect comm key).
2. All three record sizes: 8, 16, 40.
3. Single-packet read, and multi-chunk read exceeding the maximum chunk size.
4. Empty buffer — `recordCount === 0` returns `[]` without issuing a read command.
5. `totalSize` not divisible by `recordCount` — **must throw**, must not parse.
6. Device disconnects mid-transfer.
7. Device goes silent — timeout fires on schedule, no hang.
8. 40-byte records preceded by a junk prefix.
9. Every scenario above runs over **both** TCP and UDP.
10. Time vectors including boundaries: `t = 0`, day 31, month 12, year rollover, non-existent date.

Scenarios are written once and looped over both transports:

```ts
for (const transport of ['tcp', 'udp'] as const) {
  describe(`over ${transport}`, () => { /* one shared suite */ })
}
```

### 7.3 Two oracles

An **oracle** is the source of truth that answers "what is the correct output?". For a binary
protocol with no hardware on hand, that question has no obvious answer — and a hand-written
expected value merely proves the code matches its author's reading of the documentation, not that
the reading was right. The emulator alone cannot close this gap either: it is our code, so it
reproduces our misunderstandings faithfully on both ends of the test.

Two independent implementations are therefore driven against the emulator, and the bytes they emit
are captured as fixtures:

```
tools/oracle/
  capture_pyzk.py      drives pyzk (black box) against the emulator
  capture_zkjs.ts      drives zkteco-js the same way
  compare.ts           diffs the two captures and reports divergence
                       -- excluded from the published package

test/fixtures/oracle/
  connect.json  auth.json  attlog-request.json  checksum-vectors.json
                       -- committed. CI needs no Python and no device.
```

Fixture generation is a **manual, one-off step** with documented instructions for re-running it. CI
reads the committed JSON.

Oracle coverage is prioritised on the three low-level areas where a single wrong bit produces a
silent refusal with no diagnostic: **checksum, comm-key mixing, TCP framing including the reply-id
quirk**. Record layouts get the reverse treatment — the emulator emits records and both oracles
decode them, checking that all three agree on the decoded values.

Where the oracles disagree, **neither side is picked by preference**. The divergence is documented,
adjudicated against the published protocol documentation, and flagged as the first thing to verify
when real hardware arrives.

`zkteco-js` is a `devDependency` (MIT, no constraints). `pyzk` is **not a dependency of any kind** —
only a `pip install` instruction in the oracle tooling's README.

---

## 8. Licensing and provenance

`pyzk` is GPL-2.0. Its code is **never read and never translated**. The first consumer of this
library is distributed software, so a derivative-work claim would carry copyleft obligations into
that whole product. This is a real legal exposure, not a formality.

The permitted path is clean-room reimplementation. Copyright protects expression, not facts:
command numbers, byte layouts, and checksum formulas are facts about the ZKTeco protocol; the code
and prose that express them are not. The wall here separates two kinds of information rather than
two teams:

| Crosses the wall | Stays out |
|---|---|
| Command numbers, byte layouts | `pyzk` function structure |
| Checksum formula described in prose | Variable and function names |
| Bytes observed on a socket | Control flow, branching, comments |

Running a GPL program and observing what it puts on a wire is outside the license's scope —
GPL-2.0 §0 restricts copying, distribution, and modification, not execution, and covers a program's
output only when that output is itself a work based on the program. Protocol bytes are dictated by
the device manufacturer; any correct implementation emits the same ones.

`PROVENANCE.md` records this in the repository:

| Source | License | How it is used |
|---|---|---|
| `adrobinoga/zk-protocol` | none | specification — read for understanding, restated in our own words |
| `zkteco-js` | MIT | oracle and code-level reference, **with attribution** |
| `pyzk` | GPL-2.0 | **black-box execution only**, to capture test vectors. Source never read, never translated, never distributed |
| ZKTeco Standalone-SDK | none | lookup only |

---

## 9. Repository, CI, release

### 9.1 Layout

```
├── src/                    (§3.1)
├── test/
│   ├── emulator/
│   ├── fixtures/oracle/
│   └── *.spec.ts
├── tools/oracle/           excluded from the published package
├── .github/
│   ├── workflows/ci.yml
│   └── ISSUE_TEMPLATE/device-report.yml
├── README.md  PROVENANCE.md  CONTRIBUTING.md  LICENSE
└── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
```

`"dependencies": {}` — literally empty. `"engines": { "node": ">=20.19" }`. Dual ESM+CJS via an
`exports` map, built with `tsup` as a devDependency so the shipped artifact stays dependency-free.
`files[]` covers `dist/` and the documentation files only.

### 9.2 CI

Matrix: **Node 20 / 22 / 24 × ubuntu / windows**. Windows is not there for completeness — this
library sits directly on `node:net` and `node:dgram`, whose behaviour genuinely differs across
platforms in `ECONNRESET` timing and TCP segmentation, and the first consumer runs on Windows.

CI runs `tsc --noEmit` and `vitest`. No Python, no hardware.

### 9.3 README opens with a warning, not badges

> **Not hardware-verified.** No physical ZKTeco device has ever been tested against this library.
> Every byte layout is a hypothesis derived from published protocol documentation and cross-checked
> against two independent implementations. Treat readings as unverified until your model appears in
> the table below.

Followed by a compatibility table that **starts empty**:

| Model | Firmware | Transport | Record size | Verified by | Date |
|---|---|---|---|---|---|
| *(none yet)* | | | | | |

That empty table is the most honest thing the project can publish, and it turns "we do not know"
into a concrete invitation. `ISSUE_TEMPLATE/device-report.yml` is how it gets filled: model,
firmware, transport, observed record size, whether a comm key was required, and the `raw` hex of one
record. It is the only mechanism that moves the project from documentation-derived to
hardware-verified, which is why it is worth more than any other piece of repository ceremony.

### 9.4 Release

Version `0.1.0`, published manually with `npm publish`, no changesets.

Publishing is an outward-facing and effectively irreversible action — npm restricts unpublishing
after 72 hours. It is therefore **not** performed as part of implementation. When the code is
complete and tests pass, work stops and the decision to publish, or to hold until hardware arrives,
is taken separately.

---

## 10. Deviations from the upstream handoff

1. **`userId: string | null` plus `userIdSource`**, rather than `userId: string`. Recycled `uid`
   values can otherwise attribute a punch to the wrong person silently (§4.2).
2. **`ZkNaiveTime.local` is a field**, not a `toString()` method, so it survives `JSON.stringify`
   when records are forwarded (§4.1).
3. **Two oracles instead of one**, and the reply-id quirk is treated as a hypothesis the oracles
   adjudicate rather than a given (§5.1, §7.3).
4. **`applyReplyIdQuirk()` is a named function**, not a comment inside the encoder (§5.1).
5. **The 31-day pseudo-calendar can yield non-existent dates**, stated explicitly, and left
   uncorrected on purpose (§5.2).

---

## 11. Definition of done for v0.1

1. `pnpm test` green, covering all ten scenarios in §7.2 across both transports.
2. Complete types; no `any` on the public surface; `tsc --noEmit` clean.
3. Oracle fixtures committed for checksum, comm-key mixing, and TCP framing; any divergence between
   the two oracles documented rather than silently resolved.
4. `getAttendanceLogs()` returns `ZkNaiveTime`, never `Date`.
5. Misaligned data throws; it is never parsed.
6. README carries the not-hardware-verified banner, the empty compatibility table, the client-side
   nature of `since`, and source attribution.
7. `PROVENANCE.md` present and accurate.
8. Package builds to ESM + CJS with an empty `dependencies` map.

Publication to npm is a separate decision, deliberately outside this list.

---

## 12. First-hardware checklist

Items 8–14, and their §-cross-references, come from §12 of the realtime
design spec (`docs/superpowers/specs/2026-08-28-zkteco-realtime-events-design.md`),
not from this document. Items 15 onward, and their §-cross-references, come
from §12 of the terminal read design spec
(`docs/superpowers/specs/2026-08-29-zkteco-terminal-read-design.md`), not from
this document either.

The target device is a Multi-Bio-class terminal exposing both TCP/IP pull on 4370 and push
protocols, chosen so a firmware that refuses port 4370 does not require buying a second unit.

When a physical device is first connected, before trusting any reading:

1. Capture a raw byte dump of a full handshake and one attendance read.
2. Reconcile it against §5 — specifically the checksum formulation, the comm-key mixing, and the
   reply-id quirk.
3. Confirm which record size the model actually emits.
4. Confirm the `CMD_GET_FREE_SIZES` field offsets in `src/commands/info.ts`
   (`FREE_SIZES_OFFSET`) against a real reply. They are documentation-derived
   and unverified; a wrong `recordCount` silently poisons the framing guard.
5. Confirm the TCP declared-size cap in `src/codec/framing.ts` is not rejecting legitimate
   traffic. The cap bounds what this library *requests*, but a device chooses its own size for
   an inline `ACK_DATA` body and for legacy chunks, and no hardware has ever been observed. A
   device answering a whole attendance log in one oversized packet would be refused, and the
   transport turns that into a failure lasting the connection's life.
6. Resolve any oracle divergence recorded under §7.3.
7. Only then add the model to the compatibility table.
8. Does the device require an acknowledgment for each realtime event? Symptom if it does and we do
   not send one: exactly one event arrives, then silence (§8.1).
9. Does a subscription survive an idle period, or does the device drop it? (§9.2)
10. Does the device accept a second concurrent connection on 4370? This decides whether a consumer
    can poll and subscribe at the same time (§3.1).
11. Is the small dialect's `uid` one byte or two? (§5.3)
12. Is there a way to cancel a subscription without dropping the connection? (§9.5)
13. Does the device emit event types outside the requested mask, and does it ever interleave a
    request-response packet into a listening connection? (§9.3)
14. Does the device ever push an event **before** acknowledging `CMD_REG_EVENT` — a badge in the
    window between it reading the registration and writing the reply? Symptom if it does:
    `subscribe()` throws `ZkProtocolError` naming an out-of-step reply stream and the session is
    torn down, so the consumer sees a failed subscription rather than a working one. That is the
    designed behaviour, not a bug to fix in the field (realtime spec §7.2 #10, RULING R11) — but if
    a real terminal does this routinely rather than rarely, the trade-off in §3.1 of that spec is
    worth revisiting with evidence. Record how often it happens before changing anything.

Also confirm against a real device: that the event type genuinely occupies the session-id slot
(§5.1), that the large attendance dialect's four undocumented trailing bytes are padding (§5.2),
and which of the two dialects the model emits.

15. Does the device **echo the requested keyword** in a `CMD_OPTIONS_RRQ` reply? If not, this
    library throws `ZkProtocolError` rather than guess (§5.1). That is designed behaviour, not a
    field bug — but record it, because it would make the guard unusable as written.
16. Does an unsupported parameter answer **`ACK_ERROR` or an empty value**? The library surfaces
    the two distinguishably (§4.2) precisely so this can be answered from a device report.
17. **Which parameter keywords does this firmware actually expose?** `DEVICE_PARAM` is an observed
    list, not a contract (§4.3).
18. Is the keyword payload accepted as a **bare string** — no NUL terminator, no length prefix? The
    oracles diverged under §8.1: `zkteco-js` sends it bare on TCP, the only transport on which it
    reaches this command at all — on UDP it produced no `CMD_OPTIONS_RRQ` packets whatsoever, since
    its parameter and firmware methods have no UDP callback (§8.2; `CMD_GET_TIME` is unaffected —
    zkteco-js does reach the clock command on UDP, that limitation is specific to the other two).
    `pyzk` appends exactly one trailing NUL on both transports. `encodeParamRequest` implements
    `pyzk`'s NUL-terminated form as the more likely tolerated default (see `PROVENANCE.md` §4), but
    neither shape has been confirmed against real hardware — this stays open until one is.
    **If this default is wrong, it does not fail loudly.** `CMD_GET_VERSION` carries an empty
    payload and is untouched by this decision, so a device that rejects the wrong shape presents as
    four `ACK_ERROR` refusals on the parameter reads plus a real `firmwareVersion` from
    `getIdentity()` — a plausible, reportable device profile, not an obvious malfunction. That is
    indistinguishable from the answer item 16 exists to collect, so a report of "this firmware
    exposes its version but no parameters" must not be logged as an item-16 answer without first
    ruling out a request-shape mismatch here.
19. Does the device accept a checksum over an **odd-length payload**? That branch of `checksum16`
    has never had external confirmation, and it already carries `CMD_PREPARE_BUFFER` on the main
    bulk-read path shipped in v0.1 (§5.4). A refusal here would break far more than this scope.
20. What **character encoding** does the device use for strings — device name and user name alike?
    `latin1` preserves the bytes (§5.3), so one report settles whether it is ASCII, GB2312 or
    UTF-8.
21. Does `CMD_GET_TIME` return the packed uint32 at payload offset 0, and **how far does the device
    clock drift** from the collecting server? Drift is the most likely explanation for attendance
    timestamps a user reports as wrong.
22. Does a terminal ever answer **after** this library's per-request deadline has already expired,
    and if a caller retries on `ZkTimeoutError`, does that retry's `receive()` collect the late
    reply to the *previous* request instead of the new one? `TcpTransport.receive` clears its
    waiter on timeout rather than discarding a reply that arrives after, so a late packet queues
    and the next `receive()` on that session collects it as its own. `getIdentity()` makes five
    requests where `getInfo()` makes one, so a caller that retries after a timeout has roughly five
    times the exposure to this than it did before this scope. On the parameter path the echo guard
    (§5.1) makes a stale reply loud; `readFirmware()` and `getTime()` have no equivalent — their
    ACK_UNAUTH guards do not help here, since a stale reply carries a legitimate acknowledgment
    code, just to the wrong request — and
    `getTime()` is the sharpest case, since `decodeZkTime` turns any four bytes into a
    plausible-looking date with nothing to contradict it. This is v0.1 transport architecture, not
    something this scope introduced, and no code change is proposed here — record what a real
    device does before deciding whether one is warranted.

Until that happens, every line of this library is a hypothesis.

---

## Appendix A — Protocol reference

Restated in our own words from published protocol documentation and from behaviour observed on the
wire (§8). These are facts about the protocol, not anyone's expression of them. They are a working
summary, not a substitute for the primary sources in §A.9 — and every one of them is a hypothesis
until §12 is carried out.

### A.1 Packet layout

Payload, always present:

| Field | Type | Offset |
|---|---|---|
| `command` | uint16 LE | 0 |
| `checksum` | uint16 LE | 2 |
| `sessionId` | uint16 LE | 4 |
| `replyId` | uint16 LE | 6 |
| `data` | bytes | 8+ |

**TCP** prepends 8 bytes: the start marker `50 50 82 7D` (as it appears on the wire, in that byte
order), then the payload length as uint32 LE.

**UDP sends the bare payload with no such prefix.** Published documentation is written TCP-first and
presents the start marker as though every packet carried one. It does not — this is a per-transport
difference, and it is the whole reason `framing.ts` exists as a separate module.

### A.2 Checksum

Sum the payload as 16-bit LE integers with the `checksum` field itself treated as **zero**, padding
a trailing odd byte with zero. Fold the carry: add bits 31–16 into bits 15–0. Then take the one's
complement: `chk XOR 0xFFFF`.

A well-known reference implementation expresses this differently — repeatedly subtracting `65535`
(not `65536`), then negating, then correcting back into positive range. The two agree. **Implement
the carry-fold form**, because it is the standard one's-complement formulation and reads clearly.
Pin the behaviour with oracle vectors (§7.3) rather than trusting either description.

### A.3 Commands used

| Name | Value | Purpose |
|---|---|---|
| `CMD_CONNECT` | 1000 | handshake |
| `CMD_EXIT` | 1001 | disconnect |
| `CMD_ENABLEDEVICE` | 1002 | re-enable after a disable |
| `CMD_DISABLEDEVICE` | 1003 | see §6 — normally NOT sent |
| `CMD_AUTH` | 1102 | comm-key authentication |
| `CMD_GET_FREE_SIZES` | 50 | user count / record count / capacity |
| `CMD_ATTLOG_RRQ` | 13 | read attendance log |
| `CMD_USERTEMP_RRQ` | 9 | read user list |
| `CMD_PREPARE_DATA` | 1500 | device announces an incoming data block |
| `CMD_DATA` | 1501 | one data packet |
| `CMD_FREE_DATA` | 1502 | release the device-side buffer |
| `_CMD_PREPARE_BUFFER` | 1503 | buffered read (undocumented by the vendor) |
| `_CMD_READ_BUFFER` | 1504 | read one chunk (undocumented by the vendor) |
| `CMD_ACK_OK` | 2000 | success |
| `CMD_ACK_ERROR` | 2001 | failure |
| `CMD_ACK_DATA` | 2002 | success, data attached |
| `CMD_ACK_UNAUTH` | 2005 | comm key required |

### A.4 Handshake and comm key

1. Send `CMD_CONNECT` with `sessionId = 0`.
2. The device replies with the session id it has allocated.
3. If the reply code is `CMD_ACK_UNAUTH`, send `CMD_AUTH` carrying the mixed comm key.

Key mixing, described functionally — implement from this description, do not transcribe anyone's
code:

- Reverse the 32-bit order of the key: walk bits 0 through 31, shifting each into an accumulator.
- Add the session id.
- Pack the result as 4 bytes LE and XOR them in turn with the characters `Z`, `K`, `S`, `O`.
- Swap the two 16-bit halves.
- With `ticks = 50`, let `B = ticks & 0xFF`. XOR bytes 0, 1 and 3 with `B`. **Byte 2 is assigned `B`
  directly, not XORed** — this reads like a typo and is not one. It is a prime oracle target (§7.3).

**Adjudicated (Task 14, strengthened in the final fix wave).** Implementing this description
structurally erases the low byte of the session id: adding a small session id changes only byte 0
of the packed value, the half-swap moves byte 0 to index 2, and the byte-2 assignment in the last
step then overwrites it with the tick byte. `mixCommKey(1234, 1)`, `(1234, 2)` and `(1234, 255)`
all produce identical output. That looked like a defect in the prose above — it is not one. `pyzk`,
driven as a black box against the emulator's comm-key challenge over both TCP and UDP, put
`CMD_AUTH` bytes on the wire that match this library's `mixCommKey(commKey, sessionId)` exactly
(see `test/oracle/commkey.spec.ts` and the `auth-*-pyzk.json` fixtures). That first round pinned a
single `(commKey, sessionId)` pair, though, so it could not by itself confirm the low-byte-discard
invariance — the session id never varied. Three further `pyzk` captures against session ids chosen
to isolate that specifically (one differing from the baseline only in the low byte, one only in the
high byte, one with a different comm key) show `pyzk` itself emitting byte-identical `CMD_AUTH`
payloads for the low-byte-only pair, while the high-byte-only pair's bytes genuinely differ — see
`PROVENANCE.md` for the full table. The discarded low byte is therefore genuine protocol behaviour,
confirmed at one low-byte pair against real external computation rather than only against this
library's own arithmetic — a single pair plus a structural argument, not a sweep. `zkteco-js` offered no
second opinion on any of this — it has no comm-key support at all,
so its `auth-*-zkteco-js.json` fixtures carry no `CMD_AUTH` packet.

### A.5 Bulk read sequence

1. `CMD_GET_FREE_SIZES` to obtain `recordCount`. **Mandatory first step** — §5.3 depends on it.
2. Buffered read: `_CMD_PREPARE_BUFFER` with data `<int8 1><int16 command><int32 fct><int32 ext>`,
   then repeated `_CMD_READ_BUFFER` calls, then `CMD_FREE_DATA`.
   Maximum chunk size: TCP `0xFFC0`, UDP `16 * 1024`.
   Older firmware does not support 1503 — fall back to `CMD_ATTLOG_RRQ` with
   `CMD_PREPARE_DATA` / `CMD_DATA`.
3. The first 4 bytes of the returned data are `totalSize`. Records follow.
4. `recordSize = totalSize / recordCount`, which must be 8, 16 or 40 — guarded per §5.3.

### A.6 Record layouts (little-endian)

| Size | Layout |
|---|---|
| **40 bytes** | `uid` u16, `userId` 24-byte NUL-terminated string, `status` u8, `timestamp` 4 bytes, `punch` u8, 8 bytes padding |
| **16 bytes** | `userId` u32, `timestamp` 4 bytes, `status` u8, `punch` u8, 2 reserved bytes, `workcode` u32 |
| **8 bytes** | `uid` u16, `status` u8, `timestamp` 4 bytes, `punch` u8 |

A 40-byte payload may open with a junk prefix (`FF 32 35 35 00 00 00 00 00` has been observed).
Skip it; do not throw (§5.3).

The 8- and 16-byte dialects carry no printed user id, which is why `getUsers()` is in scope (§2.1).
The 16-byte dialect does carry a numeric `userId`, but rendering it as a string would strip leading
zeros and so lose the identity — resolve through the user list instead, and set
`userIdSource: 'lookup'` (§4.2).

**Open question for the oracles:** the public API exposes `status` (in/out state) and `verifyMode`
(finger/card/face/password), while the record layouts above name their fields `status` and `punch`.
Which record field feeds which API field is not settled by the documentation. Do not guess — have
both oracles decode the same record bytes and adopt the mapping only if they agree (§7.3). If they
disagree, record it and leave it for §12.

### A.7 Time encoding

`timestamp` is a uint32 LE, unpacked sequentially with integer division at every step:

```
second = t % 60;      t = floor(t / 60)
minute = t % 60;      t = floor(t / 60)
hour   = t % 24;      t = floor(t / 24)
day    = t % 31 + 1;  t = floor(t / 31)
month  = t % 12 + 1;  t = floor(t / 12)
year   = t + 2000
```

**31 days per month, 12 months per year** — a packed pseudo-calendar, not a real one. The result is
naive local time (§4.1), and it can denote a date that does not exist (§5.2).

A different 6-byte form appears elsewhere in the protocol: `year - 2000, month, day, hour, minute,
second`, one byte each. Do not conflate the two.

### A.8 Known traps

| Trap | Handling |
|---|---|
| Checksum said to be computed before `replyId` is incremented | **Refuted by oracle capture** — both implementations emit self-consistent checksums. See §5.1 |
| A reference implementation's source comment gives the start marker as `0x7282`, but its own constant is 32130 = `0x7D82` | Trust the value, not the comment. `50 50 82 7D` on the wire |
| `uid` is recycled after a user is deleted | `userIdSource`, §4.2 |
| Disabling the device before a bulk read locks employees out every poll cycle | Do not send `CMD_DISABLEDEVICE`, §6 |
| Device clocks drift and reset to year 2000 after a power loss | Return verbatim with `raw`, §6 |
| UDP loses packets and does not recover | TCP is the default, §A.1 |
| A newly installed device reports `recordCount === 0` | Return `[]` without issuing a read, §3.5 |

### A.9 Primary sources

- `adrobinoga/zk-protocol` — https://github.com/adrobinoga/zk-protocol — Markdown specification, not
  code. The principal source. Carries no license, so it is read for understanding and restated in
  our own words, never quoted.
- ZK Communication Protocol Manual (vendor PDF) —
  https://usermanual.wiki/Pdf/ZKCommunicationprotocolmanualCMD.100804048/html
- `ZKTeco/Standalone-SDK` — https://github.com/ZKTeco/Standalone-SDK — vendor-published, dormant
  since 2018, no license. Lookup only.
- Kaspersky Securelist, biometric terminal security analysis —
  https://securelist.com/biometric-terminal-vulnerabilities/112800/ — packet structure from a
  research perspective, useful for cross-checking.
- `zkteco-js` — https://github.com/coding-libs/zkteco-js — MIT. Oracle and code-level reference.
- `pyzk` — https://github.com/fananimi/pyzk — GPL-2.0. **Black-box oracle only** (§8).
