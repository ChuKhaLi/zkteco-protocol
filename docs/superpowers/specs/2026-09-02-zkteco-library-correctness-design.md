# zkteco-protocol — Library Correctness Design Spec (v0.5)

**Date:** 2026-09-02
**Status:** Draft — awaiting owner review
**Builds on:** `2026-08-28-zkteco-protocol-library-design.md` (v0.1),
`2026-08-28-zkteco-realtime-events-design.md` (v0.2), `2026-08-29-zkteco-terminal-read-design.md`
(v0.3) and `2026-08-30-zkteco-bringup-kit-design.md` (v0.4). All four remain the binding authority
for everything they cover. This document adds **no protocol capability** and **no checklist item**.
It corrects defects in what already exists, and it amends one sentence of the v0.1 checklist (§16).
**Handoffs consulted:** `../plans/2026-09-01-continuing-past-v0.4.3-HANDOFF.md` and its five
predecessors. None is superseded.
**Origin:** the whole-project review of 2026-09-02, run against commit `8e38743`. Its findings are
restated here in full where this scope acts on them, so this document stands without it.
**Sibling:** a second spec, *Diagnostics Evidence*, covers the probe, the report, the CLI, the
release drill and the oracle capture tool. It is written after this one and builds on the error
classes and fallback rule fixed here (§2.2).

---

## 1. Purpose

### 1.1 What the review found

Twenty-eight confirmed defects across the library, the bring-up kit and the tooling; two of them
security items. Fifteen have the shape this project names in `CLAUDE.md`: code, a test, a comment
or a report row that claims more than it proves. The library-side defects fall into four groups,
and each group has a single cause:

1. **The session never bounds an exchange.** A reply is whatever the transport hands back next.
   A late reply after a timeout, or the reply to a second concurrent request, is returned as the
   answer to the wrong request and decoded without complaint (`Session.ts:242`,
   `tcp.ts:129-136`). The v0.1 checklist already names this as item 22 and deferred a code change
   until a device had been observed.
2. **The transports do not end on failure.** A TCP framing failure is retained but the socket
   stays open and sending, queued packets are served ahead of the failure, and the bulk reader
   treats the resulting `ZkProtocolError` as "the device refused PREPARE_BUFFER" and falls back
   down a broken stream (`tcp.ts:131`, `dataRead.ts:192`). `connect()` has no deadline. `close()`
   never settles a pending receive. Any UDP peer is the device (`udp.ts:47`).
3. **Three byte-layout claims disagree with the only readable reference.** The user id width
   (`user.ts:24`), the PREPARE_BUFFER reply layout and the user-list function code
   (`dataRead.ts:110-120`). Only this project's own emulator agrees with the library, so on hardware
   that behaves like the reference the buffered path always fails and the report blames the device.
   Reading the reference for this spec found a fourth and a fifth: the shape of each READ_BUFFER
   reply, and the user record size over UDP (§6.1, §7.4).
4. **Two identity paths fabricate.** A stale record count yields a "valid" record size and a
   misaligned parse, though the docblock says a stale count is refused (`attendance.ts:49-67`); the
   user lookup collides numeric ids and returns a blank printed id as an identity
   (`commands/attendance.ts:76`).

### 1.2 Why this scope, and why the library first

The kit's classification of what the device did depends on which error class the library throws
and on when the bulk reader falls back. Fixing the kit's report rows first would build them on
error types this scope then changes. So the library is corrected first, and the sibling spec
corrects what the kit says about it.

### 1.3 The rule this whole document obeys

