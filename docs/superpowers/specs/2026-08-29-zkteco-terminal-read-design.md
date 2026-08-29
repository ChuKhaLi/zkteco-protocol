# zkteco-protocol — Terminal Read Design Spec (v0.3)

**Date:** 2026-08-29
**Status:** Approved — ready for implementation planning
**Builds on:** `2026-08-28-zkteco-protocol-library-design.md` (v0.1) and
`2026-08-28-zkteco-realtime-events-design.md` (v0.2). Both remain the binding authority for
everything they cover. This document adds three read commands and changes one shared decoder.
**Handoffs consulted:** `../plans/2026-08-29-continuing-past-v0.2-HANDOFF.md`, which extends
`../plans/2026-08-28-continuing-implementation-HANDOFF.md`. Neither is superseded.

---

## 1. Purpose

Read what a device says about itself: serial number, device name, platform, operating system,
firmware version, its arbitrary named parameters, and its clock.

### 1.1 Why this scope, with no hardware

**No physical ZKTeco device has ever been connected to this library.** That was true at v0.1, true
at v0.2, and true today. It is the fact that chose this scope.

Every remaining unimplemented area of the protocol is either a write path — creating users, setting
the clock, opening a door — or a bulk-transfer variant. A read that is wrong produces data you can
throw away; a write that is wrong changes state on a terminal people badge into every morning. So
no write path is implemented here, and none should be until §12 has been carried out against real
hardware.

This scope is also the one that makes the *rest* of the project verifiable. The compatibility table
in the README is empty. The device-report issue template asks a reporter for a model and a firmware
version. The first-hardware checklist cannot be carried out on a device you cannot identify. Every
one of those wants exactly the fields this document specifies.

---

## 2. Scope

### 2.1 In scope for v0.3

- `ZkDevice.getIdentity()` — serial number, device name, platform, OS, firmware version.
- `ZkDevice.getParameters(keys)` — read arbitrary named device parameters.
- `ZkDevice.getTime()` — the device's own clock, as a `ZkNaiveTime`.
- `DEVICE_PARAM` — the observed set of well-known parameter keywords.
- Emulator support for all three commands, including refusals, empty values, and a wrong echo.
- Oracle capture for the request shape, adjudicated under a rule written before the capture.
- A shared-decoder change: `readNulTerminated` decodes `latin1` rather than `ascii` (§5.3).

### 2.2 Explicitly out of scope for v0.3

- **Every write path**, without exception. `CMD_OPTIONS_WRQ`, `CMD_SET_TIME`, restart, power off,
  sleep, door open, user create/delete/modify. Not deferred for effort — deferred for risk.
- Fingerprint, face, and photo templates.
- Access control (`access.md`) in any form. An unlock command sent wrong is the worst failure this
  library could have.
- Clearing the attendance log. Destructive, and deliberately absent since v0.1.
- Interpreting parameter *values*. A value is returned as the string the device sent. This library
  does not know that `WorkCode=1` means the feature is on.

---

## 3. Architecture

### 3.1 Modules

Two new files. Dependency direction is unchanged: `ZkDevice → commands → session → transport`, with
`codec` a leaf that everything may use.

```
src/codec/params.ts       pure: encode a keyword request, decode a key=value reply
src/commands/device.ts    getIdentity, getParameters, getTime — round-trip orchestration
```

`codec/params.ts` is pure — no I/O, no async, no `Session`. That is not tidiness: purity is what
makes byte-level oracle comparison expressible at all, and it is the invariant that has held since
v0.1. Parsing `~SerialNumber=ABC\0` is exactly the sort of byte-level rule an oracle should pin, so
it belongs in `codec`, not inlined in a command.

`commands/device.ts` sits alongside `attendance.ts`, `info.ts` and `users.ts` and follows their
shape. It deliberately does **not** go into `info.ts`: that file serves `CMD_GET_FREE_SIZES` and
its storage counters, and the v0.2 handoff already records that the name `getInfo` is "now slightly
unfortunate". Adding device identity to it would make an existing naming problem worse.

Three constants join the `CMD` table: `OPTIONS_RRQ: 11`, `GET_TIME: 201`, `GET_VERSION: 1100`.

### 3.2 `Session` gains `tryExecute`, and why a `catch` would not do

