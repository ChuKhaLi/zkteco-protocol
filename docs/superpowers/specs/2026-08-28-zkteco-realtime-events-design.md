# zkteco-protocol — Realtime Events Design Spec (v0.2)

**Date:** 2026-08-28
**Status:** Approved — ready for implementation planning
**Builds on:** `2026-08-28-zkteco-protocol-library-design.md` (v0.1), which remains the binding
authority for everything it covers. This document adds one feature and changes one interface.
**Handoff consulted:** `../plans/2026-08-28-continuing-implementation-HANDOFF.md`

---

## 1. Purpose

Subscribe to the events a device pushes as they happen — `CMD_REG_EVENT` — so a consumer learns
about a badge within a second of it happening instead of within a poll cycle.

v0.1 shipped with a limitation it named honestly: the protocol has no read-from-timestamp, so
`getAttendanceLogs({ since })` downloads the entire buffer and filters client-side. On a device
holding 100,000 records, every five-minute poll re-reads all of them. A subscription replaces that
with a push.

### 1.1 Realtime complements polling; it does not replace it

**Decided, and it constrains the whole design.** Polling stays the source of truth. The
subscription exists to cut latency, not to be the only path a punch can travel.

That is what earns this feature the right to fail loudly. A dropped connection ends the stream with
an error and the library does nothing to recover: no reconnect, no backfill, no resync. The next
poll sweeps up whatever the stream missed. A library that reconnected silently would be claiming a
completeness guarantee it cannot honour — the device buffers nothing for a subscriber that went
away, so events during a gap are simply gone, and only the polling path can find them again.

Everything in §1.1 is a consumer-side policy this library deliberately does not implement.

---

## 2. Scope

### 2.1 In scope for v0.2

- Register a realtime subscription over TCP **and** UDP, with a configurable event mask defaulting
  to attendance only.
- Deliver pushed events to the consumer as an async iterable.
- Decode both known realtime attendance payload dialects; surface every other event undecoded but
  intact.
- A one-way `listen()` mode on the transports (§3.2), and the guards that make the mode switch
  safe.
- Emulator support for pushing unsolicited packets, including the ordering cases that break naive
  implementations.
- Oracle capture for the realtime exchange, and the adjudication in §8.
- Fix the outstanding v0.1 finding in `TcpTransport.buffered` (handoff §9.1) — the file is being
  edited anyway.

### 2.2 Explicitly out of scope for v0.2

Reconnect, backfill, resync, event de-duplication, and any ordering guarantee across a disconnect
(§1.1). Resolving a realtime event's `uid` against the user list (§4.4). Cancelling a subscription
without dropping the connection (§9.5). Multiplexing request-response and a subscription on one
connection (§3.1, approach C). Every write path named in the handoff §1 stays out until hardware
exists.

---

## 3. Architecture

### 3.1 One connection, one mode

Three shapes were considered for where a subscription's socket comes from.

**A — a dedicated second connection.** `subscribe()` transparently opens another socket, handshakes
again, and listens, leaving the polling session untouched. Best ergonomics. Rejected because the
number of concurrent connections a ZKTeco device accepts **has never been observed**, and several
model families are reported to accept one. A library that silently needs two connections fails
mysteriously on the hardware it was never tested against.

**C — multiplex both on one session.** A router in `Session` sends packets matching
`command === 500 && replyId === 0` to the subscription and everything else to the pending request.
Most capable. Rejected because the discrimination rule is documentation-derived and unverified: if
it is wrong even once, a packet is misrouted and nothing reports an error. That is the exact defect
shape the handoff §5 records nine times.

**B — mode switch, adopted.** One `ZkDevice` owns one connection and is in exactly one mode. While
subscribed, `getInfo()`, `getUsers()` and `getAttendanceLogs()` throw. A consumer that wants both
constructs two `ZkDevice` instances — which makes "open a second connection to this device" a
visible decision in the consumer's code rather than an assumption buried in the library.

