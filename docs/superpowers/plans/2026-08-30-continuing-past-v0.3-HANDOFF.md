# Handoff — continuing `zkteco-protocol` past v0.3

**Date:** 2026-08-30
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** v0.3 complete. 399 tests, 1 skipped. Zero runtime dependencies.
**Still not published to npm, and `main` is 23 commits ahead of `origin/main` — nothing is pushed.**

This continues `2026-08-29-continuing-past-v0.2-HANDOFF.md`, which continues
`2026-08-28-continuing-implementation-HANDOFF.md`. Both remain accurate about everything they
describe. Read them too — they are extended here, not superseded.

---

## 1. The one fact that should shape what you pick up next

**No physical ZKTeco device has ever been connected to this library.** True at v0.1, true at v0.2,
true today.

The first-hardware checklist in the v0.1 spec's §12 now has **twenty-two** items. Eight came from
this cycle — items 15 through 22. One of them — item 18 — exists because two reference implementations were found to
disagree about something the spec had assumed was settled, and the library now ships a choice
between them that no device has ever confirmed.

**Recommendation, unchanged and now stronger: getting a device is worth more than any feature you
could add.** v0.3 grew the checklist from fourteen items to twenty-two and shipped one genuine
protocol guess. §7
names what to do if hardware still is not available.

---

## 2. What v0.3 added

The read half of `terminal.md` — what a device says about itself.

```ts
const id = await device.getIdentity()
// { serialNumber, deviceName, platform, os, firmwareVersion } — each string | null

const params = await device.getParameters([DEVICE_PARAM.MAC, 'WorkCode'])
if ('WorkCode' in params) { /* the device answered */ }

const clock = await device.getTime()   // ZkNaiveTime, never a Date
```

The runtime export surface grew by exactly one name: `DEVICE_PARAM`, from eleven to twelve. A smoke
test asserts the list exactly.

### 2.1 The four-outcome contract, which is the point of the release

| What the device does | `getParameters` | `getIdentity` |
|---|---|---|
| answers `~OS=Linux` | key present, `'Linux'` | `os: 'Linux'` |
| answers `~OS=` | key present, `''` | `os: ''` |
| answers `ACK_ERROR` | key **absent** | `os: null` |
| times out, drops, frames badly, or answers `ACK_UNAUTH` | **throws** | **throws** |

Rows two and three are kept apart deliberately: which one a firmware uses for an unsupported
parameter is checklist item 16, and collapsing them would destroy the only signal that could answer
it.

**A `null` means the device answered and said no. It never means the read failed.** That sentence
is the whole design, and three of this cycle's findings were places where the code or the prose
failed to honour it.

### 2.2 Two changes beyond the original scope, both declared rather than slipped in

- **`readNulTerminated` decodes `latin1`, not `ascii`.** Node's `'ascii'` strips the high bit, so a
  non-ASCII device or employee name decoded to a plausible-looking wrong string with no way back to
  the bytes. This is a **behaviour change on the published surface** for `ZkUser.name` and
  `ZkUser.userId`; on a pure-ASCII device the output is byte-identical to v0.2. latin1 is
  byte-preserving, so `Buffer.from(value, 'latin1')` recovers exactly what the device sent.
- **`getParameters` returns a null-prototype object.** With a plain `{}`, `'toString' in result` was
  true for a key the device never answered, contradicting the presence idiom the README teaches, and
  `result['__proto__'] = value` was a silent no-op that dropped a real value. Accepted cost:
  `result.hasOwnProperty(k)` throws. Use `key in result` or `Object.hasOwn(result, key)`.

---

## 3. What the evidence actually says

`PROVENANCE.md` is the authority. Three things are worth restating because they are easy to get
wrong from memory.

### 3.1 The oracles disagreed, and the library ships a guess

`pyzk` sends the `CMD_OPTIONS_RRQ` keyword **NUL-terminated**, on both transports. `zkteco-js` sends
it **bare**, on TCP — and produces **zero** such packets on UDP, because its parameter and firmware
methods have no UDP callback and throw before touching the socket. (`CMD_GET_TIME` is the exception:
it has a real UDP implementation, so zkteco-js does reach the clock command on UDP.)

The decision rule was fixed before the capture and its disagree branch says to implement the form a
device tolerating either would accept. **The library sends the NUL-terminated form.** The reasoning,
stated at its real strength:

- Both libraries run against real hardware in the field, so devices evidently *tolerate* a trailing
  NUL rather than reject it. This is the tiebreaker.
- Taken alone that argument is symmetric — it shows each form works on the devices its own users
  own, not that NUL is the superset. Superset-ness rests entirely on parser speculation: under
  `strcmp(buf, kw)` the NUL is required and bare works only if the buffer happens to be zero-padded;
  under `memcmp(buf, kw, payload_len)` the NUL fails and bare works. **The losing case is real and
  is not ruled out.**