`Session.execute()` throws `ZkProtocolError` on `ACK_ERROR`. A device refusing one parameter
keyword is a normal, expected answer in this scope — §12 records that which keywords a firmware
exposes is unknown — so a refusal must be readable, not thrown.

The obvious implementation is to wrap the call in a `try`/`catch` on `ZkProtocolError`. **That is
rejected.** Catching by class there would also swallow a genuine protocol error raised anywhere
below, and turn it into a `null` field. That is precisely the defect shape both handoffs name:
code that reports success while proving less than it appears to. It appeared nine times in v0.1 and
again in v0.2, and it has never once been caught by the test suite.

Instead `Session` gains an internal `tryExecute(command, data)` that returns the decoded packet
without throwing on `ACK_ERROR`, and `execute()` becomes a thin wrapper over it that throws. The
decision about what an `ACK_ERROR` means then lives at the call site, where the semantics are
known, and nothing is caught by class. `tryExecute` is internal: `Session` is not exported, so this
costs nothing on the public surface.

### 3.3 Five sequential round trips, and why they cannot be concurrent

`getIdentity()` issues four `CMD_OPTIONS_RRQ` requests and one `CMD_GET_VERSION`. These run
strictly one after another.

This is a constraint, not a preference. `Transport` rejects two concurrent `receive()` calls
outright — a guard added in v0.1 after overlapping receives were found to misroute replies and
report a spurious timeout. Nothing in this scope is worth reopening that.

A consumer who needs only the serial number calls `getParameters(['~SerialNumber'])` and pays for
one round trip. `getIdentity()` is the convenience, not the primitive.

---

## 4. Public API

```ts
class ZkDevice {
  getIdentity(): Promise<ZkDeviceIdentity>
  getParameters(keys: readonly string[]): Promise<Record<string, string>>
  getTime(): Promise<ZkNaiveTime>
}

interface ZkDeviceIdentity {
  /** null means the device REFUSED this keyword. Never "not read", never "the wire broke". */
  serialNumber: string | null
  deviceName: string | null
  platform: string | null
  os: string | null
  /** Read with CMD_GET_VERSION, not as a parameter. See §5.5. */
  firmwareVersion: string | null
}

/**
 * Well-known parameter keywords. An OBSERVED list, not a contract — see §4.3.
 * Declared `as const`, so DEVICE_PARAM.SERIAL_NUMBER has the literal type
 * '~SerialNumber' rather than widening to string.
 */
const DEVICE_PARAM: {
  readonly SERIAL_NUMBER: '~SerialNumber'
  readonly DEVICE_NAME: '~DeviceName'
  readonly PLATFORM: '~Platform'
  readonly OS: '~OS'
  // ...and the remaining keywords listed in §A.2
}
```

All three methods go through `requireIdleSession()` and throw while a realtime subscription is
active, exactly as `getInfo`, `getUsers` and `getAttendanceLogs` do. One `ZkDevice`, one mode.

The runtime export list grows by exactly one name — `DEVICE_PARAM` — from eleven to twelve. Types
do not exist at runtime and the three methods hang off `ZkDevice`, so nothing else is added. The
smoke test that asserts the export list exactly is updated to twelve and to `VERSION = '0.3.0'`.

### 4.1 `getIdentity()`, not `getDeviceInfo()` — a deviation from the handoff

The v0.2 handoff §7 suggests naming this `getDeviceInfo()`, with the constraint that it must not
collide with the existing `getInfo()`. The name is changed, and that constraint is the reason.

`ZkDeviceInfo` already exists and means storage counters. Following the suggested name would give:

```
getInfo()       → ZkDeviceInfo       // storage counters
getDeviceInfo() → ZkDeviceIdentity   // ...identity
```

A method named `...DeviceInfo` returning `Identity`, while the method named `getInfo` returns
`DeviceInfo`, is a trap rather than a near-miss. `getIdentity()` satisfies the handoff's actual
constraint better than the name the handoff proposed, and pairs cleanly with its return type.

### 4.2 Three device answers, four caller outcomes

The distinction below is the core of this design and the reason the scope is worth doing.