B assumes nothing about the protocol that is not already evidenced, turns each unknown into a loud
error rather than quiet bad data, and remains upgradable: adding an option that enables A or C
later is additive, and the export surface is a promise that cannot cheaply be withdrawn (v0.1 spec
§2.6).

### 3.2 The transport gains a mode, deviating from the handoff

The handoff §7 recommends "an event-emitting transport **alongside** the existing one, not a
modification of it". This spec modifies it instead, deliberately.

Registering a subscription is an ordinary request-response exchange: send `CMD_REG_EVENT`, await
`CMD_ACK_OK`. Only afterwards does the socket carry unsolicited traffic. Both phases must run over
the same socket. A wholly separate streaming transport would therefore have to either duplicate the
request-response half of `TcpTransport` — including its framing accumulator, the part most worth
having exactly one copy of — or open a second connection to perform the handshake, which is
approach A, already rejected.

So `Transport` gains one method:

```ts
listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void
```

The transition is **one-way and once per socket**. After `listen()`, `receive()` rejects. A second
`listen()` rejects. Ending a subscription closes the connection (§9.5), so no socket ever returns
to request mode. One irreversible transition is a state machine small enough to enumerate in tests;
a two-way router is not.

Two failure modes are silent-data-loss shaped and must be handled in the same commit that adds the
method:

1. **`listen()` must drain the pending queue into the handler.** Both transports already park a
   packet that arrives with no waiter (`TcpTransport.queue`, `UdpTransport.queue`). A packet that
   lands between the `ACK_OK` for `CMD_REG_EVENT` and the `listen()` call is a real event.
   Discarding it loses a punch with no error anywhere.
2. **`listen()` must report an already-recorded failure immediately.** `TcpTransport.failure` may
   already hold a socket error when `listen()` is called; a listener attached over a dead socket
   that then waits forever is a hang, not a failure.

### 3.3 Modules

```
src/codec/events.ts            pure: recognise an event packet, decode attendance payloads
src/realtime/Subscription.ts   pushed packets -> the consumer-facing async iterable
src/transport/{tcp,udp}.ts     listen() + the mode flag and its guards
src/transport/Transport.ts     the listen() declaration and its contract
src/session/Session.ts         subscribe(): send CMD_REG_EVENT, await the ack, flip to listen
src/ZkDevice.ts                subscribe(); the other commands refuse while subscribed
```

Dependency direction is unchanged: `ZkDevice → realtime → session → transport`, with `codec` a leaf
that everything may use and that touches no socket. `src/codec/events.ts` being pure is what makes
its behaviour expressible as byte-level fixtures.

### 3.4 Subscription flow

1. `connect()` as today: handshake, comm-key auth if the device demands it.
2. `subscribe(opts)` sends `CMD_REG_EVENT` with a 4-byte little-endian mask (§A.2) and awaits the
   reply through the ordinary request-response path. A non-`ACK_OK` reply throws `ZkProtocolError`
   and the mode never flips. **A refused registration leaves the device usable:** the session is
   not torn down, so firmware that does not support realtime fails one call rather than ending a
   connection the caller can still poll with.
3. The session flips the transport to listen mode, draining anything already queued (§3.2).
4. Each pushed payload is decoded (§5) and appended to a bounded queue; the consumer drains it by
   iterating.
5. `close()` tears the connection down (§9.5).

---

## 4. Public API

One new method on `ZkDevice` and four new exported names. The export surface is permanent, so this
is the whole of it:

```ts
const stream = await device.subscribe()        // defaults to attendance events only
for await (const ev of stream) { /* ... */ }   // a lost connection throws out of this loop
await stream.close()
```