**If this choice is wrong, the symptom is quieter than it looks.** `getIdentity()` returns *four*
nulls and a real `firmwareVersion` — `CMD_GET_VERSION` carries an empty payload and is untouched by
the decision. Four nulls plus a firmware string reads as "this firmware exposes its version but no
parameters", a plausible device profile, and is **indistinguishable from the answer checklist item
16 exists to collect**. So on first hardware: rule out a request-shape mismatch before logging
anything as an item-16 answer. Reverting is one line in `src/codec/params.ts` plus two dependent
test edits.

### 3.2 The reply-id claim was narrowed, not reversed

`zkteco-js` **does** implement the reply-id quirk — it checksums over `replyId`, then overwrites the
field with `replyId + 1` — and its checksum formula is systematically one lower than the standard
one's complement. The two errors cancel exactly, for any payload. Measured on the committed
fixtures, both readings give 64534.

The v0.1 adjudication **stands**: both readings collapse to the same predicate on the wire, which is
what a device sees and what this library emits. `Session.send` is unchanged and `applyReplyIdQuirk`
remains unused and unexported. What changed is the wording — zkteco-js corroborates the **bytes**, by
a different internal route, rather than independently deriving the **rule**.

### 3.3 The odd-length checksum branch now has external evidence — from one oracle

`checksum16`'s trailing-odd-byte branch had never been checked against anything but this library's
own arithmetic, despite already carrying `CMD_PREPARE_BUFFER` on the main bulk-read path since v0.1.
The params capture closed that: six odd-length packets, all six matching.

**But only zkteco-js's four can ever discriminate.** pyzk's two odd packets end in pyzk's own NUL
terminator, so padding and dropping are arithmetically identical there. The pin is real and it rests
on one oracle. `PROVENANCE.md` says so; keep it saying so.

---

## 4. Traps that cost real time this cycle

The previous handoffs named one defect shape — **code, a test, or a comment that reports success
while proving less than it appears to.** It appeared nine times in v0.1, five in v0.2, and **six more
in this cycle.** It has still never once been caught by the test suite.

What is new, and worth internalising: **every single instance this cycle originated in the plan, not
in an implementer.** Nine implementers transcribed faithfully; what was wrong was what they were
given.

- **A test named for `tryExecute` that never called it.** It drove `session.open()` against a silent
  emulator, so it timed out at the handshake and the method under test was structurally unreachable.
  It stayed green with the guarded property deliberately broken.
- **A test titled "…and refuses both when unconfigured" that exercised neither refusal.**
- **A doc comment promising that `in` answers exactly "did the device answer this"** — untrue for any
  key colliding with an `Object.prototype` member name.
- **A spec sentence claiming the capture pinned the odd-byte branch** when the test asserted only
  that odd packets existed.
- **A licensing passage saying pyzk was driven "in exactly one way" by "a nine-line script"** that an
  independent reviewer had audited — accurate at v0.1, stale from v0.2, and there are now three
  drivers.
- **A comment that a previous release made true and this one made false**: `events.ts` justified
  avoiding `readNulTerminated` because it masked the high bit, which stopped being so the moment the
  decoder moved to latin1.

**The countermeasure still works and is still the only thing that catches these:** break the code a
test guards, confirm it goes red *on the assertion you intended*, and say in the commit that you did.

**Two structural lessons.** First: scan the whole plan for this shape *before* execution starts — one
pre-emptive pass over the remaining briefs found a third instance and saved a fix round. Second, and
this is the one to carry: **per-task review structurally cannot see cross-task defects.** Two of the
three findings in the final whole-branch review spanned files that no single task touched together;
one spanned three releases. Consider a standing whole-branch pass that re-reads every claim a
*previous* release made about a file this release touches.

---

## 5. Conventions, extended

Everything in the previous handoffs applies. Additions:

- **A guard test must assert the guard's own message, not just its class.** The transport throws
  `ZkConnectionError` one layer down, so a class-only assertion passes with the guard deleted —
  demonstrated live this cycle when deleting the check produced `"this transport is listening for
  events; receive() is not available"` instead of the guard's own text.
- **Checklist items are duplicated between the v0.1 spec's §12 and each release's own §12.** That is
  the established convention, and it drifts: this cycle an item-18 sentence landed in one copy and
  not the other, and was caught only by accident. When you touch one copy, diff the other.
- **An absence must be visible as an absence, at the point where a reader would otherwise assume
  presence.** Recording zkteco-js's UDP zero elsewhere was not enough; it had to sit beside pyzk's
  dual-transport claim, or the asymmetry read as agreement.

---

## 6. What is not implemented