| What the device does | `getParameters` | `getIdentity` |
|---|---|---|
| answers `~OS=Linux` | key present, `'Linux'` | `os: 'Linux'` |
| answers `~OS=` (empty value) | key present, `''` | `os: ''` |
| answers `ACK_ERROR` | key **absent** | `os: null` |
| times out, drops, or frames badly | **throws** | **throws** |

Rows two and three are kept apart deliberately. §12 records that whether an unsupported parameter
answers with an error or an empty value is unknown. Collapsing the two would destroy the only
signal by which a real device report could ever answer that question.

Row four is the one that matters most. A `getIdentity()` that swallowed five failures and returned
five nulls would be indistinguishable from a device that exposes nothing at all, and would be green
in every test that did not specifically look for it. A transport failure propagates. This is pinned
by a test in §7.2 that is verified by breaking the code it guards.

Absent keys are omitted from the returned object rather than set to `undefined`, so `in` answers
the exact question "did the device answer this", and no default is invented for a key the device
refused.

### 4.3 `DEVICE_PARAM` is an observed list, not a contract

The keyword set is model-dependent and firmware-dependent. `DEVICE_PARAM` exists so a consumer can
write `DEVICE_PARAM.SERIAL_NUMBER` instead of retyping the string, and so this project has one
place recording which keywords have ever been seen.

Its JSDoc says plainly that membership is not a promise that any given device exposes the keyword,
and `getParameters` accepts any string, not only these. This follows the `EVENT_FLAG` precedent
from v0.2: a named constant for discoverability, with the uncertainty stated rather than implied
away.

### 4.4 `getTime()` returns `ZkNaiveTime`, never a `Date`

v0.1 §2.3 is unchanged and applies here with full force. The device reports naive local time with
no offset; a `Date` would bind it to the decoding process's timezone — right by accident on a
machine near the device, hours wrong in CI, silent either way.

`getTime()` reuses `decodeZkTime`, which already implements the packed-uint32 pseudo-calendar. No
new type, no new codec. The MIT reference implementation consulted for the command number returns
`new Date(...)` here; that is exactly the trap §2.3 rejects, and it is not followed.

The 31-day pseudo-calendar consequence carries over unchanged: a device clock can legitimately
decode to `2026-02-31`, and that is returned verbatim rather than slid to 3 March.

---

## 5. Codec: risk areas and guards

### 5.1 The reply must echo the keyword that was requested

A reply body is the keyword, an `=`, then the value, optionally NUL-padded.
`decodeParamReply(keyword, body)` verifies the echoed keyword matches the one requested and throws
`ZkProtocolError` when it does not.

This guard exists because the alternative is fabricating an identity. The MIT reference
implementation parses by replacing the `keyword=` prefix with an empty string, which — when the
echo does not match — silently returns the entire body as the value. A device that answered a
`~DeviceName` request with a `~Platform` reply would have its platform returned as its device name,
under a field name that says otherwise, with no error anywhere. v0.1 §2.5 already settled the
principle: an identity is never fabricated.

Whether real devices echo at all is a documentation-derived assumption. It goes into §12. If a
device does not echo, this library throws rather than guesses, and the checklist item says so.

### 5.2 Split on the first `=`, and stop at the first NUL

A value may itself contain `=`, so the split takes the **first** separator only and the remainder
is the value verbatim. A body with no `=` at all is a `ZkProtocolError`, not a value.

Trailing NUL padding is truncated at the first NUL, matching the existing `readNulTerminated`
policy. An empty value after the separator is `''` and is a legitimate answer, not an error — see
§4.2.

### 5.3 `latin1`, not `ascii` — a deliberate behaviour change

`readNulTerminated`, shared by `ZkUser.name` and `ZkUser.userId`, decodes with `.toString('ascii')`.
In Node, `'ascii'` is latin1 **with the high bit stripped**. A device name or an employee name
outside ASCII currently returns a well-typed, plausible-looking, wrong string, with no way to
recover the original bytes and nothing anywhere reporting an error.

That is the same defect family this project has been catching since v0.1, and the new code decodes
strings from the same devices. Rather than replicate it, `readNulTerminated` switches to `latin1`
and the new parameter decoding uses it too.

| | ASCII device | non-ASCII device | original bytes recoverable |
|---|---|---|---|
| `ascii` (today) | correct | **silently wrong** | no |
| `latin1` (chosen) | correct | mojibake | **yes** — `Buffer.from(s, 'latin1')` |
| `utf8` | correct | correct if UTF-8, **lossy** (U+FFFD) otherwise | no |

