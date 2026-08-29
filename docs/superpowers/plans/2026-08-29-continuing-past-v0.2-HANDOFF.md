# Handoff — continuing `zkteco-protocol` past v0.2

**Date:** 2026-08-29
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`, CI green
**State:** v0.2 complete. 334 tests, 1 skipped, across Node 20.19/22/24 on Ubuntu and Windows.
Zero runtime dependencies. **Still not published to npm.**

This continues `2026-08-28-continuing-implementation-HANDOFF.md`, which covers v0.1 and is still
accurate about everything it describes. Read that one too — it is not superseded, only extended.

---

## 1. The one fact that should shape what you pick up next

**No physical ZKTeco device has ever been connected to this library.** That was true at v0.1 and it
is still true. v0.2 did not change it; it made the list of unverified assumptions longer.

The first-hardware checklist in the v0.1 spec's §12 now has **fourteen** items. Six came from
realtime work, and the newest — item 14 — describes a race this library now detects and refuses.
Every one of them is a question only a terminal can answer.

**Recommendation: getting a device is worth more than any feature you could add.** Writing more
protocol code without one lengthens the checklist rather than shortening it. §7 names the best
read-only scope if hardware genuinely is not available yet.

---

## 2. What v0.2 added

Realtime event subscription — `CMD_REG_EVENT`, the read-only scope the previous handoff recommended.

```ts
const stream = await device.subscribe()          // attendance events by default
for await (const event of stream) { /* ... */ }
await stream.close()                             // in a finally
```

The public surface grew by exactly four names and one method: `EVENT_FLAG`, `SubscribeOptions`,
`ZkEventStream`, `ZkRealtimeEvent`, and `ZkDevice.subscribe`. That was a fixed budget, pinned by a
smoke test that asserts the runtime export list exactly.

### 2.1 What it deliberately does not do

- **No reconnect, no backfill, no resync.** A dropped connection ends the stream with an error and
  the library does nothing to recover. Realtime complements polling; the next poll sweeps up
  whatever the stream missed. A silent reconnect would claim a completeness guarantee that cannot
  be honoured, since a device buffers nothing for a subscriber that went away.
- **One `ZkDevice`, one mode.** While subscribed, `getInfo()`, `getUsers()` and
  `getAttendanceLogs()` throw. Polling and listening at once needs two instances — which keeps
  "open a second connection to this device" a visible decision, because the number of concurrent
  connections a terminal accepts has never been observed. That is checklist item 10.
- **No client-side filtering.** The device filters by the registered mask; every packet that
  arrives is surfaced, decoded when it can be and as `kind: 'unknown'` with intact bytes when not.
- **No identity invention.** The 10-byte dialect carries no printed id, so `userId` is `null`
  there. It is never resolved through the user list, because uids are recycled after a deletion.

### 2.2 Architecture

`Transport` gained one method, `listen(onPacket, onError)`, and the transition is **one-way per
socket**: after it, `receive()` rejects and a second `listen()` throws. Ending a subscription closes
the connection. That deviates from the previous handoff's advice to build a separate event-emitting
transport, deliberately — registration is itself a request-response exchange and must share the
subscription's socket, so a separate transport would have to duplicate the framing accumulator or
open a second connection.

New files: `src/codec/events.ts` (pure), `src/realtime/Subscription.ts` (the bounded async
iterable). Dependency direction is unchanged.

---

## 3. What the evidence actually says

`PROVENANCE.md` is the authority. Two claims are worth restating here because they are easy to
overstate from memory:

**The acknowledgment question was adjudicated, on a single source.** The protocol documentation says
a client acknowledges every pushed event; `zkteco-js` never does. The decision rule was fixed before
any capture was taken. `pyzk` **never reached `CMD_REG_EVENT` at all** on either transport, so it
contributed **no evidence either way** — recorded as nothing, not as agreement. `zkteco-js`
registered on both transports and sent nothing back. So: this library does not acknowledge, and the
finding rests on the source reading, with the captured silence as weak corroboration only, because
zkteco-js's own gates never recognised the pushed events and it most likely never saw one it could
have acknowledged.

`ackEvent()` is implemented, tested, internal, and called from nowhere — the same disposition
`applyReplyIdQuirk` got when the reply-id quirk was refuted. **If the first real terminal delivers
exactly one event and then goes silent, that is the symptom of a device that wanted an ack, and this
is one call site away in `Session.subscribe`.**

**The event-type-at-offset-4 layout rests on source-level agreement only.** A pushed event carries
its event type in the field that holds a session id in every other packet. Two independent sources
agree — but neither is a device, and the behavioural confirmation the design spec originally planned
turned out to be unobtainable: driven with a live callback, `zkteco-js`'s TCP gate never recognised
the emulator's events (they arrive coalesced, and it inspects only the first frame), and its UDP path
requires a length our events do not have. That experiment was run and recorded rather than argued.

---

## 4. Traps that cost real time this cycle

The previous handoff named one defect shape that appeared nine times: **code or a test that reports
success while proving less than it appears to.** It appeared again, in new clothes. Every instance
below was caught by a reviewer reading carefully, never by the suite.

- **A guard test that passed with the guard deleted.** `getInfo()` while subscribed was asserted to
  throw `ZkConnectionError` — but the transport throws the same class one layer down, so the test
  was green either way. Fixed by asserting the guard's own message. **When a test names a specific
  layer's guard, check that a lower layer does not already produce an indistinguishable failure.**
- **A test that only passed on Windows.** A test pinned the queue-drain path by pushing events
  alongside the registration ack. It was green on all Windows jobs and red on all Ubuntu ones,
  because on Windows the emulator's writes coalesced into one TCP segment and on Linux they did
  not. The comment defending it blamed the transport — TCP versus UDP — for what is really **kernel
  write coalescing**. That is the same mistake this library calls out `zkteco-js` for: attributing
  to the transport something that belongs to another cause. **This one is worth internalising: CI
  runs Windows and Linux for exactly this reason, and a green local run proves one platform.**
- **An assertion that could not distinguish success from failure.** A "closes cleanly" scenario
  asserted the emulator recorded no socket errors — but the ignore list filters exactly the codes an
  *unclean* close produces, so both outcomes left it empty. Replaced with an assertion that the
  `CMD_EXIT` goodbye was actually observed, which also closed a real coverage gap.
- **A record that claimed a gap was closed when it was not.** A commit message said a later scenario
  covered the malformed-push decode guard. It did not — that scenario pushes an unknown *type* and
  an unknown *length*, both of which decode fine at the packet layer. The guard had no test at all
  until the final review.
- **A silent desync.** An event arriving *before* the registration ack consumed the waiter and
  stranded the real `ACK_OK` in the queue, so the next request collected it and every later reply
  was off by one. Now detected and the session is torn down, because unlike a refusal, a desync must
  cost the connection — nothing downstream could tell its answers had shifted.

**The countermeasure that works, unchanged:** for every regression test, break the code it guards and
confirm it goes red on the assertion you intended. Say in the commit that you did. Three of this
cycle's real defects were **defects in the plan itself**, written confidently and caught only
because someone tested the claim rather than the intent.

---

## 5. Conventions, extended

Everything in the previous handoff's §8 still applies. Additions:

- **Every test runs over both transports**, unless the scenario is genuinely transport-specific — in
  which case skip it explicitly, with a stated reason, and name what still covers the other side.
  There are now three such skips and each says why in the code.
- **A skip that says why beats a test that misfires.** Where a race could not be made deterministic,
  the test was removed and the reasoning recorded in a comment, rather than made wait-based and left
  wearing a name it no longer earned.
- **New unverified assumptions go into §12 first.** That list is the mechanism that catches
  documentation-derived guesses when a device arrives.
- **New evidence goes into `PROVENANCE.md`, scoped to exactly what it supports.** If one oracle
  produced nothing, say it produced nothing.

---

## 6. What is not implemented

| Area | Status | Notes |
|---|---|---|
| `data-record.md` — attendance logs | ✅ complete | all three dialects |
| `realtime.md` — live events | ✅ complete | subscription, both transports, no reconnect by design |
| `data-user.md` — users | ◐ read only | no create, delete, modify; no fingerprint, face, photo |
| `terminal.md` — device control | ✗ | **see §7** |
| `access.md` — access control | ✗ | door open, time zones, groups, unlock combinations |
| `ex_data.md` — bulk transfer variants | ✗ | |
| `other.md` | ✗ | SMS, workcodes |
| Clearing the attendance log | ✗ | deliberately omitted — destructive |
| ADMS / push | ✗ | a different protocol entirely |

The write-path warning from the previous handoff stands unchanged: **do not implement any write
path until a real device has been observed.** Getting a read wrong produces bad data you can throw
away; getting a write wrong changes state on a terminal people badge into every morning.

---

## 7. Recommended next scope, if hardware is not yet available

**The read half of `terminal.md`:** serial number, firmware version, platform, device name, and the
device parameters behind `CMD_OPTIONS_RRQ`.

**Why this one.** It is read-only, so it carries none of the risk in §6. It fits the existing
request-response shape exactly — no new transport work, no new architectural decisions, no
adjudications likely. And it is the piece that makes the *other* work verifiable: the compatibility
table in the README is empty, the device-report issue template asks a reporter for exactly these
fields, and §12 cannot be carried out on a device you cannot identify.

**What it will need:**

- A `getDeviceInfo()` — name it so it does not collide with the existing `getInfo()`, which returns
  storage counters and whose name is now slightly unfortunate.
- Parameter reads return strings keyed by name; the key set is model-dependent, so surface what the
  device returns rather than a fixed shape, and do not invent defaults for absent keys.
- Emulator support, which is a handler and a fixture — the cheapest task in this repo.
- Oracle capture: `zkteco-js` exposes `getSerialNumber`, `getDeviceName`, `getPlatform`, `getOS`
  and `getFirmware` as public methods — verified by reading them, since it is MIT. `pyzk`'s
  documented public API advertises equivalents, though that is from its documentation rather than
  from anything checked here, since its source may not be read. If both do register, this is a rare
  case where a byte-level comparison on **two** independent sources is available. Take it, and if
  only one produces evidence, scope the claim to one source the way the acknowledgment finding is.

**What is genuinely unknown:** which parameters a given firmware exposes, and whether absent ones
answer with an error or an empty value. Both go in §12.

**Do not** start access control (`access.md`) — door open is a write path, and an unlock command
sent wrong is the worst failure this library could have.

---

## 8. Outstanding items

Accepted rather than fixed, all recorded in the final review of v0.2. None blocks anything:

1. `Subscription`'s iterator has no `return()`, so breaking out of a `for await` leaves the socket
   listening until something calls `close()`. The README tells consumers to close in a `finally`.
2. A recorded UDP transport failure is sticky and never cleared, so one non-fatal datagram error
   permanently poisons that transport. This mirrors TCP deliberately, but a UDP error is not
   inherently terminal the way a TCP one is.
3. The desync teardown's guarantee is enforced by the transport rejecting on a null socket, not by
   `Session` itself — true for both shipped transports, but the invariant lives one layer below
   where the JSDoc states it.
4. A `Subscription` is constructed before `session.subscribe()` can fail, so failure paths orphan
   one. Harmless: the idle timer is off by default and `unref`'d when on.
5. The oracle fixture count guard still cannot notice a misfiled fixture whose packets are all
   `replyId === 0`. Carried over from v0.1.

**And one decision, not a task:** `package.json` says `0.2.0` and nothing has ever been published to
npm. The name is unclaimed. Whether to publish — and whether to publish a library that has never
touched hardware, with the README warning it currently carries — is the owner's call.

---

## 9. Sources

Unchanged from the previous handoff's §10. `adrobinoga/zk-protocol` carries no license, so it is
read for understanding and restated in our own words. `zkteco-js` is MIT and may be read freely.
**`pyzk` is GPL-2.0: execute it, never read it.** That boundary is not a formality — this library is
MIT and its first consumer is distributed software, so GPL-derived code here would carry copyleft
into that whole product. The Python virtual environment holding it is git-ignored and excluded from
the published package.

The realtime design spec at `docs/superpowers/specs/2026-08-28-zkteco-realtime-events-design.md` is
the binding authority for everything v0.2 added, and `PROVENANCE.md` is the record of what is
actually known versus assumed. Read §12 of the v0.1 spec before trusting any reading from a real
device.