```ts
export interface SubscribeOptions {
  /** Bitmask of EVENT_FLAG values. Defaults to EVENT_FLAG.ATTENDANCE. */
  events?: number
  /** Events buffered while the consumer is behind. Defaults to 256. */
  bufferLimit?: number
  /** Ends the stream when no event arrives for this long. Off by default (§9.2). */
  idleTimeoutMs?: number
}

export interface ZkEventStream extends AsyncIterable<ZkRealtimeEvent> {
  close(): Promise<void>
}

export type ZkRealtimeEvent =
  | {
      kind: 'attendance'
      eventType: number
      userId: string | null
      userIdSource: 'device' | null
      uid: number | null
      timestamp: ZkNaiveTime
      verifyMode: number | null
      /** Hex of the event payload, always present. */
      raw: string
    }
  | { kind: 'unknown'; eventType: number; raw: string }

export const EVENT_FLAG = { /* §A.3 */ } as const
```

`Subscription`, the transport mode flag, and everything in `codec/events.ts` stay internal, in
keeping with v0.1 spec §2.6.

### 4.1 An async iterable, not an EventEmitter

The disconnect path is the whole reason. Iterating throws, so a lost connection cannot be ignored
without the consumer writing code that visibly ignores it. An EventEmitter's `'error'` needs one
stray listener anywhere to become silence — the failure shape the handoff §5 records nine times.
`node:events` is a built-in and would cost no dependency; the reason to decline it is behavioural,
not about dependencies.

Backpressure follows from the same reasoning. The internal queue is **bounded** (default 256). A
consumer slower than the device ends the stream with a `ZkProtocolError` naming the overflow.
Neither silently dropping events nor growing without limit is acceptable; the first loses punches,
the second is the unbounded-growth finding this release is already fixing elsewhere.

### 4.2 A distinct type, not `ZkAttendanceLog`

The documented realtime attendance payload has **no in/out status field** and no record-size
dialect in the 8/16/40 sense. Reusing `ZkAttendanceLog` would force fabricating both `status` and
`recordSize`. A separate type states what is actually known.

### 4.3 Unknown events are surfaced, never decoded partially

An event whose type is not attendance, or whose payload length matches no known dialect, is
delivered as `{ kind: 'unknown', eventType, raw }`. This is v0.1 spec §5.3 applied unchanged —
parse nothing that cannot be validated — while still handing the consumer the bytes, which is what
makes an unrecognised dialect reportable rather than invisible. An unknown event never ends the
stream; only transport- and protocol-level failures do (§9).

### 4.4 Realtime carries no identity on the small dialect, and the library does not invent one

The 32-byte dialect carries a 9-byte printed user id, so `userIdSource` is `'device'` and the
identity is trustworthy. The 10-byte dialect carries no printed id at all: `userId` is `null` and
`userIdSource` is `null`.

The library does **not** resolve it through the user list. Under §3.1 approach B the subscribed
device cannot read the user list anyway, but the deeper reason is v0.1 spec §4.2: device-internal
uids are recycled when a user is deleted, so a lookup can attribute a punch to the wrong person
with no error anywhere. A consumer that accepts that risk can do the lookup itself against a
separate polling device, deliberately. A null beats a plausible wrong name.

---

## 5. Codec: risk areas and guards

### 5.1 Recognising an event packet

A pushed event decodes through the existing `decodePayload` as
`{ command: 500, sessionId: <event type>, replyId: 0, data }`. The field that carries a session id
in every other packet carries the **event type** here. Two independent sources agree on that
structure (§A.4), which is why it is implemented, and neither is a device, which is why it is in
§12.

`codec/events.ts` therefore reinterprets rather than re-parses: it takes a `DecodedPacket`, requires
`command === 500`, and reads the event type out of the session-id slot. There is no second packet
parser.

### 5.2 Dialect selection is by payload length, never by transport

`zkteco-js` selects its realtime decoder by transport — a 52-byte layout on TCP, an 18-byte one on
UDP. That is almost certainly a conflation: record dialects in this protocol vary by device model,
as the 8/16/40 attendance dialects already do, and nothing about a datagram makes a device pack a
timestamp differently. This library selects on the length of the decoded payload:

| Payload length | Dialect | Fields |
|---|---|---|
| >= 32 | large | `userId` 9-byte ASCII at 0, `verifyMode` u16 at 24, timestamp 6-byte form at 26 |
| 10 | small | `uid` u8 at 0, bytes 1-3 unknown, timestamp 6-byte form at 4 |
| anything else | unknown (§4.3) | — |

