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
| [zkteco-js](https://github.com/coding-libs/zkteco-js) | MIT | Second oracle, and read at source level. It diagnosed a bug in this library's TCP-to-UDP transport fallback. Attributed in the README. |
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
`applyReplyIdQuirk()` remains exported, documented, and tested in
`src/codec/packet.ts` — used by nothing, kept as a one-line escape hatch. If
the first real device refuses self-consistent packets, restoring the old
behaviour is one call site. Both ways of being wrong here fail loudly: a bad
checksum makes the device refuse everything, which surfaces on first contact
rather than corrupting data quietly. That symmetry is what made it safe to
follow the evidence rather than the documentation.

### 2. The comm-key mixing — vindicated, on a single oracle

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

**Caveat: this rests on a single oracle.** `zkteco-js` has no comm-key support
at all — its `auth-*-zkteco-js.json` fixtures contain a `CMD_CONNECT` packet
(proving the capture driver ran) but no `CMD_AUTH` packet whatsoever. There
was no second implementation available to corroborate the mixing formula
independently; the vindication above is `pyzk` agreeing with the
documentation's description, not two oracles agreeing with each other.
Comm-key mixing is on the first-hardware checklist for this reason.

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
