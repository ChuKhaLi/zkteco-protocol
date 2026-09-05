# Provenance

This library was written without access to a ZKTeco device. This file records
exactly which sources informed it and how, so anyone can judge how much to
trust it — and so its licensing position is checkable rather than asserted.

## Verification level

**`docs`.** No physical ZKTeco device has ever been tested against this
library. Every byte layout is documentation-derived and cross-checked against
two independent implementations driven as black boxes against a local
emulator. None of it has been confirmed against hardware. The README carries
this warning where users will see it, before any badge or example. See the
[first-hardware checklist](docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md#12-first-hardware-checklist)
for what changes that.

## Sources

| Source | License | How it was used |
|---|---|---|
| [adrobinoga/zk-protocol](https://github.com/adrobinoga/zk-protocol) | none | Principal specification. Read for understanding and restated in our own words; no prose was copied, since the repository carries no license. |
| ZK Communication Protocol Manual (vendor PDF) | vendor | Command tables, cross-reference. |
| [ZKTeco/Standalone-SDK](https://github.com/ZKTeco/Standalone-SDK) | none | Lookup only. No code taken. |
| [Securelist analysis](https://securelist.com/biometric-terminal-vulnerabilities/112800/) | article | Packet structure from a security-research perspective, used to cross-check. |
| [zkteco-js](https://github.com/coding-libs/zkteco-js) | MIT | Second oracle, and read at source level. Reading its source surfaced a bug in *zkteco-js's own* TCP-to-UDP fallback (its outer catch checks `err.code` on a wrapper object that never carries one) — this library has no such fallback of its own. The oracle capture driver works around it directly; see `tools/oracle/capture_zkjs.ts`. Attributed in the README. |
| [pyzk](https://github.com/fananimi/pyzk) | **GPL-2.0** | **Black-box execution only.** See below. |

## The pyzk boundary

`pyzk` is GPL-2.0. This library is MIT and is consumed by distributed
software, so code derived from a GPL-2.0 source here would carry copyleft
obligations into that whole product. That is a real legal exposure, not a
formality, which is why the boundary below is enforced mechanically, not just
by intent.

**No file of its source has been opened, read, translated, or paraphrased.**
None of its function structure, naming, or control flow appears here. It is
not a dependency of this package in any form — `pyzk` does not appear in
`package.json` under any section — and it is never distributed with it; the
Python virtual environment that holds it is git-ignored and excluded from the
published package.

It is executed as a separate process, driven only through its own public
constructor, lifecycle methods, and documented instance methods — never
through anything internal — against the test emulator in `test/emulator/`,
with the bytes it puts on the socket recorded as fixtures under
`test/fixtures/oracle/`. There are now three driver scripts, one per capture
added in v0.1, v0.2 and v0.3, and each calls a larger slice of that public
surface than the one before it:

| Script | Added | Public API called, beyond `ZK(...)`, `.connect()`, `.disconnect()` |
|---|---|---|
| [`tools/oracle/capture_pyzk.py`](tools/oracle/capture_pyzk.py) | v0.1 | none — nine lines, connect and disconnect only |
| [`tools/oracle/capture_pyzk_realtime.py`](tools/oracle/capture_pyzk_realtime.py) | v0.2 | `.live_capture()` |
| [`tools/oracle/capture_pyzk_params.py`](tools/oracle/capture_pyzk_params.py) | v0.3 | `.get_serialnumber()`, `.get_device_name()`, `.get_platform()`, `.get_fp_version()`, `.get_firmware_version()`, `.get_time()` — each probed with `getattr` first, so a method pyzk does not expose is recorded as producing no evidence rather than assumed away |

All three scripts were read for this v0.3 fix pass and confirmed to call only
public, documented constructor, lifecycle, and instance methods, with no
internals, structures, or naming that could only have come from pyzk's
source. This supersedes the earlier statement that named only
`capture_pyzk.py` and an audit that covered it alone — that statement went
stale at v0.2 and staler at v0.3, when the other two drivers were added
without this passage being revisited.

That is observation, not copying. GPL-2.0 §0 restricts copying, distribution
and modification — not execution — and covers a program's output only where
that output is itself a work based on the program. Protocol bytes are
dictated by the device manufacturer; any correct implementation emits the
same ones.

Copyright protects expression, not facts. Command numbers, byte layouts and
checksum formulas are facts about the protocol. The code and prose expressing
them are not, and none was taken.

## Known divergences

Where the two oracles disagreed with the documentation this project was built
from, or with each other, the disagreement is recorded here rather than
silently resolved in favour of one side. Two claims were adjudicated by
captured evidence, and they went opposite ways. The buffered read's four
points, adopted from source reading and put to `pyzk` in v0.5, are recorded
under *The buffered read — restated from a single readable source* below
rather than as numbered divergences here, because they were never claims this
project adjudicated between two oracles — they were a model that agreed with
nothing.

### 1. The reply-id quirk — refuted

The documentation asserts that reference implementations compute a packet's
checksum over the **previous** reply id, then overwrite the reply-id field
with the incremented value without recomputing the checksum — so the
transmitted packet's checksum would disagree with its own contents. This
project originally planned to preserve that behaviour, isolated in a named
`applyReplyIdQuirk()` function specifically so the decision could be revisited
once evidence existed.

Eighteen packets were captured across `pyzk` and `zkteco-js`, over both TCP
and UDP. Fourteen of them carry checksums matching the reply id **actually
transmitted** in that packet. The remaining four are all the same packet —
`pyzk`'s initial `CMD_CONNECT` (session id 0, reply id 0), captured once in
each of the four handshake/auth × TCP/UDP fixture files — and are excluded as
arithmetically ambiguous: one's-complement arithmetic makes reply ids `0` and
`0xffff` produce an identical checksum, so that packet cannot distinguish
"matches self" from "matches previous" the way the other fourteen can.

`pyzk` and `zkteco-js` start their reply-id counters at different values (0
and 1 respectively), so the fourteen matching packets are agreement across
different data, not a coincidence of one implementation's counter. Not one of
the eighteen supports the previous-reply-id hypothesis.

`Session.send` therefore transmits the encoded payload unmodified.
`applyReplyIdQuirk()` is retained and tested internally in
`src/codec/packet.ts` — used by nothing, kept as a one-line escape hatch. It
is deliberately not part of the public API: it is absent from `src/index.ts`
and therefore from `dist/index.d.ts`, unreachable to a consumer, because the
export surface is a promise that cannot cheaply be withdrawn and an internal
escape hatch does not belong in it. If the first real device refuses
self-consistent packets, restoring the old behaviour is one call site. Both
ways of being wrong here fail loudly: a bad checksum makes the device refuse
everything, which surfaces on first contact rather than corrupting data
quietly. That symmetry is what made it safe to follow the evidence rather
than the documentation.

**Refinement (2026-08-29).** The claim above rests on the wire bytes and is
unchanged. Its description of two *independent* implementations overstates
the independence for the zkteco-js half.

zkteco-js does implement the reply-id quirk — it checksums over `replyId`,
then overwrites the field with `replyId + 1` — and its checksum formula
subtracts one more than the standard one's complement does. Incrementing
`replyId` raises the word sum by one and so lowers a standard checksum by one,
so the two errors cancel exactly, for any payload. Measured on the committed
fixtures:

    transmitted: replyId=1, checksum=64534
      zkteco-js's own formula over replyId-1 ....... 64534
      standard one's complement over replyId ....... 64534

Both readings collapse to the same predicate on the wire, which is what a
device sees and what this library emits, so `Session.send` and the disposition
of `applyReplyIdQuirk` are unchanged. But zkteco-js agrees on the **bytes**, by
a different internal route, not on the **rule** — so it is corroboration of the
transmitted form, not a second independent derivation of it.

### 2. The comm-key mixing — vindicated, including the low-byte invariance, on a single oracle

As specified, the key-mixing algorithm structurally discards the low byte of
the session id: `mixCommKey(commKey, 1)`, `mixCommKey(commKey, 2)`, and
`mixCommKey(commKey, 255)` all produce identical output, because the byte
that would carry that information is overwritten (not XORed) by a tick-derived
value in the algorithm's last step. That looked like a defect in the protocol
prose, and was characterised by `test/oracle/commkey.spec.ts` as a suspected
one before evidence existed.

It is not a bug. `pyzk`'s captured `CMD_AUTH` payload, over both TCP and UDP,
matches this library's `mixCommKey(commKey, sessionId)` output byte for byte
(see `auth-tcp-pyzk.json` and `auth-udp-pyzk.json` under
`test/fixtures/oracle/`). The discarded low byte is genuine protocol
behaviour, confirmed against a real independent implementation of it.

That first round of evidence, though, was a single `(commKey, sessionId)`
pair: `tools/oracle/capture.ts` pinned one fixed session id for every
capture, so `pyzk` was never actually asked to mix two session ids differing
only in the low byte. Matching `mixCommKey`'s output byte for byte at one
point vindicates the algorithm there, but says nothing on its own about
whether the low byte specifically is what varying it fails to change — that
invariance rested solely on this library's own code
(`test/codec/commkey.spec.ts`), not on the oracle.

The capture was extended to close that gap: three further `pyzk` captures
(TCP only — the invariance under test is structural, not
transport-dependent), against `(commKey, sessionId)` pairs chosen to isolate
it —

| Fixture | commKey | sessionId | vs. baseline (`0x1f2e`, key `1234`) |
|---|---|---|---|
| `auth-lowbyte-tcp-pyzk.json` | 1234 | `0x1f99` | same high byte, different low byte |
| `auth-highbyte-tcp-pyzk.json` | 1234 | `0x2e2e` | same low byte, different high byte |
| `auth-keydiff-tcp-pyzk.json` | 5678 | `0x1f2e` | different key, same session id |

— and `test/oracle/commkey.spec.ts` now asserts two things against them: that
`mixCommKey` matches all three, and, specifically, that `pyzk`'s captured
`CMD_AUTH` payload for `0x1f2e` and `0x1f99` (the low-byte-only pair) is
**byte-for-byte identical**. It is. A control assertion also confirms the
`0x2e2e` (high-byte-only) capture's `CMD_AUTH` bytes genuinely differ from the
baseline's, ruling out the trivial (and wrong) explanation that the session id
is ignored altogether. The low-byte-discard invariance is therefore now
confirmed at one low-byte pair against real external computation, rather than
resting on this library's own
implementation of the same description.

**Caveat: this still rests on a single oracle.** `zkteco-js` has no comm-key
support at all — its `auth-*-zkteco-js.json` fixtures contain a `CMD_CONNECT`
packet (proving the capture driver ran) but no `CMD_AUTH` packet whatsoever.
There was no second implementation available to corroborate the mixing
formula, or the low-byte invariance specifically, independently; everything
above is `pyzk` agreeing with the documentation's description and with
itself across session ids, not two independent oracles agreeing with each
other. Comm-key mixing is on the first-hardware checklist for this reason.

### 3. The acknowledgment — decided on a single source, the other contributed nothing

The protocol documentation says a client answers every pushed realtime event
with `CMD_ACK_OK`, carrying the session id and a zero reply number. Reading
`zkteco-js`'s source (MIT; permitted, see the Sources table) shows it never
sends one. Those two sources disagree, and the decision rule for that
disagreement — spec §8.1 — was fixed before any capture was taken: neither
acknowledges → this library does not; both acknowledge → it does; they
disagree → follow the specification and record the divergence; one of them
never registers a subscription at all → it contributed no evidence either way,
and the question is decided by the one that did, scoped to a single source.
An absence of evidence is never filed as agreement.

Both oracles were driven against the emulator's realtime path — the handler
registers the client's mask and, in the same handler return, pushes three
attendance events, so delivery needs no timing coordination between the
oracle and emulator processes. Fixtures: `test/fixtures/oracle/realtime/`.

**`pyzk`, TCP and UDP: never registered.** Both `realtime-*-pyzk.json`
fixtures contain no `CMD_REG_EVENT` (500) packet at all. `pyzk`'s
`live_capture()` sends `CMD_CONNECT` (1000), then three further
request/reply exchanges (commands 50, 62, 60 — none of them
`CMD_REG_EVENT`), then gives up with `Cant Verify` printed to stderr and
sends `CMD_EXIT` (1001). Whatever internal check that message refers to,
`pyzk` never reached the point of registering a subscription, on either
transport. Per §8.1's fourth branch, `pyzk` contributed no evidence on
acknowledgment — its silence here is recorded as nothing, not as an
oracle that "didn't acknowledge."

**`zkteco-js`, TCP and UDP: registered, then sent nothing further but the
goodbye.** Both `realtime-*-zkteco-js.json` fixtures show `CMD_CONNECT`,
then `CMD_REG_EVENT` with a 4-byte little-endian mask of `01000000`
(`EVENT_FLAG.ATTENDANCE`), matching this library's `encodeEventMask`
byte-for-byte. After that registration, the only further packet on either
transport is `CMD_EXIT`. No `CMD_ACK_OK`, and nothing else, was ever sent
back for any of the three events the emulator pushed. `zkteco-js` is
therefore the only oracle to contribute evidence on this question, and what
it shows is: it does not acknowledge.

**Conclusion, scoped to exactly that evidence:** this is a single-source
finding, the way the comm-key vindication above is scoped to a single
source, and for the same reason — `pyzk` produced nothing here to
corroborate or contradict it. `zkteco-js`'s captured behaviour agrees with
what reading its source already showed, and per §8.1 this library does not
acknowledge either. `ackEvent()` (`src/codec/events.ts`) builds the documented
`CMD_ACK_OK` and is tested, but — like `applyReplyIdQuirk` — it is not called
from `Session.subscribe` and is not exported from `src/index.ts`. If the
first real device stops delivering after one event, wiring this in at that
one call site is the first thing to try; that is on the first-hardware
checklist.

The `CMD_REG_EVENT` request payload being a 4-byte little-endian mask is
**byte-level** evidence: `zkteco-js`'s captured bytes (`01000000`) are a
direct comparison against this library's own encoding, no device involved.
The acknowledgment finding above does **not** rest on the capture, and an
earlier version of this sentence said it did. It rests on the source
reading: `zkteco-js` has no acknowledgment code path on either transport.
The captured silence is weak corroboration only, for the reason the note
further down gives — the oracle's own gates never recognised the pushed
events, so it most likely never saw one it could have acknowledged.

**The event-type-in-the-session-id-slot claim (`readEventType`,
`src/codec/events.ts`) is weaker than both: it is behavioural, not a byte
match.** No oracle *sends* an event — a device does, and pushing one is the
emulator's job in every capture here, using this library's own encoder
(`eventPacket` in `test/emulator/index.ts`). The evidence is not this
capture; it is reading `zkteco-js`'s own receive-side source (MIT,
permitted): `checkNotEventTCP`/`checkNotEventUDP` and
`decodeRecordRealTimeLog52`/`decodeRecordRealTimeLog18`, in its
`src/helper/utils.js`, read the event indicator from byte offset 4 of the
decoded header — the same slot `readEventType` reads,
and the same one a session id otherwise occupies. That is an independent
implementation, written without reference to this project, landing on the
same offset for the same field — a real second source, but a source-level
one: it says two implementations were *written* the same way, not that
either was *exercised* against a device.

The committed realtime capture does not add to that on its own: its driver's
callback is a no-op, so `realtime-tcp-zkteco-js.json` and
`realtime-udp-zkteco-js.json` record nothing about what, if anything,
`zkteco-js` decoded from the three pushed events. That gap was checked
directly rather than left as an inference.

**TCP — attempted and observed to fail, not just reasoned about.**
`zkteco-js`'s TCP path (`getRealTimeLogs`) was driven with a real, logging
callback (not the committed driver's no-op) against the identical emulator
shape used everywhere else in this project — `pushWithAck` writing the
registration ack and three attendance events in the same handler return —
with the raw bytes its socket received logged alongside it. The client's
`data` handler fired exactly once, with a single 172-byte chunk containing
all four packets already concatenated: the 16-byte `CMD_ACK_OK` reply to the
registration, immediately followed by all three 52-byte `CMD_REG_EVENT`
frames. `checkNotEventTCP` strips only one 8-byte TCP wrapper — the first
frame's — then reads `commandId` and `event` from what follows; on this
coalesced read that is the *ack's own* header (`command` 2000, and its
session-id field, 7982, in the slot `checkNotEventTCP` reads as `event`),
not `CMD_REG_EVENT`'s. The gate returns false on that read and is never
invoked again for this chunk, so the three genuine events sitting right
behind it in the same buffer are never inspected. The logging callback
fired **zero** times. Reading `checkNotEventTCP` predicted this failure;
driving it for real against this project's own emulator shape reproduced
it.

**UDP — not run for real; the length gate is read, not observed.**
`zudp`'s equivalent path requires `data.length === 18` before it will even
call `decodeRecordRealTimeLog18`; the events this project pushes are 44
bytes on the wire. That is still a source-reading claim, not a captured
observation — datagram framing differs from TCP's coalescing in a way the
TCP experiment above doesn't settle, so it is recorded with that
distinction, not folded into the TCP finding.

**It also weakens the captured silence as corroboration of the acknowledgment
finding, and that bears saying where the finding is, not only here.** If
`zkteco-js` never recognised any of the three pushed events — its TCP gate
fired zero times, and its UDP path will not decode anything that is not
exactly 18 bytes against datagrams that are 44 — then in these captured runs
it almost certainly never reached the point of having an event to acknowledge,
so the absence of a `CMD_ACK_OK` afterwards is consistent with "does not
acknowledge" and equally consistent with "never got that far". The conclusion
above does not change, because it never rested on the capture: reading
`zkteco-js`'s source shows no acknowledgment code path anywhere, on either
transport, and §8.1's fourth branch decides the question on that single
source. What changes is the weight of the capture — weak corroboration of a
source-level finding, not independent confirmation of it.

None of this widens the conclusion. It says `zkteco-js`'s realtime path, run
in this project's specific test conditions, never itself demonstrates the
offset-4 decoding claim — not that a real device would deliver an ack and
its events coalesced this way, and not anything for or against the
source-level agreement between `readEventType` and
`checkNotEventTCP`/`checkNotEventUDP` on where the event type sits. The most
that can honestly be claimed is that source-level agreement — not proof
that a real device puts the event type at that offset, only that nothing
here or in `zkteco-js`'s written logic disagrees with the documentation on
where it goes. That is materially weaker than a byte-level match, and it
stays on the first-hardware checklist.

### 4. The CMD_OPTIONS_RRQ trailing NUL — genuinely disagreed, decided without hardware confirmation

The design spec fixed a decision rule for this question before any capture was taken (§8.1): does
`CMD_OPTIONS_RRQ` carry the requested keyword as a bare string — no NUL terminator, no length
prefix? The spec's own working assumption, `keyword, bare ASCII` in Appendix A.1, was reached by
reading `zkteco-js` (MIT, permitted) — `pyzk` is GPL-2.0 and could not be consulted the same way, so
that assumption went untested against it until this capture.

The two oracles disagree. Driven against the emulator over both transports, with four parameter
keywords each (`~SerialNumber`, `~DeviceName`, `~Platform`, plus `~ZKFPVersion` for `pyzk` or `~OS`
for `zkteco-js` — the two libraries expose different method sets, so they were not asked for
identical keywords, which does not bear on the shape question):

- **`zkteco-js`** sends the keyword bare, exactly as the spec assumed: e.g. `~SerialNumber` is 13
  bytes, no terminator, no NUL anywhere in the payload — but only on TCP, the only transport on
  which it reaches `CMD_OPTIONS_RRQ` at all. On UDP it produced **zero** `CMD_OPTIONS_RRQ` packets:
  its parameter and firmware methods are wired with a TCP callback and no UDP callback (design spec
  §8.2), so the UDP run never sent one to disagree or agree with anything. `CMD_GET_TIME` is the
  named exception in §8.2 and is unaffected by this — it has a real UDP implementation, and
  zkteco-js does reach it on UDP; the TCP-only limitation is specific to the parameter and firmware
  commands.
- **`pyzk`** appends exactly one trailing NUL to every keyword, on both TCP and UDP: the same
  request is 14 bytes, `~SerialNumber\0`. This was observed on the wire only — `pyzk`'s source was
  never opened to explain why (see the pyzk boundary above); the fact recorded here is what its
  black-box execution actually transmits, four times per transport, consistently.

Per §8.1's second branch, the disagreement is not resolved by preferring one oracle's silence over
the other's evidence, and it is not left unresolved either: `encodeParamRequest`
(`src/codec/params.ts`) now sends the **NUL-terminated** form. That choice was made, not derived,
for two reasons: it is a strict superset of the bare form for a device that null-terminates its own
copy of a length-delimited payload before comparing it — ordinary, safe C practice, under which a
bare or NUL-terminated request compare identically — and both `pyzk` and `zkteco-js` are libraries
run against real ZKTeco hardware in the field, not only against this project's emulator: `pyzk`
sends the NUL-terminated form there and works, which is the real tiebreaker — external evidence,
from outside this project's own captures, that devices evidently tolerate a trailing NUL rather
than reject it. Taken alone that deployment argument is symmetric and proves less than it might
appear to: `zkteco-js` is equally field-deployed and sends the bare form, so it shows only that
each shape works on the devices its own users happen to own, not that NUL is a superset of bare —
that direction rests on the parser-family reasoning above. Neither reasoning amounts to hardware
confirmation against a device this project has actually seen. A device that requires an exact
byte-length match with no tolerance for a trailing NUL would reject this library's request and
accept `zkteco-js`'s instead; that hypothesis is exactly as plausible on the evidence available and
is not ruled out.

The test emulator (`test/emulator/index.ts`) was updated in lockstep: its `CMD_OPTIONS_RRQ` handler
strips a single trailing NUL, if present, before matching a keyword, so it models a device tolerant
of either shape rather than only the one this library happens to send. `test/oracle/params.spec.ts`
records both figures directly from the fixtures rather than asserting one uniform shape, which is
what the brief for this capture explicitly warned against: adjusting the test to fit a belief the
data had already refuted.

This is item 18 on the first-hardware checklist, and it stays open. The choice made here is a
default that can be reversed at one call site if the first real device disagrees with it.

## User record width and size

**The printed user id in the 72-byte user record is nine bytes at offset 48.**
Source reading, not hardware: `zkteco-js` `helper/utils.js:143-144` reads
`slice(48, 48 + 9)`. This library read eight until v0.5, which returned a
nine-digit id truncated — a different identity — and then keyed the attendance
lookup with it. Byte 57 is interpreted by neither implementation, so the wider
read consumes no other field. A device that stores eight leaves byte 57 NUL and
the returned string is unchanged.

**The reference decodes 28-byte user records over UDP and 72-byte records over
TCP** (`ztcp.js:471`, `zudp.js:382`, `helper/utils.js:114-126`). Whether that
is a property of the transport, of firmware age, or of the reference's own
history is not recorded anywhere readable. This library decodes 72-byte records
on both transports and has no decoder for the other width. Until v0.6 it also
*assumed* that width, refusing only a body that was not a whole multiple of 72
— which left a hole wherever the two readings agree: 28 and 72 share a factor
of 4, so 504 bytes is eighteen 28-byte records and also seven 72-byte ones. A
28-byte device sending eighteen users passed that guard, and the caller
received seven users nobody had enrolled.

Since v0.6 the width is **derived rather than assumed**: `detectUserRecordSize`
(`src/codec/records/user.ts`) divides the body length by the device's own
`userCount` from `CMD_GET_FREE_SIZES`. That is the technique `detectRecordSize`
(`records/attendance.ts`) has used for the attendance dialects since v0.3, and
it **inspects no record byte**, so it adds no wire hypothesis: telling the two
widths apart from the bytes themselves is still unproposed and still
unanswered, and the first hardware run is still where that question is settled.
A derived width of 28 is **refused, not decoded**. Where no count is available
the 72-byte read continues as before, except that a non-zero multiple of 504 —
the lengths where the two readings agree — is refused instead of decoded, so a
legitimate 72-byte device with a multiple of seven enrolled users needs the
count to be read at all.

**What deriving it cost** (`docs/superpowers/specs/2026-09-04-zkteco-user-record-width-design.md`
§9.2): the user read now depends on `FREE_SIZES_OFFSET.userCount`, an offset no
device has ever confirmed (*Unverified field offsets* below), exactly as the
attendance read has depended on `recordCount` since v0.3. If that offset is
wrong, a device whose user list reads fine today starts refusing instead. That
is correct under *refuse rather than guess*, and it is bounded on one side
only: `ZkDevice.getUsers` falls back to no count when `CMD_GET_FREE_SIZES`
**fails**, but a reply that succeeds with the count taken from the wrong offset
gets no such fallback. It is a real way v0.6 could make first contact with
hardware worse rather than better, and it is on this record for that reason.

**What that fallback preserves, and what it does not.** It preserves the user
*list*. `ZkDevice.getUsers` transfers the list first and asks for the count
afterwards, so bytes already in hand cannot be lost to a count that never
arrives. It does **not** preserve the *session*. Only `ZkAuthError` and
`ZkProtocolError` — the two that mean the device *answered*, with
`CMD_ACK_UNAUTH` or `CMD_ACK_ERROR` — leave a session that still works. A
timeout, a framing failure or a connection failure ends the session inside
`Session.exchange` (design spec v0.5 §5.2) before the swallowing `catch` is
ever reached. So a device that answers `CMD_GET_FREE_SIZES` with silence
returns its full user list and leaves the caller holding a dead session: the
next `ZkDevice` call fails with "this session is not open", and `connect()` is
the recovery. Until v0.6 the two reads were ordered the other way round, and
that same device lost the list as well — the read after the failed count threw
`ZkConnectionError` from a session the count had already killed. The two
orderings fail differently, and the newer one is not strictly better. Under the
old one nothing was masked — the dead session announced itself immediately, by
destroying the read. Under the new one the data survives and the deadness is
silent: the list comes back and the caller learns the session is gone only on
its next call. **Hiding that state change is a cost v0.6 introduced**, not one
it inherited. The trade is deliberate — a list plus a stale session beats no
list — but it is a trade, not a repair.

**The closure is conditional on that same offset**, and refusal is not the only
way a wrong one can land. `detectUserRecordSize` trusts the count absolutely —
it divides the body by it (`src/codec/records/user.ts:131`) — so a misread
value that happens to equal `bodyLength / 72` satisfies both the divisibility
check and the width check. Where the true width is 28 that means a body length
both widths divide, and the caller receives fabricated users exactly as before
v0.6: eighteen 28-byte users under a misread count of seven is the pair
`(504, 7)`, which is the pair a legitimate 72-byte device with seven users
presents as well. Those two numbers are the function's only inputs, so nothing
computed from them separates the two devices; this is recorded as a residual
rather than closed. What did change is its reach — before v0.6 that body
fabricated users unconditionally, with no count involved at all, and it now
takes a wrong offset whose value coincides with `bodyLength / 72`.

**A second unconfirmed premise, distinct from the offset: that the count and
the body describe the same moment.** Dividing `bodyLength` by `userCount`
requires the `USERTEMP_RRQ` body to hold exactly `userCount` records. Neither
oracle has been asked this and no device has answered it; the documentation
above conditions the new risk entirely on `FREE_SIZES_OFFSET` being right, and
this is a separate claim that has to be right as well. Its observable
consequence is a race rather than a fabrication: a user enrolled between the
two reads leaves the count describing a different device than the body does,
and the read is refused — as "does not divide evenly" where the new count does
not divide the body (four users is 288 bytes and a count of 5 does not divide
it), and as an implied width that is neither 72 nor 28 where it happens to
(seven users is 504 bytes, and a count of 8 implies 63-byte records). Refusing
is correct under *refuse rather than guess*, and the next poll recovers.

`getAttendanceLogs` guards its analogous race by reading the record count on
**both** sides of the transfer and refusing only if it moved. The user path
deliberately does not: that second round-trip was ruled out for the poll loop
(design spec §3 decision 2 — `getUsers` runs inside it, and a hidden
`CMD_GET_FREE_SIZES` per poll keeps the terminal busy for the people badging at
it). Reading the list before the count, which v0.6 does for the reason recorded
above, does not remove this race — it **flips** it. The count now describes the
device *after* the transfer, so it is an enrolment landing during the read,
rather than one landing just before it, that produces the refusal.

Experiment E4
(`test/fixtures/oracle/bulk/E4-*.json`, recorded under *The buffered read —
restated from a single readable source*) served `pyzk` three users as
72-byte and as 28-byte records over UDP; it decoded both correctly. So
`pyzk` does not fix the width by transport the way `zkteco-js` does, and
neither oracle says what a device sends. No second decoder exists; adding
one would be a new hypothesis.

## Reply binding: not implemented, and why

`Session` (v0.5) closes on any timeout and refuses a concurrent request, so a
late reply can never be collected by a later request (design spec v0.5 §5.2).
It does **not** compare a reply's session id or reply id to the request, for
three reasons that are recorded here so the decision is not re-litigated from
memory:

1. No readable reference validates either id on receive. `zkteco-js` reads
   the session id out of the `CMD_CONNECT` reply (`ztcp.js:274-275`,
   `zudp.js:231`) and never compares anything on any later packet; its chunk
   handlers do not read the header at all (`ztcp.js:380-402`).
2. No oracle fixture shows a device reply. Every capture under
   `test/fixtures/oracle/` is what a client SENT.
3. A wrong guess would be total: a device that does not echo would time out
   every request, and under §5.2 every timeout closes the session.

Experiment E1 asked the one question askable without hardware — does `pyzk`
keep working when the emulator stops echoing? — with the results in
`test/fixtures/oracle/bulk/E1-*.json`. Both variants served a three-user list
and had `pyzk` call `get_users()`, which runs the full buffered-read exchange
(`PREPARE_BUFFER`, `READ_BUFFER`, `FREE_DATA`) rather than only the handshake:

| Variant | pyzk completed connect + read | Read as |
|---|---|---|
| reply id never echoed (every reply carries reply id 0) | yes — exit 0, printed all three served users | `pyzk` does not require a reply's reply id to match its request's |
| session id wrong after the handshake (every post-handshake reply carries a session id `pyzk` never agreed to) | yes — exit 0, printed all three served users | `pyzk` does not require a reply's session id to match the one learned at `CONNECT` |

Whatever E1 shows is a fact about `pyzk`, not about a device. Matching stays
out until a device answers, or until a later cycle takes E1's result as its
evidence.

## The buffered read — restated from a single readable source

`readBulkBuffered` (v0.5) follows `zkteco-js` at four points, at the
"source reading" level (design spec v0.5 §6.1). Before v0.5 this library's
model agreed with nothing but its own emulator.

| Point | This library before v0.5 | The reference | Lines |
|---|---|---|---|
| PREPARE_BUFFER request `fct` | 0 for every command | 5 for the user list, 0 for attendance | `helper/command.js:109-110` — **and two oracles agree on the user half**: every E1-E4 fixture records `pyzk`'s own PREPARE_BUFFER request as `0109000500000000000000`, which is fct 5 at the `<int8 1><int16 command><int32 fct><int32 ext>` layout's fct field. The attendance value rests on source reading alone; these runs only ever called `get_users()` |
| PREPARE_BUFFER reply | size at data offset 0 | size at offset 1; a `CMD_DATA` reply is the whole body | `ztcp.js:344-352`, `zudp.js:311` |
| READ_BUFFER reply | one packet carrying the chunk | PREPARE_DATA, DATA packets, ACK_OK | `zudp.js:335-350`, `ztcp.js:389-395` |
| READ_BUFFER reply command | never checked | not checked on TCP; a fourth command is an error on UDP | same |

Experiments E2 and E3 put `pyzk` against both models
(`test/fixtures/oracle/bulk/E2-*.json`, `E3-*.json`) — and, along with E1 and
E4, first needed one more thing served correctly: `pyzk`'s `get_users()`
reads a user count out of the unrelated `CMD_GET_FREE_SIZES` reply before it
will attempt any read at all, and gives up silently — `completed: true`, zero
users printed, no `PREPARE_BUFFER` ever sent — when that read does not yield a
count. Two controls are recorded rather than one, because E0 and E1-E4 differ
only in reply length, so on their own they cannot say whether the count at
offset 16 is read at all:

| Control | What was served | What `pyzk` did |
|---|---|---|
| E0 (`E0-free-sizes-default-tcp.json`) | the 68-byte reply this library's own encoder produces (`encodeFreeSizes`, capped at `FREE_SIZES_OFFSET.recordCapacity + 4`), with `userCount` correctly 3 at offset 16 | completed having sent nothing past `CONNECT`, `CMD_GET_FREE_SIZES`, `EXIT` |
| E0b (`E0b-free-sizes-80-count-zero-tcp.json`) | the same 80 bytes E1-E4 are served, with the count written as 0 | the same: completed, zero users printed, no `PREPARE_BUFFER` |
| E1-E4 | 80 bytes, count 3 as a little-endian uint32 at byte offset 16 (`tools/oracle/experiments.ts`, recorded per fixture under `served.freeSizesReply`) | reached `PREPARE_BUFFER` in every variant, and printed the served users wherever the rest of the exchange was served correctly (`E2-size-at-0` and `E3-chunk-single-packet` did not, as their rows below record) |

E0b holds the length fixed and varies only the count, so the gate is a real
observation and not an inference: zeroing those four bytes is enough to stop
the read. `test/oracle/bulk.spec.ts` pins both halves per fixture — the users
printed, and whether a `PREPARE_BUFFER` was sent at all.

Offset 16 happens to match this library's own (hardware-unverified)
`FREE_SIZES_OFFSET.userCount`. Nothing here claims 80 bytes or offset 16 are
minimal or exact: intermediate lengths were never tried and no other offset
was. What stopped E0 was the length alone — `encodeFreeSizes` writes only
`userCount` at 16, `recordCount` at 32 and `recordCapacity` at 64 into a
zeroed 68-byte buffer, and the two latter are served as 0, so E0's bytes are
identical to the first 68 of the 80-byte override and the twelve trailing
zeros are the entire difference. The whole of what these fixtures support is that a
count of 3 at offset 16 in an 80-byte reply is read, and a count of 0 there is
not. That is a fact about `pyzk`'s parser, not corroboration of the offset
table — "Unverified field offsets" above is unchanged by it.

| Question | Result | Read as |
|---|---|---|
| E2: which offset does pyzk read the size at? | `size-at-1`: `pyzk` sent `READ_BUFFER` requesting offset 0, size 220 (`00000000dc000000`) — a sensible request. `size-at-0`: `pyzk` never sent a `READ_BUFFER` at all; it raised `unpack requires a buffer of 4 bytes` decoding the 4-byte `PREPARE_BUFFER` reply itself, before reaching the point of asking for a size. | agrees with the reference: two oracles agree |
| E3: which chunk shape does pyzk complete a read under? | `transfer`: completed, printed all three served users. `single-packet`: sent three identical `READ_BUFFER` retries, then failed with `pyzk read failed: can't read chunk 0:[220]` — never completed. | agrees with the reference: two oracles agree |
| E4: which user record size does pyzk expect over UDP? | Both: printed all three served users under a 72-byte-per-record body (`READ_BUFFER` requested 220 bytes) and under a 28-byte-per-record body (requested 88 bytes). | `pyzk` decoded both sizes on UDP — it does not fix the width by transport the way `zkteco-js` does; recorded under *User record width and size*, no code change |

Neither oracle is a device. The first hardware run is the test either way.

## Inbound checksums are not validated

`decodePayload` (`src/codec/packet.ts`) reads the checksum field into
`DecodedPacket.checksum` but never recomputes it and compares — nothing in
this library rejects a reply whose checksum doesn't match its own contents.
Spec §5.3's guard table (declared size vs. actual length, record size
divides evenly, TCP start marker, and so on) is now fully implemented, but
checksum validation was never one of its rows, and completing that table
should not be read as this being covered by it.

This also means `test/scenarios.spec.ts` and every other test that runs a
session against `test/emulator/` cannot exercise a corrupted-checksum reply
either way: the emulator's `reply()` helper builds every response with this
library's own `encodePayload`, so every reply in the whole suite is
self-consistent by construction. The suite proves the request/response flow,
framing, and session sequencing; it says nothing about what happens on a
reply a real device sent with a checksum that doesn't match, because it has
never been asked to produce one.

No hard reject is added here without a device to test it against: an
over-eager check that turns out to encode the checksum algorithm wrong (or
misjudge which fields it covers, per the §5.1 divergence above) would make
this library reject good replies from real hardware. This is on the
first-hardware checklist rather than fixed on the same speculative
approach.

## Unverified field offsets

The byte offsets `CMD_GET_FREE_SIZES` uses for `userCount`, `recordCount`, and
`recordCapacity` (`FREE_SIZES_OFFSET` in `src/commands/info.ts`) are
documentation-derived and have never been checked against a real reply from
hardware. **Both oracles now corroborate them, by two different methods, and
neither method is hardware** (see *Both oracles agree on the offsets* below).
A wrong `recordCount` silently poisons the framing guard
described in the design spec §5.3: the record-size division still "succeeds"
on a count that is off by a divisor of the true size. Since v0.5
`getAttendanceLogs` reads the count on both sides of the transfer and refuses
if it moved, which catches a count that changed during the read but not one
that was wrong to begin with — a wrong OFFSET returns a wrong count twice,
consistently. Since v0.6 `userCount` is load-bearing the same way for the user
read — the record width is derived by dividing the body by it — so this table's
exposure is no longer confined to attendance; *User record width and size*
above records what that trade cost. For that reason the offsets live as named
constants in one place, and confirming them against a real device is item 4 on
the first-hardware checklist.

### Both oracles agree on the offsets

Two independent implementations put `userCount` at payload offset 16, each
established by the method its license allows.

**`pyzk` — behaviour, black box (experiment E5).** The 80-byte
`CMD_GET_FREE_SIZES` override is served with **exactly one nonzero 4-byte word**
and the rest zero, once per word, sweeping all twenty words of the reply. A run
that goes on to read the user list must have read the word that was nonzero.
Result: offset 16 proceeds to a full buffered read of all three served users;
**the other nineteen offsets stop after `CMD_CONNECT`, `CMD_GET_FREE_SIZES`,
`CMD_EXIT`, sending no `PREPARE_BUFFER` at all.** Fixtures:
`test/fixtures/oracle/bulk/E5-free-sizes-count-at-*-tcp.json`; asserted in
`test/oracle/bulk.spec.ts`, where the single positive offset is computed from
the fixtures rather than written into the test.

The sweep runs over TCP. That the answer does not depend on the transport is an
assumption, so it is checked rather than asserted: `E5-free-sizes-count-at-16-udp`
and `E5-free-sizes-count-at-20-udp` re-run the result over UDP as a pair — 16
reads all three users, 20 sends no `PREPARE_BUFFER`. The positive alone would
show only that UDP reads *some* count; the negative beside it is what makes the
two fixtures say UDP reads the *same word*.

E0b could not establish this. It and E1–E4 all serve a body that is zero except
at offset 16, so "zeroing offset 16 stopped the read" was equally consistent
with `pyzk` reading offset 16 and with `pyzk` reading any word that happened to
be zero throughout those fixtures. **The nineteen negatives are what E5 adds**;
the positive was already implied.

**`zkteco-js` — source, MIT and readable.** `ztcp.js:609` and `zudp.js:460` both
read `userCounts` as `data.readUIntLE(24, 4)`. That 24 is not a disagreement:
`executeCmd` returns the packet after `removeTcpHeader` (`helper/utils.js:100`)
strips only the 8-byte `0x50 0x50 0x82 0x7d`+length TCP wrapper, leaving the
8-byte ZK command header in place — which the same function confirms by reading
the session id at `rReply.readUInt16LE(4)`. So its 24 is payload offset **16**.
By the same arithmetic its `logCounts` at 40 and `logCapacity` at 72 are payload
offsets **32** and **64**, matching `recordCount` and `recordCapacity` exactly.
All three of this library's offsets are corroborated.

**What this establishes, and what it does not.** Two implementations that do not
share code agree on all three offsets, which is this project's ordinary standard
for a claim resting on more than documentation. It moves the table from
*documentation only* to *documentation plus two independent implementations*. It
is **not** hardware, and it cannot be: E5 is a fact about `pyzk`'s parser, and
the `zkteco-js` reading is a fact about its source. If every implementation
inherited the same wrong offset from the same documentation, all three would
agree and all three would be wrong. Checklist item 4 is what retires this, and
it still needs a device.

**What it changes about v0.6's residual.** *User record width and size* above
records a path where a `userCount` read from a wrong offset still fabricates
users. That path is unchanged in kind — it turns on the offset being wrong, and
the offset is still unverified — but it now requires both independent
implementations to have inherited the same error. That is less likely than one
undocumented table being wrong on its own. It is not zero.