The 6-byte timestamp form is decoded by the existing `decodeZkTime6`; the packed uint32 form does
not appear in realtime payloads. Do not conflate the two (v0.1 spec §A.7).

Each dialect carries exactly one of the two identifiers, and the other field is `null`: the large
dialect sets `userId` and leaves `uid` null, the small dialect sets `uid` and leaves `userId` null.
Neither is ever derived from the other.

**An empty user id field is `null`, not an empty string.** If the large dialect's 9 bytes are all
NUL, or hold anything outside printable ASCII, the result is `userId: null` with
`userIdSource: null` — the same rule as everywhere else in this library (§4.4). An empty string
would be an identity that compares equal to another empty string, which is how a punch gets
attributed to nobody in particular and then to everybody.

The large dialect is documented as exactly 32 bytes, while the packet `zkteco-js` decodes carries
36. The four trailing bytes are undocumented, are preserved in `raw`, and are not interpreted. The
guard is `>= 32` rather than `=== 32` so a device with trailing bytes is decoded rather than
discarded — a deliberate loosening, recorded in §12.

### 5.3 The small dialect's uid rests on one oracle and one reading

`zkteco-js` reads that field as a single byte. One source cannot distinguish a u8 from a u16 LE
holding a small value, and the specification does not describe this dialect at all. The
implementation follows the single source it has, `PROVENANCE.md` records that it is a single source,
and §12 carries the question. This is the same discipline the comm-key claim was scoped to after
review (handoff §4).

---

## 6. Transport and session

`listen()` is specified in §3.2. Beyond it:

- **`ZkDevice` refuses request-response while subscribed.** `getInfo()`, `getUsers()` and
  `getAttendanceLogs()` throw `ZkConnectionError` naming the subscription and the remedy. Without
  this guard the pre-existing queue behaviour hands the *next* `receive()` a pushed event as though
  it were a reply, and `getInfo()` decodes a badge as storage counters. The v0.1 concurrent-receive
  guard does not cover this case: there is no second `receive()` in flight, only a packet nobody
  asked for.
- **`disconnect()` ends any subscription first**, then closes, and stays idempotent.
- **`connect()` while subscribed** closes the subscription along with the session it rides on, as
  it already closes an existing session today.
- **`TcpTransport.buffered` no longer grows unboundedly** when an oversized declared length is
  rejected (handoff §9.1). The connection is failed and the accumulator released.

---

## 7. Testing

### 7.1 Emulator

`test/emulator/index.ts` gains `pushEvent(eventType, data)` — writing an unsolicited packet to a
connected client — and the scripting needed to place a push at a chosen moment relative to a
request-response exchange.

The existing caveat applies and must be restated in a comment where it bites: the emulator builds
event packets with **this library's own encoder**, so a test that only round-trips through it
proves the plumbing, not the layout. What makes §A.4 evidence is an independent implementation
decoding those bytes (§8.2), not this library decoding them back.

### 7.2 Required scenarios

Every one over both transports (v0.1 convention; skip explicitly with a reason if genuinely
transport-specific):

1. Subscribe, receive N attendance events, decode each dialect.
2. A push that lands **after** the `ACK_OK` for `CMD_REG_EVENT` but **before** `listen()` attaches
   — the race the queue drain in §3.2 exists for. Without the drain this test loses an event. This
   is the benign ordering: the ack still arrives first, so nothing in the reply stream shifts, and
   the event is merely parked in the transport queue until the drain hands it over. The other
   ordering — a push that lands before the ack — is scenario 10, and it is not benign.
3. A burst exceeding `bufferLimit` — the stream ends with the overflow error, and does so without
   the queue having grown past the limit.
4. A packet with `command !== 500` arriving while listening — the stream ends with
   `ZkProtocolError`.