The trade-off, stated rather than buried: this is a **behaviour change on the published surface**
for `ZkUser.name` and `ZkUser.userId`. On a pure-ASCII device — very likely most — the output is
byte-for-byte identical to today, so the blast radius is small. On any other device, "silently
wrong" becomes "looks odd, and the exact bytes are one call away".

It is also why `ZkDeviceIdentity` carries no `raw` field: latin1 is byte-preserving, so a `raw`
would be redundant with the string it accompanies. Which encoding a device actually uses goes into
§12; `latin1` is the decoding that keeps that question answerable.

### 5.4 The odd-length checksum branch has never had external evidence

Every oracle fixture captured so far — across the root, `commkey/` and `realtime/` directories
alike — carries an even-length payload. The distinct lengths are exactly eight and twelve. So the
trailing-odd-byte branch of `checksum16` has never been exercised by any external evidence; it
rests solely on this library's own unit tests and its own emulator, which computes checksums with
the very function under test.

This is **not** a new exposure. `readBulkBuffered` already sends an eleven-byte body for
`CMD_PREPARE_BUFFER`, a nineteen-byte payload, and that is on the main bulk-read path for both
users and attendance. The branch is load-bearing today and always has been; it simply happens that
no oracle ever sent an odd-length request, because neither reference implementation exercises the
buffered read.

What this scope changes is that the gap becomes **closable**. `~SerialNumber` is thirteen bytes, so
`zkteco-js`'s bare payload for it is twenty-one — odd-length; `pyzk`'s NUL-terminated form makes
that one even (twenty-two) instead, but `~ZKFPVersion`, at twelve bytes, becomes thirteen once
`pyzk` appends its terminator, so `pyzk` contributes an odd-length packet of its own. Unlike
`CMD_PREPARE_BUFFER`, both oracles do issue this request, and both land on an odd-length payload
somewhere in the capture.

`test/oracle/params.spec.ts` reconstructs each odd-length packet's payload and asserts
`checksum16` reproduces the checksum the sending oracle actually transmitted (via
`classifyChecksum`, which returns `'self'` only when it does). That is what makes the pin real
rather than nominal: six odd-length packets across both oracles, all six matching `checksum16`.
The capture therefore pins the odd-byte branch against an independent implementation for the
first time in the project's life, and it retroactively covers a path v0.1 shipped on faith.

§12 records separately that no *device* has confirmed it either. An oracle agreeing is not a
terminal agreeing.

### 5.5 Firmware is not a parameter

`CMD_GET_VERSION` (1100) takes an empty payload and answers with the firmware string as the whole
body: no keyword, no `=`, no echo to verify. It shares nothing with the parameter path except that
both produce a string.

`getIdentity()` therefore has two code paths, not one, and `getParameters` cannot reach firmware.
This is stated because it is the kind of asymmetry that invites a later refactor to "unify" the two
and quietly apply the echo guard to a reply that has no echo.

---

## 6. Transport and session

Nothing in the transport layer changes. Every command in this scope is an ordinary
request-response exchange over the existing `Session`, on either transport, with the existing
per-request deadline.

The only session change is `tryExecute` (§3.2), which is additive and internal.

---

## 7. Testing

Every test runs over **both transports** unless the scenario is genuinely transport-specific — in
which case it is skipped explicitly, with a stated reason in the code, naming what still covers the
other side. Three such skips exist today and each says why.

### 7.1 Emulator

Three handlers and four options:

```ts
params?: Record<string, string>   // keyword -> value; a keyword not present answers ACK_ERROR
firmware?: string | null          // null answers ACK_ERROR to CMD_GET_VERSION
deviceTimeRaw?: number            // the packed uint32, supplied directly
paramEchoOverride?: string        // make the reply echo a DIFFERENT keyword, to test the guard
```

`deviceTimeRaw` takes a raw uint32 on purpose. This library has no time *encoder* and does not need
one; a test supplies a fixed packed value and asserts the decoded fields. That sidesteps the
round-trip-proves-itself problem entirely, and `decodeZkTime` is already pinned independently in
`test/codec/time.spec.ts`.