| Area | Status | Notes |
|---|---|---|
| `data-record.md` — attendance logs | ✅ complete | all three dialects |
| `realtime.md` — live events | ✅ complete | no reconnect, by design |
| `terminal.md` — device control | ◐ read only | identity, parameters, clock. **No writes.** |
| `data-user.md` — users | ◐ read only | no create/delete/modify; no fingerprint, face, photo |
| `access.md` — access control | ✗ | door open, time zones, groups |
| `ex_data.md` — bulk transfer variants | ✗ | |
| `other.md` | ✗ | SMS, workcodes |
| Clearing the attendance log | ✗ | deliberately omitted — destructive |
| ADMS / push | ✗ | a different protocol entirely |

The write-path prohibition is unchanged and absolute: **do not implement any write path until a real
device has been observed.** A wrong read produces data you can throw away; a wrong write changes
state on a terminal people badge into every morning.

---

## 7. Recommended next scope, if hardware is not yet available

**First choice: extend the `ACK_UNAUTH` guard to the three older reads.** v0.3 introduced a real
inconsistency and it is the cheapest thing on this list to fix.

`getIdentity`, `getParameters` and `getTime` all reject a reply that acknowledges nothing.
`getInfo`, `getUsers` and `getAttendanceLogs` — shipped in v0.1 — do not. `getInfo` will happily
decode storage counters out of an `ACK_UNAUTH` body long enough to pass its length check. That is
the same collapse v0.3 closed, still open in the older half of the library, and now visibly
asymmetric to anyone reading `src/commands/`.

Keep the same scoping discipline: `ACK_UNAUTH` only. **Do not tighten to "only `ACK_OK` counts"** —
nothing confirms real firmware acknowledges these commands with `ACK_OK` rather than `ACK_DATA`, and
inventing that constraint would be exactly the kind of unevidenced hypothesis this project refuses.

**Second choice: harden the stale-reply path (checklist item 22).** `TcpTransport.receive` clears its
waiter on timeout, so a late reply queues and the *next* `receive()` collects it as its own. A
consumer that catches `ZkTimeoutError` and retries has roughly five times the exposure with
`getIdentity` that it had with `getInfo`. On the parameter path the echo guard makes this loud — the
strongest argument for that guard existing. `readFirmware` and `getTime` have no equivalent, and
`decodeZkTime` turns any four bytes into a plausible date.

The library already carries the reply id needed to detect a mismatch. **But tread carefully**: reply-id
semantics are precisely what §5.1's adjudication settled, and a change there interacts with it.
Write the decision rule down first, as the two previous adjudications did.

**Do not** start access control, and do not start reading biometric templates. The first is a write
path. The second is read-only but handles biometric data, which deserves its own design pass on
privacy and storage before a line of it is written.

---

## 8. Outstanding items

Accepted rather than fixed. None blocks anything.

1. **`getInfo`, `getUsers`, `getAttendanceLogs` do not guard `ACK_UNAUTH`** — see §7, first choice.
2. **`classifyChecksum` tests `'ambiguous'` before comparing to the transmitted checksum**, so a
   future fixture with `replyId === 0` and an odd length would classify ambiguous and fail the new
   odd-length assertion spuriously. No current packet hits it, and the failure direction is loud.
3. The oracle fixture count guard still cannot notice a misfiled fixture whose packets are all
   `replyId === 0`. Carried from v0.1.
4. `Subscription`'s iterator has no `return()`. Carried from v0.2.
5. A recorded UDP transport failure is sticky and never cleared. Carried from v0.2.
6. The desync teardown's guarantee is enforced one layer below where its JSDoc states it. Carried
   from v0.2.

**And two decisions, not tasks.** `package.json` says `0.3.0`, nothing has ever been published to
npm, and the name is unclaimed — whether to publish a library that has never touched hardware is the
owner's call. Separately, **`main` is 23 commits ahead of `origin/main` and nothing has been pushed**;
the spec, the plan and all of v0.3 exist only locally.

---

## 9. Sources

Unchanged. `adrobinoga/zk-protocol` carries no license — read for understanding, restate in our own
words. `zkteco-js` is MIT and may be read freely; reading it is what surfaced both the compensating
checksum errors in §3.2 and the TCP-only wiring in §3.1. **`pyzk` is GPL-2.0: execute it, never read
it.** Three driver scripts now call it, all through public API probed with `getattr`, with absences
reported rather than assumed; `PROVENANCE.md` enumerates them.

The binding authority for everything v0.3 added is
`docs/superpowers/specs/2026-08-29-zkteco-terminal-read-design.md`, and `PROVENANCE.md` records what
is known versus assumed. Read §12 of the v0.1 spec — all twenty-two items — before trusting any
reading from a real device.