5. An event of unknown type, and an attendance payload of unknown length — both delivered as
   `kind: 'unknown'` with intact `raw`, and the stream survives both.
6. Connection dropped mid-subscription — `ZkConnectionError` out of the iterator.
7. A device that never acks `CMD_REG_EVENT` — `ZkTimeoutError`, and the transport never flips mode.
8. `getInfo()` while subscribed — throws, and the pushed event that was in flight is still
   delivered to the stream afterwards.
9. `close()` and `disconnect()` while events are arriving — no socket left open, no unhandled
   rejection.
10. A push that lands **before** the `ACK_OK` for `CMD_REG_EVENT`, in the window between the device
    reading the request and writing its reply. The event consumes the waiter the registration is
    holding and the ack is stranded in the transport queue, where the *next* request would collect
    it as its own reply and every reply after that would be off by one. `subscribe()` throws
    `ZkProtocolError` naming the race — not a refusal, the device refused nothing — and the session
    is **torn down** before the error propagates, so a desynced session cannot be polled (RULING
    R11). Buffering the early event and replaying it was rejected: it would preserve the punch, but
    only by building a bounded version of the multiplexing router §3.1 rejected, on a
    discrimination rule no device has ever confirmed. §1.1 already answers a lost event.
11. A push too short to be a packet at all (fewer than 8 bytes) while listening — the stream ends
    with `ZkProtocolError`, rather than the decode throwing out of a socket `'data'` handler where
    nothing would catch it. Scenario 5 does not cover this: an unknown event type and an unknown
    payload length both decode fine at the packet layer.

### 7.3 The countermeasure that actually worked in v0.1

For every regression test above: **break the code it guards, confirm the test goes red, and confirm
it goes red on the intended assertion rather than collaterally.** State in the commit that this was
done. Nine "green while proving less than it appears" defects shipped through v0.1's suite and not
one was caught by the suite itself.

Scenario 2 deserves particular care: it passes trivially if the emulator's push lands after the
listener is attached, which is a timing accident, not a test. It must be scripted so the push lands
while no listener is attached yet, deterministically — the emulator writes the events in the same
handler return as the ack, immediately behind it. Note that this is the ordering scenario 2 needs
and the *opposite* of scenario 10's, which puts the events ahead of the ack; the two look alike in
a diff and mean opposite things.

---

## 8. Evidence

### 8.1 The third adjudication: does a client acknowledge each event?

The specification says the client replies `CMD_ACK_OK` with the session id and reply number `0000`
after each event. `zkteco-js` never acknowledges — neither its TCP nor its UDP path writes anything
back after registering. Two sources, in direct conflict, on a question that is capturable.

**Decision rule, fixed before any capture is taken:**

Drive both oracles as black boxes against an emulator that accepts a subscription and pushes N
attendance events. Record every byte each puts on the socket **after** its `CMD_REG_EVENT` request.

- Neither acknowledges → **do not acknowledge.** The specification's acknowledgment is
  documentation-only; record that in `PROVENANCE.md` and §12.
- Both acknowledge → **acknowledge.**
- They disagree → follow the specification, and record the divergence in `PROVENANCE.md`.
- **One of them never registers a subscription at all** — it fails against the emulator before
  reaching `CMD_REG_EVENT`, or supports no realtime path — then it contributed **no evidence
  either way**, and the question is decided by the one oracle that did, with the claim scoped to
  a single source exactly as the comm-key claim is (handoff §4). An oracle that produced nothing
  is recorded in `PROVENANCE.md` as having produced nothing. An absence of evidence must never be
  filed as agreement.

Whichever way it resolves, `ackEvent()` is implemented and tested but **internal, and one call site
away from being enabled** — exactly the disposition `applyReplyIdQuirk` received when the reply-id
quirk was refuted (v0.1 spec §5.1). It does not join the public export surface. If a real terminal
goes silent after exactly one event, that is the first thing to try.

Driving `pyzk` here stays inside the boundary of v0.1 spec §8: its public constructor and lifecycle
methods, plus the public realtime-capture entry point, called and observed. No source is opened.