Following the precedent set by `encodeFreeSizes` and `eventPacket`, the new handlers carry a
comment stating plainly that the emulator formats its replies using **this library's own**
convention, so a test that only round-trips through it proves the plumbing, not the layout a real
device emits. The v0.2 handoff asks that this be said each time; it is said again.

### 7.2 Required scenarios

Pure codec (`test/codec/params.spec.ts`):

1. Encodes a keyword request with a single trailing NUL terminator and no length prefix — the
   form the disagreement in §8.1/PROVENANCE.md §4 settled on, not the bare form this document
   originally assumed before the capture.
2. Decodes a well-formed reply to its value.
3. Truncates at the first NUL.
4. Splits on the **first** `=` when the value contains another.
5. Returns `''` for an empty value, and does not confuse it with a refusal.
6. Throws `ZkProtocolError` when the echoed keyword does not match the request.
7. Throws `ZkProtocolError` on a body with no `=` at all.
8. Round-trips non-ASCII bytes through `latin1` without loss.

Through the emulator, both transports (`test/commands/device.spec.ts`):

9. `getIdentity()` returns all five fields on a device that answers everything.
10. One refused keyword yields `null` for that field only; the other four survive intact.
11. An empty value yields `''`, distinguishable from the `null` in scenario 10.
12. **A timeout propagates and does NOT become `null`.** The single most important test in this
    scope.
13. A mismatched echo throws, and the error names the keyword that was requested.
14. `getParameters` omits refused keys entirely, so `in` answers the right question.
15. `getParameters([])` sends nothing and returns `{}`.
16. `getTime()` decodes a known packed value to known fields.
17. `getIdentity()` on a device that refuses everything returns five nulls — this test exists
    specifically so scenario 12's assertion cannot be satisfied by accident.

Guards (`test/ZkDevice.spec.ts`):

18. All three methods throw while subscribed, asserting **the guard's own message**, not just its
    class. The v0.2 handoff records a guard test that passed with the guard deleted, because the
    transport throws the same class one layer down; that mistake is not repeated.

Surface and evidence:

19. `test/smoke.spec.ts` asserts twelve runtime exports and `VERSION === '0.3.0'`.
20. `test/oracle/params.spec.ts` adjudicates the request shape against the new fixtures (§8).
21. A user record carrying a non-ASCII name survives `latin1` and its bytes are recoverable — a
    test that is impossible to write today.

### 7.3 New fixtures go in a subdirectory, and this is not a detail

`test/oracle/fixtures.spec.ts` scans every `*.json` **directly under** `test/fixtures/oracle/` and
asserts an exact count of fourteen discriminating packets for the reply-id adjudication. New
fixtures written to that directory would silently change a number that test pins on purpose.

They go in `test/fixtures/oracle/params/`, exactly as `commkey/` and `realtime/` already do, and
for exactly the same reason.

### 7.4 The countermeasure

For every regression test in this scope: break the code it guards, confirm it goes red **on the
intended assertion** rather than collaterally, and say in the commit that this was done.

Scenario 12 is named explicitly. Verify it by widening `tryExecute` to catch broadly and confirming
the test turns red. Three of v0.2's real defects were defects in the plan itself, written
confidently and caught only because someone tested the claim rather than the intent.

---

## 8. Evidence

### 8.1 The decision rule, written before the capture

**Question:** does `CMD_OPTIONS_RRQ` carry the keyword as a bare string payload — no NUL
terminator, no length prefix?

**Rule, fixed before any capture is taken:**

- Both oracles send the same form → implement that form.
- They disagree → record both figures in `PROVENANCE.md`, implement the form a device tolerating
  either would accept, and add a §12 item.
- Only one produces evidence → **scope the claim to that one source**, exactly as the comm-key
  finding is scoped.
- One never reaches the command → record that it produced **nothing**, not that it agreed. This is
  the disposition the acknowledgment adjudication established in v0.2, and it is not softened here.

### 8.2 What each oracle can and cannot confirm

Two constraints were established by reading the MIT source before writing this spec, so that
neither is discovered late:

**`zkteco-js` can offer TCP evidence only for the parameter reads.** Every one of its
device-parameter methods, and its firmware read, calls `functionWrapper` with a TCP callback and no
UDP callback. On a UDP connection it throws before touching the socket, so the UDP side of
`CMD_OPTIONS_RRQ` and `CMD_GET_VERSION` will be recorded as no evidence.

