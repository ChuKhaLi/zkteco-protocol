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

It was used in exactly one way: executed as a separate process, driven only
through its public constructor and lifecycle methods (`ZK(...)`,
`.connect()`, `.disconnect()`), against the test emulator in `test/emulator/`,
with the bytes it put on the socket recorded as fixtures under
`test/fixtures/oracle/`. The driver script is
[`tools/oracle/capture_pyzk.py`](tools/oracle/capture_pyzk.py) — the whole of
it is nine lines that call `ZK`, `connect`, and `disconnect`, and nothing
else. An independent reviewer audited that script and confirmed it calls only
that public API, with no internals, structures, or naming that could only
have come from the source.

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
captured evidence, and they went opposite ways.

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
hardware. Neither oracle exercises this command in a way that pins those
offsets — the captures above cover the handshake and comm-key authentication,
not storage counters. A wrong `recordCount` silently poisons the framing
guard described in the design spec §5.3: the record-size division still
"succeeds" on a stale or wrong count, and the parse loop emits misaligned
records with meaningless identifiers and nonsense timestamps instead of
raising anything. For that reason the offsets live as named constants in one
place, and confirming them against a real device is item 4 on the
first-hardware checklist.