### 8.2 What can and cannot be settled by byte comparison

| Claim | Evidence available |
|---|---|
| The `CMD_REG_EVENT` request payload is a 4-byte LE mask | **Byte-level.** This library's default mask is `01 00 00 00`; `zkteco-js` transmits the same bytes. Direct comparison. |
| Whether the client acknowledges events | **Byte-level.** §8.1. |
| The event type occupies the session-id slot at offset 4 | **Behavioural only.** No oracle *sends* an event — a device does. It is testable only by having the emulator push a packet built to this layout and confirming an independent implementation decodes the right user id and timestamp from it. |
| The small dialect's `uid` width | **Single source, not adjudicable** (§5.3). |

`PROVENANCE.md` must record exactly that much and no more. The final review of v0.1 caught a
sentence claiming an invariance one data point could not establish; behavioural agreement is real
evidence and is weaker than a byte match, and the wording has to say so.

---

## 9. Errors

### 9.1 A lost connection ends the stream

`ZkConnectionError` is thrown out of the iterator. No reconnect, no backfill (§1.1).

### 9.2 No idle timeout by default

Nobody badges at 03:00. A default idle timeout would kill healthy subscriptions nightly and teach
consumers to ignore the error. `idleTimeoutMs` is opt-in and ends the stream with `ZkTimeoutError`
when it elapses; `setKeepAlive` is enabled on the listening TCP socket so a genuinely dead peer is
detected by the OS rather than by silence.

Whether a device keeps a subscription alive across an idle period is unknown and is in §12.

### 9.3 A non-event packet while listening ends the stream

`ZkProtocolError`. Deliberately strict: while listening, nothing else should arrive. If something
does, this library's model of the connection is wrong, and continuing means guessing which packets
mean what. §12 will settle whether real devices ever interleave anything here.

### 9.4 Overflow ends the stream

`ZkProtocolError` naming the limit (§4.1). No new error class — the public error taxonomy stays as
v0.1 published it.

### 9.5 Ending a subscription closes the connection

There is no documented way to cancel a subscription while keeping the connection usable for
request-response. Rather than assume one exists — sending `CMD_REG_EVENT` with a zero mask and
hoping — `close()` tears the connection down. A consumer that wants to poll afterwards calls
`connect()` again. The question is in §12; if a real device supports cancellation, adding it later
is additive.

---

## 10. Deviations from the handoff

| Handoff says | This spec | Why |
|---|---|---|
| §7: an event-emitting transport **alongside** the existing one | `listen()` **on** the existing transports | The registration handshake and the subscription share one socket; a separate transport would duplicate the framing accumulator or force approach A (§3.2). |
| §7: decide what happens when the connection drops mid-subscription | Fail loudly, no recovery | Realtime complements polling, so the poll cycle is the recovery (§1.1). |

Everything else in the handoff is carried forward unchanged, including the pyzk boundary, the
zero-dependency rule, never returning a `Date`, never fabricating an identity, and never sending
`CMD_DISABLEDEVICE`.

---

## 11. Definition of done for v0.2

1. `pnpm test` and `pnpm typecheck` clean; CI green on Node 20.19/22/24 across Ubuntu and Windows.
2. All eleven scenarios in §7.2 pass over both transports, each having been shown to fail when the
   code it guards is broken (§7.3). (Scenarios 10 and 11 were added by the final review; 6 and the
   idle timeout remain single-transport, explicitly and with a reason, as §7.2 says.)
3. The §8.1 adjudication is carried out, its raw figures recorded in `PROVENANCE.md`, and the
   implementation follows the rule as written rather than as re-argued afterwards.
4. Realtime oracle fixtures are filed on the correct side of the `test/fixtures/oracle/` split so
   the checksum adjudication's exact-count guard still means what it claims (handoff §3.2).
5. Six numbered items and the three confirmations in §12 added to §12 of the v0.1 spec.
6. README documents the subscription, including that it does not reconnect and why.
7. The public export surface grew by exactly the four names and one method in §4 and nothing else.
8. `TcpTransport.buffered` no longer grows on a rejected oversized length.