**No new wire hypothesis without recorded evidence, and no fix that rests on one.** Every change
below is either hypothesis-free (a bound on this library's own behaviour) or an alignment with the
readable reference, `zkteco-js` (MIT), with a `PROVENANCE.md` entry naming the lines it restates.
Where the reference's behaviour is itself a guess about devices, this document says so, and a
black-box run of the second oracle, `pyzk`, adjudicates what it can (§12). Nothing here adds a
constraint the reference does not apply — the principle `Session.execute`'s docblock already states
for "only ACK_OK counts as success".

---

## 2. Scope

### 2.1 In scope

Numbered as the review ranked them (R1–R15) and as it listed the further items (F) and sweep
additions (S). Only the library-side ones are here.

| Review item | Where | Section |
|---|---|---|
| R1 late or concurrent reply answers the wrong request | `src/session/Session.ts` | §5.1, §5.2 |
| R2 framing failure is not terminal; fallback runs on a broken stream | `src/transport/tcp.ts`, `src/session/dataRead.ts` | §4.5, §6.2 |
| R3 stale record count decodes misaligned | `src/codec/records/attendance.ts`, `src/commands/attendance.ts` | §7.2 |
| R4 user id read as 8 bytes | `src/codec/records/user.ts` | §7.1 |
| R5 UDP accepts any peer | `src/transport/udp.ts` | §4.4 |
| R6 buffered read diverges from the reference | `src/session/dataRead.ts` | §6.1 |
| R10 connect has no deadline | `src/transport/tcp.ts`, `src/transport/udp.ts` | §4.3 |
| R12 exports map rejects CommonJS TypeScript consumers | `package.json` | §10.1 |
| R13 lookup fabricates identities | `src/commands/attendance.ts` | §7.3 |
| R15 dead CommonJS CLI ships | `tsup.config.ts` | §10.2 |
| F subscribe bypasses its own guards | `src/session/Session.ts` | §5.3 |
| F idle timer armed before registration | `src/realtime/Subscription.ts` | §8 |
| F close() never settles a pending receive; disconnect() during connect() is a no-op | `src/transport/*.ts`, `src/ZkDevice.ts` | §4.6, §9 |
| S4 legacy transfer has no overshoot check | `src/session/dataRead.ts` | §6.3 |
| Design: fallback on any `ZkProtocolError` | `src/session/dataRead.ts` | §6.2 |
| Design: transport factory written three times | `src/transport/`, `src/ZkDevice.ts` | §4.7 |
| Simplification: shared packet inbox; abandon/close merge; subscription state union | `src/transport/`, `src/session/`, `src/realtime/` | §4.1, §5.4, §8 |

### 2.2 Explicitly out of scope

- **Everything in `src/diagnostics/`, `src/cli.ts`, `.claude/skills/release-drill/` and
  `tools/oracle/capture.ts`** except the two oracle experiments §12 adds. The sibling spec owns
  them. Two things there depend on this scope and are named so the sibling can rely on them: the
  transport throws `ZkFramingError` on a framing failure (§4.5), and the bulk reader falls back
  only on `ACK_ERROR` (§6.2).
- **A 28-byte user record dialect.** The reference decodes one over UDP (§7.4). Implementing it
  would add a record layout no device has confirmed; this scope records the divergence and
  adjudicates it black-box, and this library keeps refusing a body that is not a whole number of
  72-byte records.
- **Reply-id and session-id matching.** §5.5 explains why it is not implemented and what would
  change that.
- **Caching the user list across polls.** The option doc that overstates what `resolveUserIds`
  saves is corrected (§7.3); the cache itself is a feature, not a fix.
- **Write paths, new read commands, new checklist items.** Unchanged prohibitions.

### 2.3 What changes for a consumer

Version **0.5.0**, in `package.json` and `src/index.ts` together. Pre-1.0, a minor bump marks
behaviour a consumer can observe:

- After a `ZkTimeoutError` the session is closed; every later call throws `ZkConnectionError`
  until `connect()` is called again (§5.2).
- A second request issued while one is in flight is refused before it is transmitted (§5.1).
- `connect()` rejects within the configured `timeoutMs` (§4.3).
- A TCP framing failure surfaces as `ZkFramingError`, not `ZkProtocolError`, and ends the
  connection (§4.5).
- `ZkUser.userId` can be nine characters long (§7.1).
- An attendance read whose record count moved during the transfer throws `ZkFramingError`
  (§7.2); a lookup that would be ambiguous returns `null` (§7.3).
- CommonJS TypeScript consumers typecheck (§10.1); `dist/cli.cjs` no longer exists (§10.2).

The published surface pinned by `test/smoke.spec.ts` gains nothing and loses nothing.

---

## 3. Architecture

The four layers and their direction of ignorance are unchanged. What moves within them:

```
src/transport/inbox.ts          NEW  PacketInbox — the state machine both transports duplicated
src/transport/createTransport.ts NEW  the one factory
src/transport/tcp.ts            connect deadline; terminal framing failure; first failure wins
src/transport/udp.ts            connect deadline; connected socket
src/transport/Transport.ts      connect(timeoutMs)
src/session/Session.ts          one exchange at a time; timeout ends the session; subscribe guards
src/session/dataRead.ts         reference bulk model; ACK_ERROR-only fallback; legacy overshoot
src/codec/commands.ts           BUFFER_FCT table
src/codec/records/user.ts       9-byte id
src/commands/attendance.ts      count bracket; null on ambiguity
src/realtime/Subscription.ts    state union; start()
src/ZkDevice.ts                 disconnect awaits connect; uses createTransport
package.json, tsup.config.ts    nested types; CLI ESM only
test/emulator/index.ts          reference bulk model + experiment knobs (§11)
tools/oracle/                   two black-box experiments (§12)
```

---

## 4. Transport layer

### 4.1 `PacketInbox`

`tcp.ts:116-159` and `udp.ts:134-184` are the same forty-five lines: the concurrent-receive
refusal, the timeout that nulls two callbacks, the listen guards, the queue drain. The waiter and
its reject twin must be set and cleared together at six sites per file, and a fix to either file
can silently land in only one. `PacketInbox` holds that state once:

```ts
class PacketInbox {
  deliver(payload: Buffer): void                    // listener, else pending, else queue
  receive(timeoutMs: number, held: Error | null): Promise<Buffer>
  listen(onPacket, onError, held: Error | null): void
  notify(err: Error): boolean                       // tells the pending receive or the listener; says whether anyone was told
  settle(err: Error): void                          // rejects a pending receive (used by close)
  clear(): void                                     // drops queued packets (used on framing failure)
  get listening(): boolean
}
```

`pending` is one `{ resolve, reject, timer }` or `null`, so the type cannot express a resolve
without its reject. Each transport keeps only its socket, `connect`, `send`, `close` and its
failure policy. The behaviour of the two transports is unchanged by the extraction alone; the
transport suites in `test/transport/` are the proof, and they run before any of §4.3–§4.6 lands.

### 4.2 The two failure policies, stated once each

The asymmetry the current docblocks defend survives as the one argument that differs:

- **TCP retains its failure**, because a TCP failure means the connection is gone and every later
  `receive()` really is doomed. `fail(err)` becomes: keep the **first** failure, then
  `inbox.notify(err)`. First rather than last, which is a change: a socket `'error'` is followed by
  a `'close'`, and today the generic close message overwrites the informative error. `receive()`
  and `listen()` pass the retained failure.
- **UDP forgets a failure once delivered**, because a UDP socket stays usable after an error about
  one datagram. `fail(err)` becomes: `if (!inbox.notify(err)) this.failure = err`. `receive()` and
  `listen()` pass `takeFailure()`.

### 4.3 Connect has a deadline

`Transport.connect(timeoutMs)`. `Session.open` passes `opts.timeoutMs`, the same value that bounds
every request, because that is what `ZkDeviceOptions.timeoutMs` and README already claim it does.

- TCP: `setTimeout(timeoutMs)` on the socket before connecting; on `'timeout'` before `'connect'`
  the socket is destroyed and the promise rejects with `ZkConnectionError` naming host, port and the
  deadline. On `'connect'` the socket timeout is cleared (`setTimeout(0)`). `ZkConnectionError`
  rather than `ZkTimeoutError`: the session never opened, and callers already treat that class as
  "could not connect". The message carries the deadline so the two causes stay distinguishable.
- UDP: the deadline covers bind and the `connect()` of §4.4 together, which includes a name lookup.

Today a firewalled host hangs about 21 s on Windows and about 127 s on Linux regardless of the
flag. That is the observable this fixes.

### 4.4 The UDP socket is connected

After binding, `socket.connect(port, host)`. `send()` then sends without an address, and the kernel
drops any datagram from another peer. This is the whole of the network-level fix for the review's
first security item: today the socket is bound on every interface, the `'message'` handler ignores
`rinfo`, and a forged reply from any host that can reach the ephemeral port is the device.

Two consequences, both welcome. An ICMP port-unreachable now surfaces as an `'error'` event on
every platform, not only Windows, and the take-and-forget policy of §4.2 already exists for exactly
that event. And `opts.host` may be a name: connecting resolves it once, where comparing `rinfo`
against the option would have had to.

What this does not defend against, stated so nobody reads more into it: a forged datagram carrying
the device's own source address. That needs an on-path attacker, and closing it needs the id
matching §5.5 declines to implement without evidence.

### 4.5 A framing failure ends the transport

`tryUnframeTcp` throws `ZkFramingError` — the class whose docblock already says "these bytes may be
misaligned, trust nothing parsed from them" — instead of `ZkProtocolError`. On catching it,
`absorb()` releases the accumulator (as now), **clears the inbox queue**, records the failure,
destroys the socket, and nulls the socket reference. From then on `send()` rejects with the retained
failure rather than with "transport is not connected", `receive()` rejects with it, and `listen()`
reports it.

The queue is cleared because the packets in it were framed before the failure and are individually
valid, but the exchange they belong to is lost: the session tears itself down on a framing failure
just as on a timeout (§5.2), and serving them first is what today lets seventeen further probe
steps run on a broken stream.

`ZkFramingError` is chosen over `ZkConnectionError` because the cause is bytes, not the socket, and
the kit classifies the two differently. The bulk reader's fallback stops caring which it is (§6.2).

### 4.6 `close()` settles a pending receive

`close()` calls `inbox.settle(new ZkConnectionError('transport closed while a receive was pending'))`
before ending the socket. Today the in-flight request is only ended by its own timer, as a "silent
device" `ZkTimeoutError`, which is false.

### 4.7 One factory

`createTransport(kind: 'tcp' | 'udp', opts: TransportOptions): Transport` in
`src/transport/createTransport.ts`. `ZkDevice.makeTransport` becomes a call to it; the two copies in
`src/cli.ts` and `src/diagnostics/probe.ts` switch to it in the sibling spec. Not exported from
`src/index.ts`; the published surface does not grow for an internal convenience.

---

## 5. Session

### 5.1 One exchange at a time

`send()` and `receiveMore()` share an in-flight flag. A call while the flag is set is refused with
`ZkConnectionError('a request is already in flight on this session; issue one at a time')`
**before anything is transmitted**. Today both requests transmit and only the second `receive()` is
refused, so the first caller's reply is consumed by whichever `receive()` ran, and the second
caller's reply sits in the queue for the next request. Hypothesis-free: this bounds the library's
own behaviour.

### 5.2 A timeout ends the session

On `ZkTimeoutError` from `transport.receive` — in `send()` or `receiveMore()` — the session calls
`abandon()` before rethrowing: `open_` false, a fire-and-forget `CMD_EXIT`, the transport closed.
The caller receives the original `ZkTimeoutError`; every later call refuses via `assertOpen` until
`connect()` again.

This is the same rule `open()` and `subscribe()` already apply to their own failures, and the same
rule the bring-up kit applies to a whole run (v0.4 spec §6.2, "why a timeout truncates the run").
The reasoning is unchanged from there: after a timeout the library does not know whether a reply is
still coming, and a reply that arrives later would be collected by the next request. Item 22 of the
checklist describes exactly that, with `getTime()` as the sharpest case because `decodeZkTime`
turns any four bytes into a plausible date. Closing the session is the only way to make that
impossible without assuming anything about what the device puts in its replies.

The same teardown applies to a `ZkFramingError` from `transport.receive` (§4.5): the stream is
misaligned, so nothing later on it can be trusted. A `ZkFramingError` from a record parser is a
different thing — the exchange completed and the bytes were wrong — and it reaches the session
never, since parsers run in `src/commands/` above it. A `ZkConnectionError` from
`transport.receive` runs the same `abandon()` teardown: `open_` is cleared so that the next call is
refused by `assertOpen` naming the closed session rather than by whatever the dead socket says, and
the transport is closed rather than assumed gone. Only TCP makes that assumption safe — Node
destroys the socket — while on UDP a post-connect `'error'` is recorded by the transport and the
socket stays bound, so a session that only cleared `open_` left it open with nothing able to
release it. The goodbye is best-effort either way: unsendable on a destroyed TCP socket, and on UDP
the one thing that tells the device to release the session slot. Clearing `open_` at all is new:
today it stays true after a dropped connection, and the v0.4 handoff §4.3 records what it cost when
refusal was left to the socket.

Cost, stated plainly: one slow reply ends a session, and a consumer that retries must reconnect
first. On UDP, which loses packets, this will happen more often than on TCP. That is the price of
not guessing; README says so (§14).

### 5.3 `subscribe()` guards itself

`assertOpen()` first. Then, if already subscribed, refuse with `ZkConnectionError` **before**
sending `CMD_REG_EVENT` — today a second `subscribe()` transmits a second registration whose
acknowledgment then arrives on the listening socket and ends the live stream with "a non-event
packet arrived", blaming the device. An `ACK_UNAUTH` reply is thrown as `ZkAuthError`, the class
every other request path uses for it, instead of the generic refusal. No `subscribing` state is
needed: §5.1's flag covers the request phase, and there is no `await` between the acknowledgment
and `listen()`.

### 5.4 `close()` and `abandon()` are one sequence

`close()` becomes: if not open, return; if subscribed, `return this.abandon()`; otherwise clear
`open_`, send `CMD_EXIT` and await its reply, swallowing any error, then close the transport. The
four statements duplicated in the subscribed branch today live only in `abandon()`, whose docblock
absorbs the one sentence that branch carried. One policy for a transport-close error, stated once:
a goodbye is best effort, and `close()` never throws. Today `abandon()` swallows that error and
`close()`'s subscribed branch does not, undocumented. A goodbye that times out runs §5.2's teardown
from inside `send()`; `abandon()` and the transport close that follows are both idempotent, so the
sequence ends the same way with one extra no-op.

### 5.5 Why replies are not matched by id

The obvious fix for R1 is to compare each reply's session id and reply id against the request and
discard mismatches until the deadline. It is not done, and the reason is recorded here and in
`PROVENANCE.md` so it is not re-litigated from memory:

- **No readable reference validates either id on receive.** `zkteco-js` reads the session id out
  of the `CMD_CONNECT` reply (`ztcp.js:274-275`, `zudp.js:231`) and never compares anything on any
  later packet. Its chunk handlers accumulate frames without reading the header at all
  (`ztcp.js:380-402`).
- **No oracle fixture shows a device reply.** Every capture in `test/fixtures/oracle/` is what a
  client sent to the emulator. Whether a device echoes the reply id is a property of devices, and
  nothing in this repository has observed one.
- **A wrong guess is total.** A device that does not echo would make every request time out, and
  under §5.2 every timeout closes the session: the library would be unusable on that device, and the
  bring-up kit would truncate at its first step — the tool built to discover the answer would be
  unable to.

§12's experiment E1 asks the one question that can be asked without hardware: does `pyzk`, the
client most widely run against real devices, keep working when the emulator stops echoing reply ids?
If it does not, the echo is something a widely used client relies on, and matching becomes a
candidate for the next cycle with that evidence behind it. If it does, no client evidence exists.
Either way nothing in this cycle depends on the answer.

---

## 6. Bulk reads

### 6.1 The buffered path follows the reference's model

This library's model of the buffered read agrees with nothing but its own emulator. The reference
(`zkteco-js`, `ztcp.js:320-462`, `zudp.js:283-360`, `helper/command.js:106-111`) holds a different
model at four points. All four are adopted:

1. **Request.** `<int8 1><int16 command><int32 fct><int32 ext>` as now, but `fct` is **5 for the
   user list** (`REQUEST_DATA.GET_USERS` = `01 09 00 05 00 00 00 …`) and **0 for attendance**
   (`GET_ATTENDANCE_LOGS` = `01 0d 00 00 00 00 00 …`). Today both send 0. A `BUFFER_FCT` table beside
   the command numbers in `src/codec/commands.ts` holds the two values with the reference lines in
   its docblock, and `readBulkBuffered` looks the code up by command.
2. **Reply to PREPARE_BUFFER.** If the command is `CMD_DATA` (1501), the data **is the whole body**
   and the read is complete (`ztcp.js:344-346`). Otherwise — `ACK_OK` or `PREPARE_DATA` — the
   total size is the four little-endian bytes **at offset 1** (`ztcp.js:352`, `zudp.js:311`); a
   reply shorter than five bytes is a `ZkProtocolError`. Byte 0's meaning is not recorded anywhere
   readable and this library does not interpret it. Today the size is read at offset 0.
3. **Reply to each READ_BUFFER.** Not one packet. The device answers `CMD_PREPARE_DATA` (1500),
   then `CMD_DATA` (1501) packets whose data concatenates to the chunk, then `ACK_OK` (2000). The
   UDP handler names the three (`zudp.js:335-350`: PREPARE_DATA ignored, DATA appended, ACK_OK
   completes when the total matches the size the client itself computed); the TCP handler is
   command-agnostic and skips the first eight accumulated bytes (`ztcp.js:389-395`), which is the
   PREPARE_DATA payload arriving through the same accumulator. Neither handler reads anything out
   of the PREPARE_DATA payload; both know the chunk size from their own request.

   So the legacy loop at `dataRead.ts:38-58` is extracted into
   `readTransfer(session, expected: number, first?: DecodedPacket): Promise<Buffer>` and both paths
   call it, `first` a packet the caller already consumed and treated as the transfer's first. Its
   contract: a leading `PREPARE_DATA` packet, if one arrives, is consumed and nothing in its data is
   interpreted; `DATA` packets are consumed until the first non-DATA packet, which is the transfer's
   terminator; the total is judged then — short of `expected` (an early `ACK_OK` or any other
   command) is a `ZkProtocolError`, past `expected` is a `ZkProtocolError` (§6.3), and a total that
   matches but is closed by anything other than `ACK_OK` is a `ZkProtocolError`. The legacy path
   passes the size it read from its own `PREPARE_DATA` reply, which `execute` has already consumed;
   the buffered path passes `want`, the size it asked for. Today the chunk is taken as the data of a
   single reply, which against the reference's model would treat the eight-byte PREPARE_DATA payload
   as the chunk and leave the DATA packets in the queue for the next request.
4. **The READ_BUFFER reply command is not checked beyond the three above.** The reference checks
   nothing on TCP and rejects any fourth command on UDP with an error. This library rejects a fourth
   command with `ZkProtocolError`, matching the stricter of the two, and requires no more than the
   UDP handler does.

Whether the reference's model is what devices do is not known. What is known is that the reference
has run against devices and this library has not. E2 and E3 in §12 put `pyzk` against both models.

`PROVENANCE.md` gains one section, *The buffered read — restated from a single readable source*,
at the "source reading" level, naming the lines above. The four points are recorded in that
section's table (before-v0.5 / reference / lines), and §Known divergences carries one pointer
paragraph rather than numbered rows, because the four points were never claims adjudicated between
two oracles — they were a model that agreed with nothing.

### 6.2 Fallback only on `ACK_ERROR`

`readBulk` sends `PREPARE_BUFFER` through `tryExecute`. An `ACK_ERROR` reply is the one signal that
the firmware does not implement 1503, and only it falls back to the legacy exchange. An
`ACK_UNAUTH` reply throws `ZkAuthError` exactly as `execute` would (the guard is copied to this
call site; it is the one `tryExecute` caller that must not inherit the fallback). Every other error
propagates: a framing failure (§4.5), a short or malformed size reply, a chunk that stops short or
overshoots, a timeout, a dropped connection.

Today the fallback fires on any `ZkProtocolError` from six throw sites plus the unframer, which is
how a misaligned TCP stream is retried down the legacy path and reported as a firmware capability.
The docblock's existing acceptance — firmware answering an unknown 1503 with silence never reaches
the fallback — is unchanged and restated. `CLAUDE.md`'s sentence describing the fallback is
corrected to say `ACK_ERROR` (§14).

### 6.3 The legacy transfer checks for overshoot

`readTransfer` (§6.1) refuses with `ZkProtocolError` when the received total exceeds `expected`,
mirroring the check `readBulkBuffered` carries at `dataRead.ts:146` with the same reasoning in its
comment. Because both paths now go through `readTransfer`, the check exists once and covers both.
Today `while (received < declared)` exits cleanly on 432 bytes for a declared 404 and the record
parser, whose only length guard is "too short", drops the tail silently.

### 6.4 What stays unverified

The size in a legacy `PREPARE_DATA` reply is read at offset 0, as now. The reference has no legacy
path to compare against; the buffered chunk transfer (§6.1 point 3) reads a PREPARE_DATA size the
same way, and the reference's TCP handler skipping eight bytes rather than four says the payload
is at least eight bytes long, which is compatible. Recorded as unverified, not changed.

---

## 7. Records and identity

### 7.1 The printed user id is nine bytes

`readNulTerminated(rec, 48, 9)`. The reference reads `slice(48, 48 + 9)` (`helper/utils.js:143-144`)
and firmware commonly allows nine-digit ids. Today an id of nine characters comes back truncated to
eight — a different identity, which then keys the attendance lookup, so 8- and 16-byte punches are
attributed to the truncated string while a 40-byte record from the same person carries the full one
and never matches. The emulator's `emUser` writes nine bytes. `ZkUser.userId`'s doc notes the
width and the source. `PROVENANCE.md` records the change at the "source reading" level.

Byte 57, the first byte after the field, is not otherwise interpreted by this library today or by
the reference, so widening the read consumes no other field.

### 7.2 The record count is read twice

`getAttendanceLogs` reads `recordCount`, performs the bulk read, and reads `recordCount` again. If
the two differ, it throws `ZkFramingError('the attendance buffer changed during the read')`. The
record-size division runs on the first count only when the second agrees.

Why: `detectRecordSize` accepts any quotient in {8, 16, 40}, which are multiples of one another, so
a count stale by exactly 2×, 2.5× or 5× yields a "valid" size and a misaligned parse with no error.
One punch landing between `getInfo` and `ATTLOG_RRQ` on a one-record buffer does it: 16 bytes over a
count of 1 decodes as one 16-byte record built from two 8-byte ones. The docblock at
`attendance.ts:49-56` says a stale count is refused; it is not, and the docblock is rewritten to say
what the guard actually establishes (a body that is not a whole number of records is refused; a
count that is wrong by a divisor is not detectable from the body alone). `ZkDevice.getAttendanceLogs`'s
docblock, which says "the framing guard refuses anything that does not add up", is corrected in the
same way.

Cost: one extra round trip per poll, on a path README already says to poll on the order of minutes.
A punch landing after the transfer but before the second count causes a refusal the next poll
recovers from; that false refusal is accepted because the alternative is a silent misparse, the one
outcome this library exists to prevent. Disabling the device around the read, which is what other
implementations do, is a write path and stays forbidden.

### 7.3 The lookup never fabricates

Two changes in `resolve`:

- `byNumericUserId` is built with collision detection. A numeric key claimed by more than one
  enrolled user — `'1'` and `'01'` both become `1` — resolves to `{ userId: null, userIdSource: null }`.
  Today it resolves to whichever user was listed last, labelled `'lookup'`.
- A matched user whose printed id is the empty string resolves to `{ userId: null, userIdSource: null }`.
  Today it returns `''` with source `'lookup'`, the value the 40-byte path explicitly maps to `null`
  (`records/attendance.ts:82-87`).

`GetAttendanceOptions.resolveUserIds`'s doc says turning it off "saves one device round-trip". It
saves a full user-list download on every poll; the doc says so.

### 7.4 The 28-byte user record over UDP — recorded, not implemented

`zkteco-js` decodes 72-byte user records over TCP and **28-byte** records over UDP
(`ztcp.js:471`, `zudp.js:382`, `helper/utils.js:114-126`). Whether that is a property of the
transport, of firmware age, or of the reference's own history is not recorded anywhere readable.
This library reads 72 on both, and its parser refuses a body that is not a whole number of 72-byte
records, so a 28-byte device is refused rather than misparsed unless its body length happens to
divide both. This scope adds the divergence to `PROVENANCE.md` and E4 in §12 asks `pyzk` which
size it expects on each transport. No decoder is added: a second record layout is a new hypothesis,
and the checklist's rule against adding items applies in spirit.

---

## 8. Subscription

`Subscription`'s five fields (`waiter`, `rejectWaiter`, `failure`, `ended`, `closed`) become:

```ts
private state: { kind: 'registering' } | { kind: 'live' } | { kind: 'failed'; error: Error } | { kind: 'closed' }
private pending: { resolve; reject } | null
```

`push()` accepts events while registering or live; `fail()` moves to failed unless already failed
or closed; `next()` switches on the state; `close()` moves to closed and settles `pending` with
done. The `|| this.closed` on line 135 and the `reject?.()` on line 125 disappear because the
type no longer allows the states they guarded.

**The idle timer is armed by `start()`, not the constructor.** `ZkDevice.subscribe` calls
`subscription.start()` after `session.subscribe` resolves, which moves registering to live and
arms the timer. Today the timer is armed at construction, before `CMD_REG_EVENT` is even sent, so
an `idleTimeoutMs` shorter than the registration round trip returns a stream that has already ended
and drops every real event. Events pushed during registration — `Transport.listen` drains a queued
packet synchronously, before `session.subscribe` returns — are queued, as they are today.

---

## 9. Facade

`ZkDevice.connect` stores its in-flight promise; `disconnect` awaits it (swallowing its rejection,
which the original caller receives) before closing. Today `disconnect()` during `connect()` finds
no session and returns, and the session that finishes opening afterwards is installed live.
`ZkDevice.makeTransport` becomes `createTransport(this.transportKind, opts)`.

---

## 10. Packaging

### 10.1 Types per condition

```json
"exports": { ".": {
  "import":  { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
  "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
} }
```

Today a single `types` condition points every consumer at the ESM declaration, so a CommonJS
TypeScript consumer under `module: node16` gets TS1479 although `require()` works. tsup already
emits `index.d.cts`; nothing references it. The top-level `main`/`module`/`types` fields stay for
tools that ignore `exports`.

### 10.2 The CLI is built as ESM only

`tsup.config.ts` becomes two entries: `src/index.ts` in both formats, `src/cli.ts` in ESM only.
`dist/cli.cjs` — whose `import.meta` is shimmed to `{}` so its main-module check is always false and
it exits 0 having done nothing — stops existing rather than being fixed. `bin` already points at
`dist/cli.js`. The sibling spec adds the drill assertion that no `dist/cli.cjs` is in the tarball.

### 10.3 Release shape

One release, **v0.5.0**, tagged after **both** this spec's plan and the sibling's are complete. The
kit ships in the same package, and the sibling corrects what the kit says about behaviour this
scope changes; releasing this scope alone would ship one version whose report describes the
previous library. This plan ends with the version bump and no tag. `docs/RELEASING.md` is
unchanged.

---

## 11. Emulator changes

The emulator moves to the reference's bulk model by default and grows the knobs the tests and
experiments need. Every knob's docblock says which section of this spec it exists for.

| Knob | Default | For |
|---|---|---|
| PREPARE_BUFFER reply: five bytes, size at offset 1, byte 0 written as `0x00` and documented as meaning unknown | — | §6.1 point 2 |
| READ_BUFFER reply: PREPARE_DATA (8 bytes, size at 0) + DATA packets + ACK_OK | — | §6.1 point 3 |
| `state.lastPrepareFct` records the `fct` received | — | a test pins 5 for users, 0 for attendance, without the legacy fallback masking a wrong value |
| `prepareBufferReply: 'size-at-1' \| 'size-at-0'` | `'size-at-1'` | E2 |
| `chunkReply: 'transfer' \| 'single-packet'` | `'transfer'` | E3; `'single-packet'` is the v0.4 model, kept for the experiment and deletable after |
| `prepareBufferInline?: boolean` | `false` | §6.1 point 2, the inline DATA reply |
| `legacyOvershootBytes?: number` | `0` | §6.3 |
| `replyDelayMs?: number` | `0` | §5.2: a reply that lands after the deadline |
| `echoReplyId?: boolean` | `true` | E1 |
| `replySessionIdOverride?: number` | — | E1's second half |
| `userRecordSize: 72 \| 28` | `72` | E4; the 28-byte encoder follows `decodeUserData28` and exists only to be served to `pyzk` |
| `emUser` writes nine id bytes | — | §7.1 |

`bufferChunkOverride` keeps its meaning against the new chunk shape: it overrides the DATA total of
the given chunk.

---

## 12. Evidence tasks

Four black-box runs of `pyzk` against emulator variants. `pyzk` is executed, never read; the driver
`tools/oracle/capture_pyzk.py` gains a `read-users` mode that calls the public `get_users()` and
prints one `uid|user_id|name` line per user, so what `pyzk` parsed is observable. The emulator
records what `pyzk` sent. `zkteco-js` is not run: its answer to every question below is already
known from the source lines §17 cites, and a black-box run would add nothing. Results are
committed under
`test/fixtures/oracle/bulk/` as one JSON file per variant (what was served, what the client sent,
what it printed, whether it completed), and `test/oracle/bulk.spec.ts` asserts the files exist and
name the variants below, so a deleted fixture is noticed.

| | Question | Variants | What is observable | Decision rule |
|---|---|---|---|---|
| E1 | Does `pyzk` rely on the reply id, or the session id, being echoed? | `echoReplyId: false`; `replySessionIdOverride` wrong | whether `pyzk` completes connect and `get_users` | Recorded either way in `PROVENANCE.md` §Reply binding: not implemented, and why. If it fails: matching is a candidate for the next cycle with black-box provenance. No code change this cycle. |
| E2 | Which offset does `pyzk` read the PREPARE_BUFFER size at? | `prepareBufferReply` both values, with a body long enough that the two readings differ | the `start`/`size` fields of the READ_BUFFER requests `pyzk` sends | Agrees with the reference: two oracles agree, recorded as the strongest level available without hardware. Disagrees: recorded as a divergence; the library keeps following the readable reference; the emulator keeps both. |
| E3 | Which READ_BUFFER reply shape does `pyzk` complete a read under? | `chunkReply` both values | whether `get_users` completes and prints the served users | As E2. |
| E4 | Which user record size does `pyzk` expect on each transport? | `userRecordSize` both values × TCP, UDP | whether the printed users match the served ones | Recorded under §7.4's divergence. No code change this cycle. |

An experiment whose `pyzk` run fails to spawn, or exits non-zero, is recorded as **not run**, never
as a result — the sibling spec fixes the capture tool's habit of writing a crashed run as a fixture,
and this harness is written the corrected way from the start.

---

## 13. Testing

Every fix has a test that passes after it and **a named pre-fix mutation under which that test
fails for the intended reason**, per `CLAUDE.md`. The plan carries the mutation per task; the table
below names them so the plan cannot drop one.

| Fix | Test (both transports unless noted) | Pre-fix mutation | Red for the reason intended when |
|---|---|---|---|
| §4.1 inbox | existing `test/transport/*.spec.ts` unchanged | — | the extraction changes nothing; the suites are the proof |
| §4.2 first failure wins | TCP: error then close; `receive()` rejects with the error's message | keep last-wins | the message is the generic close text |
| §4.3 connect deadline | connect to a blackholed address with `timeoutMs: 200`; rejects within 1 s naming the deadline | no timer | the test times out at vitest's limit, not at 200 ms |
| §4.4 connected UDP | a second socket sends a forged reply during a pending request; the request times out, the forged bytes never reach the session | unconnected socket | the forged payload is returned |
| §4.5 framing terminal | junk bytes mid-stream; `receive()` rejects `ZkFramingError`; a queued good packet before the junk is **not** served; `send()` rejects with the same failure | keep socket open, keep queue | the queued packet is returned |
| §4.6 close settles | `close()` during a pending `receive()`; it rejects `ZkConnectionError` at once | no settle | the test waits for the 5 s timer |
| §5.1 in-flight | two concurrent `execute()`; the second rejects before the emulator has received a second packet | transmit before check | `emulator.received` holds two requests |
| §5.2 timeout ends session | `replyDelayMs` past the deadline; first call throws `ZkTimeoutError`; second call throws `ZkConnectionError` naming the closed session; the late reply is provably never decoded | no abandon | the second call **resolves** with the first request's reply |
| §5.2 dropped connection clears `open_` | emulator drops the connection mid-request; the next call throws `ZkConnectionError` whose message names the closed session | keep `open_` true | the message is the socket's |
| §5.2 framing failure ends session | junk mid-stream during a request; the next call throws `ZkConnectionError` naming the closed session, and the emulator saw no EXIT — §4.5 destroys the transport before `abandon()` can transmit | no abandon on `ZkFramingError` | the next call reaches the transport and rejects with the retained framing failure instead |
| §5.3 subscribe guards | second `subscribe()` rejects before a second REG_EVENT is received; ACK_UNAUTH gives `ZkAuthError` | no guard | two REG_EVENT packets received |
| §5.4 close/abandon | close while subscribed sends one EXIT, never throws on a dead transport | — | behavioural equivalence; the realtime suites are the proof |
| §6.1 fct | user read: `state.lastPrepareFct === 5`; attendance: `0`; **and** the buffered path was used (no legacy command in `emulator.received`) | fct 0 for users | the fct assertion fails while the read still succeeds via the emulator's tolerance |
| §6.1 size offset | emulator serves size at offset 1; the read returns the served body | read offset 0 | `ZkProtocolError` or a wrong total |
| §6.1 chunk shape | multi-chunk read against the transfer shape; body matches; `emulator.received` shows one READ_BUFFER per chunk; an `ACK_OK` before `want` bytes is `ZkProtocolError` | single-packet reading | the PREPARE_DATA payload is taken as the chunk and the total is wrong |
| §6.1 inline DATA | `prepareBufferInline`; the body is returned without any READ_BUFFER | no inline branch | `ZkProtocolError` on the size |
| §6.2 fallback | framing failure during PREPARE_BUFFER propagates as `ZkFramingError`; `ACK_ERROR` still falls back; ACK_UNAUTH throws `ZkAuthError` | catch any `ZkProtocolError` | the framing case falls back and the legacy read runs |
| §6.3 overshoot | `legacyOvershootBytes: 28` on a declared 404; `ZkProtocolError` | no check | 432 bytes returned |
| §7.1 nine bytes | user `'123456789'` round-trips; a punch by that user resolves to the nine-character id | read 8 | `'12345678'` |
| §7.2 count bracket | count moves during the read: `ZkFramingError`; count unchanged: records parsed. Both directions | no second read | the moved-count case parses two 8-byte records as one 16-byte record |
| §7.3 lookup | users `'1'` and `'01'`, a 16-byte record with numeric id 1: `userId: null`; a user with a blank id matched by uid: `userId: null` | last-writer, blank passthrough | `'01'`; `''` |
| §8 idle timer | `idleTimeoutMs: 1` with a slow registration; the first event is delivered | arm in constructor | the stream is already ended when returned |
| §9 disconnect | `disconnect()` during `connect()`; afterwards `getInfo()` throws not-connected and the emulator saw EXIT | ignore in-flight connect | the session is installed and `getInfo()` succeeds |
| §10.1 exports | a CommonJS TypeScript consumer typechecks under `module: node16` — **in the release drill (sibling spec)**, since it needs the packed tarball | single `types` | TS1479 |
| §10.2 CLI | `dist/cli.cjs` does not exist after `pnpm build`; asserted in `test/smoke.spec.ts` beside the existing bundle checks | two formats | the file exists |

The oracle experiments of §12 are evidence, not tests; their spec asserts only that the fixtures
exist.

---

## 14. Documentation changes

- **README**: under *Usage*, one paragraph that a `ZkTimeoutError` closes the session and
  `connect()` must be called again; under *Identity*, that ids are up to nine characters and where
  that width comes from. The compatibility table is unchanged.
- **`CLAUDE.md`**: the architecture bullet on `dataRead.ts` says the fallback fires on `ACK_ERROR`
  only. Nothing else there changes; the rules section is untouched.
- **`PROVENANCE.md`**: new sections *The buffered read — restated from a single readable source*
  (§6.1), *Reply binding: not implemented, and why* (§5.5, with E1's result), *User record width and
  size* (§7.1, §7.4, with E4's result). The four buffered-read points are recorded in that section's
  own table, not as §Known-divergences rows; §Known divergences instead gains one pointer paragraph
  explaining why they are not numbered divergences there. §Unverified field offsets describes the
  count bracket (§7.2) instead of the framing guard alone.
- **v0.1 spec §12 item 22**: the sentence "This is v0.1 transport architecture … no code change is
  proposed here — record what a real device does before deciding whether one is warranted" is
  replaced by: "v0.5 (`2026-09-02-zkteco-library-correctness-design.md` §5.2) closes the session on
  any timeout and refuses a concurrent request, so a late reply can no longer be collected by a
  later request. Whether a device answers late remains the question; the trace audit answers it."
  The item's question and its "not testable by the bring-up kit" note are unchanged.
- **Docblocks** named in §6.2, §7.2, §7.3: rewritten to claim what the code establishes. A
  recorded defect that this scope fixes is deleted from wherever it is recorded, not rewritten into
  its aftermath.

---

## 15. Risks and open questions

1. **The reference's bulk model may not be what devices do.** Adopting it trades agreement with
   this project's own emulator for agreement with an implementation that has run against hardware.
   If the reference is wrong, the buffered path fails as it does today, falls back only on
   `ACK_ERROR`, and the kit reports a framing or protocol failure at step 19 instead of "the device
   refused" — a truer report of the same outcome. E2 and E3 narrow this before any device is seen.
2. **Timeout teardown changes the retry story.** A consumer with a retry loop around
   `getAttendanceLogs` now needs `connect()` in it. README says so; nothing in the library can say
   it louder than the `ZkConnectionError` message, which names the closed session and the fix.
3. **First-failure-wins could hide a later, more specific error.** On TCP the sequence is always
   error then close, or framing failure then close, so the first is the specific one. If a case
   appears where it is not, the rule is one line.
4. **The count bracket doubles `GET_FREE_SIZES` traffic.** Two round trips per poll on a path
   documented for minutes-scale polling. If a device turns out to answer that command slowly, the
   bracket is the first thing to revisit, and E2–E4 will have shown by then what else is slow.
5. **E1 can only say what `pyzk` does.** A `pyzk` that tolerates a missing echo says nothing about
   devices; a `pyzk` that breaks says one widely used client depends on it. Neither is a device.
   The rule in §5.5 stands until a device answers.
6. **Nine-byte ids on a device that stores eight.** Byte 57 is NUL there today by every reading
   available, so the widened read returns the same string. If a device puts something else in byte
   57, that is a new fact about the layout, and the first hardware report will show it as an id
   with a stray trailing character rather than hide it.

---

## 16. First-hardware checklist impact

This scope adds **no checklist item**. Item 22's deferral sentence is amended as §14 states; its
question stands. Items 3 (record size), 4 (free-sizes offsets) and 19/23 (buffered read) are
unchanged in text, and this scope changes what the kit will observe for 19 and 23 — the sibling
spec updates their observations accordingly. The user record width (§7.1) and the 28-byte question
(§7.4) are recorded in `PROVENANCE.md` rather than added as items; the first device run answers
both through the existing user-list step.

---

## 17. Sources

- `zkteco-js` 1.7.2 (MIT), read from `node_modules/zkteco-js/src/`: `ztcp.js` lines 256-275
  (session id from CONNECT, no validation), 285-316 (chunk request), 320-462 (`readWithBuffer`),
  471-486 (72-byte users); `zudp.js` lines 218-231, 283-360 (`readWithBuffer`,
  `handleChunkedData`), 382-390 (28-byte users); `helper/command.js` lines 25-29 (1500-1504) and
  106-111 (`REQUEST_DATA`); `helper/utils.js` lines 114-145 (user decoders, 9-byte id).
- `pyzk`: executed as a black box in §12, never read. `tools/oracle/README.md` states the boundary.
- The 2026-09-02 review report (private artifact, restated here); its verifier verdicts for R1–R15
  and F, and this spec's own reading for S4.
- `docs/superpowers/plans/2026-08-31-continuing-past-v0.4-HANDOFF.md` §4.3, on how backlogs get
  written, which is why §2.2 states the cost of each thing left out.