**`CMD_GET_TIME` is the exception, and it is worth taking.** `getTime` is one of the few methods
wired for both transports, with a real UDP implementation behind it. So this scope can obtain
zkteco-js evidence on **both** transports for the clock read, and on TCP only for the other two.
The capture is arranged to collect that rather than assume the parameter limitation applies
uniformly, and `PROVENANCE.md` records the two cases separately.

**`zkteco-js` cannot discriminate the reply format at all.** Its parser replaces the `keyword=`
prefix with an empty string, which returns the entire body unchanged when that prefix is absent. A
reply of `XYZ` and a reply of `~SerialNumber=XYZ` both yield `XYZ`. So its running successfully
proves nothing whatever about the reply layout. It is evidence about the **request shape**, and
`PROVENANCE.md` will say so in those words rather than let a green run look like confirmation.

**`pyzk` remains black-box.** GPL-2.0: executed, never read. Its driver script calls only publicly
documented methods and records what actually happens — including an `AttributeError` if a method
does not exist. An absence is recorded as an absence.

### 8.3 A scoped correction to the reply-id provenance

Reading the `zkteco-js` header builder while scoping this work surfaced something the v0.1
adjudication did not account for. It is recorded here because `PROVENANCE.md` is meant to state
what is known rather than what is convenient.

`zkteco-js` **does** implement the reply-id quirk: it computes the checksum over `replyId`, then
overwrites the field with `replyId + 1`. Separately, its checksum formula subtracts one more than
the standard one's complement does, so its result is systematically one lower. Incrementing
`replyId` raises the word sum by one and so lowers a standard checksum by one. **The two errors
cancel exactly, for any payload.**

Measured on the committed fixtures, both readings produce the identical number:

```
transmitted: replyId=1, checksum=64534
  zkteco-js's own formula over replyId-1 ....... 64534
  standard one's complement over replyId ....... 64534
```

**This does not overturn the v0.1 adjudication.** Both readings collapse to the same predicate on
the wire — the checksum equals the one's complement of the packet as transmitted — which is what a
device sees and what this library emits. `Session.send` stays unchanged and `applyReplyIdQuirk`
stays unused, uncalled, and unexported.

What it does change is the strength of the wording. `PROVENANCE.md` describes the finding as
resting on two independent implementations. For the `zkteco-js` half that overstates the
independence: it agrees on the **bytes**, by a different internal route, not on the **rule**. The
provenance entry is narrowed to say so. The claim survives; the phrasing was doing more work than
the data supported, which is the same correction the final review of v0.1 made to a different
sentence.

---

## 9. Errors

No new error class. The published taxonomy stays as v0.1 shipped it.

- A device refusing a keyword is **not** an error: a `null` field, or an absent key (§4.2).
- A malformed reply — no `=`, or an echo that does not match — is `ZkProtocolError`.
- An `ACK_UNAUTH` reply is `ZkProtocolError`. It is the one non-acknowledgment code this codebase
  already assigns a meaning to (`Session.open` handles it during the comm-key handshake), so it
  cannot be a genuine parameter or firmware reply under any reading, and it is never decoded as
  one.
- A timeout is `ZkTimeoutError`, a dropped connection `ZkConnectionError`.
- Calling any of the three while subscribed is `ZkConnectionError`, with the guard's own message.

**`ACK_ERROR` is the only outcome that becomes a `null` field.** Every other failure — malformed
reply, `ACK_UNAUTH`, timeout, dropped connection, framing error — propagates out of `getIdentity()`
and `getParameters()` unchanged, abandoning the remaining round trips. There is no partial result
and no salvage, per v0.1 §2.4.

**This is not a claim that `ACK_OK` is the only acknowledgment a real device sends for these
commands.** `getParameters` and `readFirmware` branch only on `ACK_ERROR` and `ACK_UNAUTH`; any
other reply command is accepted and decoded as the answer. Tightening that to "only `ACK_OK`
counts" is deliberately not done: nothing confirms real firmware acknowledges `CMD_OPTIONS_RRQ`
with `ACK_OK` rather than, say, `ACK_DATA`, and inventing that constraint would itself be an
unevidenced hypothesis. `ACK_UNAUTH` is singled out because it is the only non-acknowledgment code
with an established meaning in this codebase — not because it is the only one that could exist.