---

## 12. Additions to the first-hardware checklist

Appended to §12 of the v0.1 spec:

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
    designed behaviour, not a bug to fix in the field (§7.2 #10, RULING R11) — but if a real
    terminal does this routinely rather than rarely, the trade-off in §3.1 is worth revisiting with
    evidence, because it would mean realtime is unusable on that model without one of the designs
    that spec rejected. Record how often it happens before changing anything.

Also confirm against a real device: that the event type genuinely occupies the session-id slot
(§5.1), that the large attendance dialect's four undocumented trailing bytes are padding (§5.2),
and which of the two dialects the model emits.

---

## Appendix A — Realtime protocol reference

Restated in our own words from published protocol documentation and from an MIT-licensed
implementation's observable behaviour, per v0.1 spec §8. Every line is a hypothesis until §12 is
carried out.

### A.1 Command

`CMD_REG_EVENT` = 500.

### A.2 Registration

Send `CMD_REG_EVENT` with a 4-byte little-endian bitmask of the wanted event flags; the device
replies `CMD_ACK_OK`. The specification's worked example requests everything (`ff ff 00 00`);
`zkteco-js` requests attendance only (`01 00 00 00`), which is also this library's default.

### A.3 Event flags

| Name | Value |
|---|---|
| `EF_ATTLOG` | 1 |
| `EF_FINGER` | 2 |
| `EF_ENROLLUSER` | 4 |
| `EF_ENROLLFINGER` | 8 |
| `EF_BUTTON` | 16 |
| `EF_UNLOCK` | 32 |
| `EF_VERIFY` | 128 |
| `EF_FPFTR` | 256 |
| `EF_ALARM` | 512 |

The gap at 64 is as published; no flag is documented there.

### A.4 The pushed packet

The standard 8-byte payload header, with one difference that matters: **the field holding a session
id in every other packet holds the event type**, and the reply id is `0000`. The command is 500.

Two independent sources agree: the specification writes these packets as
`rtpacket(event=EF_X, data=..., reply number=0000)` with no session id, and `zkteco-js` reads the
event type from offset 4 — the session-id slot — while checking the command is 500. Neither source
is a device (§8.2).

### A.5 Attendance payload dialects

**Large, at least 32 bytes** — documentation and `zkteco-js` agree to the offset:

| Field | Type | Offset |
|---|---|---|
| user id | 9-byte NUL-terminated ASCII | 0 |
| zeros | 15 bytes | 9 |
| verify type | uint16 LE | 24 |
| timestamp | 6-byte form | 26 |

The packets `zkteco-js` decodes carry 36 payload bytes; the trailing 4 are undocumented (§5.2).

**Small, 10 bytes** — attested only by `zkteco-js` (§5.3):

| Field | Type | Offset |
|---|---|---|
| uid | uint8 | 0 |
| unknown | 3 bytes | 1 |
| timestamp | 6-byte form | 4 |

The 6-byte form is `year - 2000, month, day, hour, minute, second`, one byte each — v0.1 spec §A.7,
decoded by the existing `decodeZkTime6`.

### A.6 Other event payloads

Documented but **not decoded** by this library, which surfaces them as `kind: 'unknown'` with intact
bytes (§4.3): `EF_ENROLLFINGER` (result code, template size, 9-byte user id, finger index),
`EF_VERIFY` (4-byte user serial and a fixed byte), `EF_FPFTR` (a score), `EF_ALARM` (4 to 12 bytes
whose first byte selects the alarm kind), and `EF_FINGER` (no payload). Decoding any of them means
guessing at layouts no oracle can confirm, for events the consumer did not ask for by default.

### A.7 Sources

As v0.1 spec §A.9. This document additionally used the specification's realtime section and
`zkteco-js`'s realtime paths (MIT, read at source level). `pyzk` was not read, and is used here only
as a black-box oracle under §8.1.