The boundary is worth stating in one sentence, because it is the whole design: a `null` means the
device answered and said no. It never means this library failed to ask.

---

## 10. Deviations from the handoff

1. **`getIdentity()` rather than `getDeviceInfo()`** (§4.1). The handoff's constraint was
   non-collision with `getInfo()`; the name it proposed collides in a worse way than the one
   chosen.
2. **`getTime()` is included**, which the handoff's §7 list does not name. It is read-only, reuses
   an existing decoder, adds no type, and explains the most likely field complaint about attendance
   timestamps — device clock drift. `setTime` remains firmly out of scope.
3. **`readNulTerminated` changes behaviour** (§5.3). Not in the handoff's scope at all. Included
   because the new code decodes strings from the same devices, and the alternative was to replicate
   a known defect for the sake of consistency with it.

---

## 11. Definition of done for v0.3

- `getIdentity`, `getParameters` and `getTime` implemented, over both transports.
- All twenty-one scenarios in §7.2 pass, each verified by breaking what it guards.
- `pnpm test` and `pnpm typecheck` clean; CI green on Node 20.19/22/24 across Ubuntu and Windows.
- Runtime export list is exactly twelve names; the smoke test asserts it.
- Zero runtime dependencies — `"dependencies": {}` still literally empty.
- Oracle fixtures captured into `test/fixtures/oracle/params/`, with the §8.1 rule followed and the
  outcome recorded whichever way it went.
- `PROVENANCE.md` updated: the params evidence, and the §8.3 narrowing.
- §12 of the v0.1 spec extended with items 15–21.
- README documents the three methods and the `latin1` change; the compatibility table stays empty,
  because it is still accurate.
- `.github/ISSUE_TEMPLATE/device-report.yml` gains serial, platform and OS fields.
- `package.json` at `0.3.0`. Publication to npm remains a separate decision, unmade.

---

## 12. Additions to the first-hardware checklist

Appended to §12 of `2026-08-28-zkteco-protocol-library-design.md` as items 15–21.

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

---

## Appendix A — Protocol reference

Restated in our own words. `adrobinoga/zk-protocol` carries no license, so it is read for
understanding and never copied. The command numbers and request/reply shapes below were confirmed
by reading `zkteco-js`, which is MIT and may be read freely, except the `CMD_OPTIONS_RRQ` payload
shape, which `zkteco-js` and `pyzk` disagree on — see §8.1 and PROVENANCE.md §4. The row below
states what this library actually sends, the NUL-terminated form, not the bare form either oracle
alone would suggest.

### A.1 Commands

| Name | Value | Payload | Reply body |
|---|---|---|---|
| `CMD_OPTIONS_RRQ` | 11 | keyword, NUL-terminated ASCII (§8.1/PROVENANCE.md §4) | keyword, `=`, value, NUL-padded |
| `CMD_GET_TIME` | 201 | empty | packed uint32 LE at offset 0 |
| `CMD_GET_VERSION` | 1100 | empty | firmware string, whole body |

### A.2 Well-known parameter keywords

Observed in an MIT reference implementation. Presence is not a guarantee for any given model.

`~SerialNumber`, `~DeviceName`, `~Platform`, `~OS`, `~ZKFPVersion`, `~OEMVendor`, `~ProductTime`,
`~PIN2Width`, `~SSR`, `MAC`, `WorkCode`, `FaceFunOn`

Note that some keywords are prefixed with `~` and some are not. The prefix is part of the keyword
and is neither stripped nor added by this library.

### A.3 Time encoding

`CMD_GET_TIME` uses the same packed uint32 pseudo-calendar as attendance records — 31-day months,
12-month years, seconds since a 2000 epoch — and is decoded by the existing `decodeZkTime`. See
v0.1 §5.2 for why a decoded `2026-02-31` is returned rather than corrected.

### A.4 Sources

Unchanged from v0.1 §10 and v0.2 §A.7. `pyzk` is GPL-2.0: **execute it, never read it.** That
boundary is not a formality — this library is MIT and its first consumer is distributed software,
so GPL-derived code here would carry copyleft into that whole product.
