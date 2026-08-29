# zkteco-protocol v0.2 — Realtime Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer subscribe to the events a ZKTeco device pushes (`CMD_REG_EVENT`), so a badge is known within a second instead of within a five-minute poll cycle.

**Architecture:** A pure decoder in `src/codec/events.ts` (event flags, packet recognition, two attendance payload dialects), a one-way `listen()` mode on the existing transports, `Session.subscribe()` to register and flip the mode, and `src/realtime/Subscription.ts` turning pushed packets into an async iterable. One `ZkDevice` is either answering requests or listening, never both — the read commands throw while subscribed. Every test drives real localhost sockets through the emulator, which learns to push unsolicited packets.

**Tech Stack:** TypeScript 5.x, Node >= 20.19, vitest, tsup, pnpm. Runtime dependencies: none — `node:net` and `node:dgram` only.

**Spec:** `docs/superpowers/specs/2026-08-28-zkteco-realtime-events-design.md`
**Prior spec (still binding):** `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`
**Branch:** `feat/realtime-events`

## Global Constraints

- **Runtime:** Node `>=20.19`. Do not change `engines.node`.
- **Zero runtime dependencies.** `package.json` must keep `"dependencies": {}` literally. Only `node:net` and `node:dgram` may be imported at runtime. No native modules, ever. `node:events` is a built-in but is deliberately not used — see spec §4.1.
- **Language:** every file in the repository is written in English — README, JSDoc, code comments, commit messages.
- **No `any` on the public surface.** `pnpm typecheck` must pass clean before every commit.
- **The library never returns `Date`.** Realtime timestamps are `ZkNaiveTime`, decoded by the existing `decodeZkTime6` (v0.1 spec §4.1).
- **An identity is never fabricated.** `userId` is `null` unless the device sent a printable one. An empty string is not an identity (spec §4.4, §5.2).
- **Parse nothing that cannot be validated.** An unrecognised payload becomes `{ kind: 'unknown', ... }` with intact `raw` — never a partial decode (spec §4.3).
- **`pyzk` source is never read, opened, searched, translated, or paraphrased.** It is executed as a black box through its public API only (v0.1 spec §8). `zkteco-js` is MIT and may be read.
- **Every test runs over both transports** unless the scenario is genuinely transport-specific, in which case skip it explicitly with a stated reason (v0.1 convention). This plan adds **two**
  such skip, Task 10 scenario 6, plus the TCP-only half of scenario 9's teardown assertion.
  Ruling R3 during execution added a second skip at session level; CI then showed the
  scenario was not deterministic on Linux either, and it was removed rather than skipped —
  see that test file's comment for where the coverage actually lives.
- **The break-it discipline (spec §7.3):** for every regression test, temporarily break the code it guards, confirm the test goes red, and confirm it goes red on the *intended* assertion rather than collaterally. Restore the code. State in the commit message that this was done. This plan writes that step out explicitly; do not skip it.
- **Public export surface grows by exactly four names and one method** (spec §4). Nothing else in `src/index.ts`.
- **Do not run `npm publish`.** Publication remains a separate decision.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `src/codec/events.ts` | Event flags, mask encoding, event-packet recognition, attendance dialect decoding, `ackEvent`. Pure — no I/O, no async. | **create** |
| `src/codec/commands.ts` | Add `REG_EVENT: 500`. | modify |
| `src/types.ts` | Add `ZkRealtimeEvent`. | modify |
| `src/transport/Transport.ts` | Declare `listen()` and its contract. | modify |
| `src/transport/tcp.ts` | Implement `listen()`; release `buffered` on a rejected frame. | modify |
| `src/transport/udp.ts` | Implement `listen()`. | modify |
| `src/session/Session.ts` | `subscribe()`, `subscribed`, `transmit()` split out of `send()`, subscribed-aware `close()`. | modify |
| `src/realtime/Subscription.ts` | `SubscribeOptions`, `ZkEventStream`, the bounded queue and async iterator. | **create** |
| `src/ZkDevice.ts` | `subscribe()`, the subscribed-mode guard on the read commands. | modify |
| `src/index.ts` | Export the four new names; bump `VERSION`. | modify |
| `test/codec/events.spec.ts` | Unit tests for the pure decoder. | **create** |
| `test/transport/listen.spec.ts` | `listen()` semantics on both transports. | **create** |
| `test/realtime/subscription.spec.ts` | Queue, overflow, idle timeout, close. | **create** |
| `test/realtime/scenarios.spec.ts` | The nine end-to-end scenarios of spec §7.2. | **create** |
| `test/emulator/index.ts` | `pushEvent`, `pushRaw`, `REG_EVENT` handler, `pushWithAck`. | modify |
| `tools/oracle/capture_pyzk_realtime.py` | Black-box realtime driver for pyzk. | **create** |
| `tools/oracle/capture_zkjs_realtime.ts` | Realtime driver for zkteco-js. | **create** |
| `tools/oracle/capture.ts` | Add the realtime captures, written to their own directory. | modify |
| `test/oracle/realtime.spec.ts` | The §8.1 adjudication, asserted against the fixtures. | **create** |
| `test/fixtures/oracle/realtime/*.json` | Captured realtime wire bytes. Kept out of `test/fixtures/oracle/` proper so the checksum adjudication's exact-count guard keeps meaning what it claims. | **create** |
| `PROVENANCE.md` | Realtime sources and the adjudication result. | modify |
| `README.md` | The subscription, and that it does not reconnect. | modify |
| `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md` | Six items and three confirmations appended to §12. | modify |

---

## Task 1: Event flags and event-packet recognition

**Files:**
- Create: `src/codec/events.ts`
- Create: `test/codec/events.spec.ts`
- Modify: `src/codec/commands.ts`

**Interfaces:**
- Consumes: `DecodedPacket` from `src/codec/packet.ts`.
- Produces: `CMD.REG_EVENT`, `EVENT_FLAG`, `encodeEventMask(mask: number): Buffer`, `isEventPacket(pkt: DecodedPacket): boolean`, `readEventType(pkt: DecodedPacket): number`.

- [ ] **Step 1: Write the failing test**

Create `test/codec/events.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG, encodeEventMask, isEventPacket, readEventType } from '../../src/codec/events.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'

describe('event mask encoding', () => {
  it('encodes the attendance-only mask as the four bytes zkteco-js transmits', () => {
    expect(encodeEventMask(EVENT_FLAG.ATTENDANCE).toString('hex')).toBe('01000000')
  })

  it('encodes the all-events mask the specification uses in its example', () => {
    expect(encodeEventMask(0xffff).toString('hex')).toBe('ffff0000')
  })

  it('encodes a combined mask little-endian', () => {
    expect(encodeEventMask(EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM).toString('hex')).toBe('01020000')
  })
})

describe('event packet recognition', () => {
  // A pushed event carries the event type in the field that holds a session
  // id in every other packet, and a reply id of zero. Built here the way the
  // device is believed to build it.
  const pushed = (eventType: number, data: Buffer): ReturnType<typeof decodePayload> =>
    decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

  it('recognises a pushed event by its command', () => {
    expect(isEventPacket(pushed(EVENT_FLAG.ATTENDANCE, Buffer.alloc(0)))).toBe(true)
  })

  it('does not mistake an ordinary reply for an event', () => {
    const ack = decodePayload(encodePayload({ command: CMD.ACK_OK, sessionId: 0x1234, replyId: 7 }))
    expect(isEventPacket(ack)).toBe(false)
  })

  it('reads the event type out of the session-id slot', () => {
    expect(readEventType(pushed(EVENT_FLAG.ALARM, Buffer.alloc(0)))).toBe(EVENT_FLAG.ALARM)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: FAIL — `Failed to resolve import "../../src/codec/events.js"`.

- [ ] **Step 3: Add the command constant**

In `src/codec/commands.ts`, add one line to the `CMD` object, after `AUTH: 1102,`:

```ts
  REG_EVENT: 500,
```

- [ ] **Step 4: Write the minimal implementation**

Create `src/codec/events.ts`:

```ts
import { CMD } from './commands.js'
import type { DecodedPacket } from './packet.js'

/**
 * Realtime event flags, as published.
 *
 * The gap at 64 is in the source material, not an omission here: no flag is
 * documented at that bit.
 */
export const EVENT_FLAG = {
  ATTENDANCE: 1,
  FINGER: 2,
  ENROLL_USER: 4,
  ENROLL_FINGER: 8,
  BUTTON: 16,
  UNLOCK: 32,
  VERIFY: 128,
  FPFTR: 256,
  ALARM: 512,
} as const

/** The 4-byte little-endian mask CMD_REG_EVENT carries. */
export function encodeEventMask(mask: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(mask >>> 0, 0)
  return buf
}

/**
 * True when a decoded packet is an unsolicited realtime event.
 *
 * A device pushes these with the same command it was registered with. This
 * is deliberately the only test applied: the reply id is also believed to be
 * zero on every pushed packet, but adding that to the predicate would make a
 * device that numbers its pushes look like a non-event packet, which ends the
 * stream (spec §9.3). One condition, evidenced by two sources, is enough.
 */
export function isEventPacket(pkt: DecodedPacket): boolean {
  return pkt.command === CMD.REG_EVENT
}

/**
 * The event type of a pushed packet.
 *
 * It occupies the field that carries a session id in every other packet. Two
 * independent sources agree on that — the protocol documentation writes these
 * packets with an event where a session id would be and no session id at all,
 * and zkteco-js reads the type from that same offset — and neither source is
 * a device. First-hardware checklist item.
 */
export function readEventType(pkt: DecodedPacket): number {
  return pkt.sessionId
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the break-it check**

Change `readEventType` to `return pkt.replyId`. Run the same command.
Expected: the "reads the event type out of the session-id slot" test FAILS with `expected 0 to be 512`. Restore `return pkt.sessionId`.

Then change `isEventPacket` to `return pkt.command === CMD.REG_EVENT && pkt.replyId === 0`. Run again.
Expected: still PASS — which is the point of the JSDoc note; the predicate is deliberately looser than the evidence would allow. Restore the single-condition body.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/codec/commands.ts src/codec/events.ts test/codec/events.spec.ts
git commit -m "feat(codec): recognise realtime event packets

CMD_REG_EVENT is 500, and a pushed event carries its event type in the
field that holds a session id in every other packet. Two independent
sources agree on that layout and neither is a device, so it is a
first-hardware checklist item rather than a settled fact.

Break-it check: readEventType pointed at replyId fails the session-id
slot test on the intended assertion."
```

---

## Task 2: Realtime attendance payload dialects

**Files:**
- Modify: `src/codec/events.ts`
- Modify: `test/codec/events.spec.ts`

**Interfaces:**
- Consumes: `decodeZkTime6` from `src/codec/time.ts`, `ZkNaiveTime` from `src/types.ts`.
- Produces: `interface RealtimeAttendance { userId: string | null; uid: number | null; timestamp: ZkNaiveTime; verifyMode: number | null }` and `decodeRealtimeAttendance(data: Buffer): RealtimeAttendance | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/codec/events.spec.ts`:

```ts
import { decodeRealtimeAttendance } from '../../src/codec/events.js'

/** The large dialect: 9-byte printed id, 15 zero bytes, verify type, 6-byte time. */
function largeEvent(userId: string, verifyMode: number, trailing = 4): Buffer {
  const buf = Buffer.alloc(32 + trailing)
  buf.write(userId, 0, 9, 'ascii')
  buf.writeUInt16LE(verifyMode, 24)
  buf.set([26, 8, 27, 8, 1, 30], 26) // 2026-08-27T08:01:30
  return buf
}

/** The small dialect: uid, three unknown bytes, 6-byte time. */
function smallEvent(uid: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.writeUInt8(uid, 0)
  buf.set([26, 8, 27, 8, 1, 30], 4)
  return buf
}

describe('realtime attendance dialects', () => {
  it('decodes the large dialect, printed identity and all', () => {
    const got = decodeRealtimeAttendance(largeEvent('0001234', 1))
    expect(got).toEqual({
      userId: '0001234',
      uid: null,
      verifyMode: 1,
      timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }),
    })
  })

  it('decodes the large dialect at exactly 32 bytes, with no trailing bytes', () => {
    expect(decodeRealtimeAttendance(largeEvent('7', 0, 0))?.userId).toBe('7')
  })

  it('reports no identity when the printed id field is empty, rather than an empty string', () => {
    const got = decodeRealtimeAttendance(largeEvent('', 0))
    expect(got?.userId).toBeNull()
    expect(got?.timestamp.local).toBe('2026-08-27T08:01:30')
  })

  // Node's 'ascii' decoding masks the high bit, so 0xc1 would read back as
  // 'A'. A byte that is not printable ASCII must not become a plausible
  // identifier; it must become no identifier at all.
  it('reports no identity when the id field holds bytes outside printable ASCII', () => {
    const buf = largeEvent('', 0)
    buf.set([0xc1, 0xc2, 0xc3], 0)
    expect(decodeRealtimeAttendance(buf)?.userId).toBeNull()
  })

  it('decodes the small dialect, which carries a uid and no printed identity', () => {
    expect(decodeRealtimeAttendance(smallEvent(5))).toEqual({
      userId: null,
      uid: 5,
      verifyMode: null,
      timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }),
    })
  })

  it('refuses to decode a length matching neither dialect', () => {
    expect(decodeRealtimeAttendance(Buffer.alloc(20))).toBeNull()
    expect(decodeRealtimeAttendance(Buffer.alloc(31))).toBeNull()
    expect(decodeRealtimeAttendance(Buffer.alloc(0))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: FAIL — `decodeRealtimeAttendance is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/codec/events.ts`:

```ts
import { decodeZkTime6 } from './time.js'
import type { ZkNaiveTime } from '../types.js'

/** Smallest payload that can hold the documented large layout. */
const LARGE_MIN_LENGTH = 32
/** The only length the small dialect has ever been observed at. */
const SMALL_LENGTH = 10
const PRINTED_ID_LENGTH = 9
const PRINTED_ID_OFFSET = 0
const VERIFY_MODE_OFFSET = 24
const LARGE_TIME_OFFSET = 26
const SMALL_UID_OFFSET = 0
const SMALL_TIME_OFFSET = 4

export interface RealtimeAttendance {
  /** The identifier printed on the device, or null when none was sent. */
  userId: string | null
  /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
  uid: number | null
  timestamp: ZkNaiveTime
  /** Raw verification method. Model-dependent, deliberately not decoded. */
  verifyMode: number | null
}

/**
 * Reads a fixed-width identifier field, or returns null if it holds anything
 * that is not a printable identifier.
 *
 * Deliberately not `readNulTerminated` from records/shared.ts: that decodes
 * with Node's 'ascii', which MASKS THE HIGH BIT, so a field of 0xc1 0xc2 0xc3
 * reads back as "ABC" — a fabricated identity that no caller could tell from
 * a real one. The bytes are validated before they are decoded.
 */
function readPrintableId(buf: Buffer, start: number, length: number): string | null {
  const field = buf.subarray(start, start + length)
  const nul = field.indexOf(0)
  const body = field.subarray(0, nul === -1 ? field.length : nul)
  if (body.length === 0) return null
  for (const byte of body) {
    if (byte < 0x20 || byte > 0x7e) return null
  }
  return body.toString('ascii')
}

/**
 * Decodes a realtime attendance payload, or returns null when its length
 * matches no known dialect.
 *
 * Dialect selection is by LENGTH, never by transport. zkteco-js picks its
 * decoder by transport — one layout on TCP, another on UDP — which conflates
 * a model-dependent record dialect with the socket it arrived on. Record
 * dialects in this protocol already vary by model (8/16/40-byte attendance
 * records), and nothing about a datagram makes a device pack a timestamp
 * differently.
 *
 * The large dialect is documented at exactly 32 bytes; observed packets carry
 * 36. The four extra bytes are undocumented, are not interpreted, and survive
 * in the caller's `raw`. Hence `>=` rather than `===`: a device with trailing
 * bytes is decoded rather than discarded. First-hardware checklist item.
 */
export function decodeRealtimeAttendance(data: Buffer): RealtimeAttendance | null {
  if (data.length >= LARGE_MIN_LENGTH) {
    return {
      userId: readPrintableId(data, PRINTED_ID_OFFSET, PRINTED_ID_LENGTH),
      uid: null,
      verifyMode: data.readUInt16LE(VERIFY_MODE_OFFSET),
      timestamp: decodeZkTime6(data, LARGE_TIME_OFFSET),
    }
  }
  if (data.length === SMALL_LENGTH) {
    // The uid field's width rests on a SINGLE source, which read one byte.
    // One source cannot distinguish a uint8 from a uint16 LE holding a small
    // value, and the protocol documentation does not describe this dialect at
    // all. First-hardware checklist item.
    return {
      userId: null,
      uid: data.readUInt8(SMALL_UID_OFFSET),
      verifyMode: null,
      timestamp: decodeZkTime6(data, SMALL_TIME_OFFSET),
    }
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the break-it check**

Replace the body of `readPrintableId` with a call to the shared helper:

```ts
  return readNulTerminated(buf, start, length)
```

(importing `readNulTerminated` from `./records/shared.js`). Run the tests.
Expected: TWO failures on the intended assertions — the empty-field test gets `''` instead of `null`, and the non-ASCII test gets `'ABC'` instead of `null`. This is the exact trap the helper exists to avoid. Restore the implementation and remove the import.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/codec/events.ts test/codec/events.spec.ts
git commit -m "feat(codec): decode both realtime attendance dialects

Selection is by payload length, not by transport. zkteco-js picks its
decoder by transport, which conflates a model-dependent dialect with the
socket it arrived on.

The identifier field is validated before it is decoded. Node's 'ascii'
masks the high bit, so 0xc1 0xc2 0xc3 would otherwise read back as 'ABC'
— a fabricated identity indistinguishable from a real one.

Break-it check: swapping in readNulTerminated fails the empty-field and
non-ASCII tests on their intended assertions."
```

---

## Task 3: The public event type

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codec/events.ts`
- Modify: `test/codec/events.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `ZkRealtimeEvent` (exported from `src/types.ts`) and `decodeRealtimeEvent(pkt: DecodedPacket): ZkRealtimeEvent`.

- [ ] **Step 1: Write the failing tests**

Append to `test/codec/events.spec.ts`:

```ts
import { decodeRealtimeEvent } from '../../src/codec/events.js'

describe('decodeRealtimeEvent', () => {
  const push = (eventType: number, data: Buffer) =>
    decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

  it('marks a printed identity as coming from the device itself', () => {
    const ev = decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, largeEvent('0001234', 1)))
    expect(ev).toMatchObject({
      kind: 'attendance',
      eventType: EVENT_FLAG.ATTENDANCE,
      userId: '0001234',
      userIdSource: 'device',
      uid: null,
      verifyMode: 1,
    })
  })

  it('leaves userIdSource null when no identity was sent', () => {
    const ev = decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, smallEvent(9)))
    expect(ev).toMatchObject({ kind: 'attendance', userId: null, userIdSource: null, uid: 9 })
  })

  it('surfaces an event type it cannot decode, with its bytes intact', () => {
    const data = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    expect(decodeRealtimeEvent(push(EVENT_FLAG.ALARM, data))).toEqual({
      kind: 'unknown',
      eventType: EVENT_FLAG.ALARM,
      raw: 'deadbeef',
    })
  })

  it('surfaces an attendance payload of unknown length rather than decoding part of it', () => {
    const data = Buffer.alloc(20, 0x11)
    expect(decodeRealtimeEvent(push(EVENT_FLAG.ATTENDANCE, data))).toEqual({
      kind: 'unknown',
      eventType: EVENT_FLAG.ATTENDANCE,
      raw: '11'.repeat(20),
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: FAIL — `decodeRealtimeEvent is not a function`.

- [ ] **Step 3: Add the public type**

Append to `src/types.ts`:

```ts
/**
 * One event a device pushed while a subscription was active.
 *
 * Deliberately NOT a `ZkAttendanceLog`. The realtime payload carries no
 * in/out status field and belongs to no 8/16/40-byte record dialect, so
 * reusing that type would mean fabricating both `status` and `recordSize`.
 */
export type ZkRealtimeEvent =
  | {
      kind: 'attendance'
      /** The EVENT_FLAG value the device pushed this under. */
      eventType: number
      /**
       * The identifier printed on the device. `null` when the dialect carried
       * none — never an empty string, and never resolved through the user
       * list: device-internal uids are recycled after a deletion, so a lookup
       * can attribute a punch to the wrong person with no error anywhere.
       */
      userId: string | null
      /** 'device' when the record itself supplied the id, null when it did not. */
      userIdSource: 'device' | null
      /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
      uid: number | null
      timestamp: ZkNaiveTime
      /** Raw verification method. Model-dependent, deliberately not decoded. */
      verifyMode: number | null
      /** Hex of the event payload. */
      raw: string
    }
  | {
      kind: 'unknown'
      eventType: number
      /** Hex of the event payload, undecoded and complete. */
      raw: string
    }
```

- [ ] **Step 4: Write the minimal implementation**

Append to `src/codec/events.ts` (add `ZkRealtimeEvent` to the existing `../types.js` type import):

```ts
/**
 * Maps a pushed packet onto the public event type.
 *
 * Anything not decodable becomes `kind: 'unknown'` carrying its bytes.
 * Nothing is ever decoded partially, and an unknown event never ends a
 * stream — an unfamiliar dialect should be reportable, not invisible.
 */
export function decodeRealtimeEvent(pkt: DecodedPacket): ZkRealtimeEvent {
  const eventType = readEventType(pkt)
  const raw = pkt.data.toString('hex')
  if (eventType !== EVENT_FLAG.ATTENDANCE) return { kind: 'unknown', eventType, raw }
  const decoded = decodeRealtimeAttendance(pkt.data)
  if (!decoded) return { kind: 'unknown', eventType, raw }
  return {
    kind: 'attendance',
    eventType,
    userId: decoded.userId,
    userIdSource: decoded.userId === null ? null : 'device',
    uid: decoded.uid,
    timestamp: decoded.timestamp,
    verifyMode: decoded.verifyMode,
    raw,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/codec/events.spec.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Run the break-it check**

Change `userIdSource` to the constant `'device'`. Run the tests.
Expected: the "leaves userIdSource null when no identity was sent" test FAILS on `userIdSource`. Restore.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/types.ts src/codec/events.ts test/codec/events.spec.ts
git commit -m "feat(types): ZkRealtimeEvent, a distinct type from ZkAttendanceLog

The realtime payload has no in/out status and no record-size dialect, so
reusing ZkAttendanceLog would mean fabricating both fields.

An undecodable payload becomes kind:'unknown' with its bytes intact
rather than a partial decode, and an absent identity leaves userIdSource
null rather than claiming the device supplied one.

Break-it check: hardcoding userIdSource to 'device' fails the
no-identity test on the intended assertion."
```

---

## Task 4: Release the TCP accumulator when a frame is rejected

This is the outstanding v0.1 finding (handoff §9.1). It is done first, before `listen()` touches the same file.

**Files:**
- Modify: `src/transport/tcp.ts`
- Modify: `test/transport/tcp.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Append to `test/transport/tcp.spec.ts`, inside its existing `describe`. Adapt the local variable names to whatever that file already uses for its emulator and transport handles; the assertions are what matter.

```ts
  // A rejected declared length used to leave every byte of the offending
  // chunk in the accumulator forever: the permanent-hang defect was fixed in
  // v0.1 but the growth was not. `buffered` is private, and this asserts on
  // it deliberately — the finding is specifically about that field, and a
  // behavioural proxy would pass while the leak remained.
  it('releases the accumulator when a declared length is rejected', async () => {
    const emulator = await startEmulator({ transport: 'tcp' })
    try {
      const transport = new TcpTransport({ host: '127.0.0.1', port: emulator.port })
      await transport.connect()
      const pending = transport.receive(2000)

      const bogus = Buffer.alloc(8 + 64)
      START_MARKER.copy(bogus, 0)
      bogus.writeUInt32LE(0xffffff, 4) // far past MAX_DECLARED_SIZE
      for (const socket of emulator.sockets) socket.write(bogus)

      await expect(pending).rejects.toThrow(ZkProtocolError)
      expect((transport as unknown as { buffered: Buffer }).buffered.length).toBe(0)
      await transport.close()
    } finally {
      await emulator.close()
    }
  })
```

This needs the emulator to expose its sockets. Add to the `Emulator` interface in `test/emulator/index.ts`:

```ts
  /** Live client sockets. TCP only; empty on UDP. Lets a test write raw bytes. */
  readonly sockets: ReadonlySet<net.Socket>
```

and return `sockets` from the TCP branch, `new Set<net.Socket>()` from the UDP branch.

Import `START_MARKER` from `../../src/codec/framing.js` and `ZkProtocolError` from `../../src/errors.js` in the test file if they are not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/transport/tcp.spec.ts`
Expected: FAIL with `expected 72 to be 0` — the rejection happens, the accumulator keeps the bytes.

- [ ] **Step 3: Write the minimal implementation**

In `src/transport/tcp.ts`, in `absorb`, change the catch block:

```ts
      } catch (err) {
        // Release the accumulator along with failing the connection. The
        // bytes cannot be re-parsed — the frame they belong to was rejected —
        // and holding them keeps a rejected oversized length costing memory
        // for the life of the object.
        this.buffered = Buffer.alloc(0)
        this.fail(err as Error)
        return
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/transport/tcp.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the break-it check**

Remove the `this.buffered = Buffer.alloc(0)` line. Run the test.
Expected: FAIL on the `buffered.length` assertion, not on the rejects assertion. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/transport/tcp.ts test/transport/tcp.spec.ts test/emulator/index.ts
git commit -m "fix(transport): release the accumulator when a frame is rejected

Outstanding finding from the v0.1 review: the permanent-hang defect was
fixed, the unbounded growth was not. A rejected declared length left
every byte of the offending chunk in the accumulator for the life of the
transport.

The test asserts on the private field deliberately — the finding is about
that field, and a behavioural proxy would pass while the leak remained.

Break-it check: removing the release fails on the buffered.length
assertion, not collaterally on the rejection."
```

---

## Task 5: `listen()` on both transports

The interface gains a method, so both implementations must land together or `pnpm typecheck` fails.

**Files:**
- Modify: `src/transport/Transport.ts`, `src/transport/tcp.ts`, `src/transport/udp.ts`
- Create: `test/transport/listen.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Transport.listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void` on both `TcpTransport` and `UdpTransport`.

- [ ] **Step 1: Write the failing tests**

Create `test/transport/listen.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload, decodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError } from '../../src/errors.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import type { Transport } from '../../src/transport/Transport.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: Transport | null = null
afterEach(async () => {
  await transport?.close().catch(() => {}); transport = null
  await running?.close(); running = null
})

const event = (eventType: number, byte: number): Buffer =>
  encodePayload({
    command: CMD.REG_EVENT,
    sessionId: eventType,
    replyId: 0,
    data: Buffer.from([byte]),
  })

/** Resolves once `count` packets have reached the listener. */
function collector(count: number): {
  onPacket: (p: Buffer) => void
  onError: (e: Error) => void
  packets: Promise<Buffer[]>
  errors: Error[]
} {
  const got: Buffer[] = []
  const errors: Error[] = []
  let settle: (v: Buffer[]) => void = () => {}
  const packets = new Promise<Buffer[]>((resolve) => { settle = resolve })
  return {
    packets,
    errors,
    onPacket: (p) => { got.push(p); if (got.length >= count) settle(got) },
    onError: (e) => { errors.push(e) },
  }
}

for (const kind of ['tcp', 'udp'] as const) {
  const make = (port: number): Transport =>
    kind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Transport.listen over ${kind}`, () => {
    it('delivers packets that arrive after listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      // The emulator only knows where to push once it has heard from us.
      await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
      await transport.receive(2000)

      const sink = collector(2)
      transport.listen(sink.onPacket, sink.onError)
      running.pushEvent(1, Buffer.from([0xaa]))
      running.pushEvent(1, Buffer.from([0xbb]))

      const got = await sink.packets
      expect(got.map((p) => decodePayload(p).data.toString('hex'))).toEqual(['aa', 'bb'])
    })

    // A packet that lands between a reply and the listen() call is a real
    // event. Both transports park it in a queue; dropping it on the mode
    // switch would lose a punch with no error anywhere.
    it('drains packets that were queued before listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
      await transport.receive(2000)

      running.pushEvent(1, Buffer.from([0xcc]))
      await new Promise((r) => setTimeout(r, 50)) // let it land in the queue, unclaimed

      const sink = collector(1)
      transport.listen(sink.onPacket, sink.onError)
      const got = await sink.packets
      expect(decodePayload(got[0]!).data.toString('hex')).toBe('cc')
    })

    it('refuses a receive() once listening', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      transport.listen(() => {}, () => {})
      await expect(transport.receive(500)).rejects.toThrow(ZkConnectionError)
    })

    it('refuses a second listen()', async () => {
      running = await startEmulator({ transport: kind })
      transport = make(running.port)
      await transport.connect()
      transport.listen(() => {}, () => {})
      expect(() => transport!.listen(() => {}, () => {})).toThrow(ZkConnectionError)
    })
  })
}

describe('Transport.listen over tcp, failure paths', () => {
  // UDP has no connection to lose and no socket-level failure to replay, so
  // these two are TCP-only by nature rather than by omission. On UDP a dead
  // device is silence, which is what SubscribeOptions.idleTimeoutMs is for.
  it('reports a socket failure to the listener', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)
    for (const socket of running.sockets) socket.destroy()
    await new Promise((r) => setTimeout(r, 100))
    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
  })

  it('reports a failure that was already recorded before listen()', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    for (const socket of running.sockets) socket.destroy()
    await new Promise((r) => setTimeout(r, 100))

    const sink = collector(1)
    transport.listen(sink.onPacket, sink.onError)
    expect(sink.errors[0]).toBeInstanceOf(ZkConnectionError)
  })
})
```

This test file uses `running.pushEvent`, which Task 6 implements. Write Task 6 first if executing strictly in order — or, equivalently, do Task 6's Step 3 (`pushEvent`) here and drop it from Task 6. **Do not leave both undone.** The plan orders them 5 then 6 because `listen()` is the deliverable being reviewed; the emulator method is scaffolding for it.

- [ ] **Step 2: Add `pushEvent` and `pushRaw` to the emulator**

In `test/emulator/index.ts`, extend the `Emulator` interface:

```ts
  /** Pushes an unsolicited realtime event to the connected client. */
  pushEvent(eventType: number, data: Buffer): void
  /** Pushes arbitrary bytes as one packet — for the not-an-event scenario. */
  pushRaw(payload: Buffer): void
```

Add a builder next to `reply`:

```ts
/**
 * Builds one unsolicited realtime event.
 *
 * NOTE: this uses the LIBRARY'S OWN encoder, so a test that only round-trips
 * through the emulator proves the plumbing, not the layout. What makes the
 * event-type-in-the-session-id-slot claim evidence is an independent
 * implementation decoding these bytes — see test/oracle/realtime.spec.ts.
 */
export function eventPacket(eventType: number, data: Buffer): Buffer {
  return encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data })
}
```

In the TCP branch, return:

```ts
      pushRaw: (payload) => { for (const s of sockets) s.write(frameTcp(payload)) },
      pushEvent: (eventType, data) => {
        for (const s of sockets) s.write(frameTcp(eventPacket(eventType, data)))
      },
```

In the UDP branch, record the last client and push to it. Add above `sock.on('message', ...)`:

```ts
  let lastClient: { port: number; address: string } | null = null
```

set it inside the message handler (`lastClient = { port: rinfo.port, address: rinfo.address }`), and return:

```ts
    pushRaw: (payload) => {
      if (lastClient) sock.send(payload, lastClient.port, lastClient.address)
    },
    pushEvent: (eventType, data) => {
      if (lastClient) sock.send(eventPacket(eventType, data), lastClient.port, lastClient.address)
    },
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run test/transport/listen.spec.ts`
Expected: FAIL — `transport.listen is not a function`.

- [ ] **Step 4: Declare the method on the interface**

In `src/transport/Transport.ts`, add to the `Transport` interface and extend the doc comment:

```ts
export interface Transport {
  connect(): Promise<void>
  send(payload: Buffer): Promise<void>
  receive(timeoutMs: number): Promise<Buffer>
  /**
   * Switches this transport to push mode for a realtime subscription.
   *
   * ONE-WAY, ONCE PER SOCKET. After `listen()`, `receive()` rejects and a
   * second `listen()` throws. Ending a subscription closes the connection, so
   * no socket ever returns to request-response mode; one irreversible
   * transition is a state machine that can be enumerated in tests, which a
   * two-way router is not.
   *
   * Any packet already parked in the receive queue is handed to `onPacket`
   * before this returns, and an already-recorded socket failure is handed to
   * `onError` before this returns. Both matter: a packet that lands between a
   * reply and this call is a real event, and a listener attached over a dead
   * socket that then waits forever is a hang rather than a failure.
   */
  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void
  close(): Promise<void>
}
```

- [ ] **Step 5: Implement it on TCP**

In `src/transport/tcp.ts`, add fields:

```ts
  private listener: ((payload: Buffer) => void) | null = null
  private listenerError: ((err: Error) => void) | null = null
```

Add the constant near the top of the file:

```ts
/** Idle seconds before the OS probes a listening connection. */
const KEEPALIVE_DELAY_MS = 30_000
```

Route packets in `absorb`, replacing the `const waiter = this.waiter` block:

```ts
      const listener = this.listener
      if (listener) {
        listener(framed.payload)
        continue
      }
      const waiter = this.waiter
```

Route failures in `fail`, after the existing `failWaiter` handling:

```ts
    const listenerError = this.listenerError
    if (listenerError) listenerError(err)
```

Guard `receive`, as the first statement:

```ts
    if (this.listener) {
      return Promise.reject(
        new ZkConnectionError('this transport is listening for events; receive() is not available'),
      )
    }
```

Add the method:

```ts
  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    if (this.listener) {
      throw new ZkConnectionError('this transport is already listening')
    }
    if (this.waiter) {
      throw new ZkConnectionError('cannot listen while a receive() is pending')
    }
    this.listener = onPacket
    this.listenerError = onError
    // A dead peer on a listening connection is otherwise indistinguishable
    // from a quiet one, and a quiet one is normal at 03:00.
    this.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS)
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
    if (this.failure) onError(this.failure)
  }
```

- [ ] **Step 6: Implement it on UDP**

In `src/transport/udp.ts`, add the same two fields, route in the `message` handler:

```ts
      sock.on('message', (msg) => {
        const payload = Buffer.from(msg)
        const listener = this.listener
        if (listener) { listener(payload); return }
        const waiter = this.waiter
        if (waiter) { this.waiter = null; waiter(payload) } else { this.queue.push(payload) }
      })
```

guard `receive` with the same first statement as TCP, and add:

```ts
  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    if (this.listener) {
      throw new ZkConnectionError('this transport is already listening')
    }
    if (this.waiter) {
      throw new ZkConnectionError('cannot listen while a receive() is pending')
    }
    this.listener = onPacket
    // Retained for symmetry with TCP and for a future datagram error path.
    // UDP has no connection to lose, so nothing calls it today: a dead device
    // is indistinguishable from a quiet one here, which is what
    // SubscribeOptions.idleTimeoutMs exists for.
    this.listenerError = onError
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run test/transport/listen.spec.ts`
Expected: PASS, 10 tests (four per transport plus two TCP-only failure tests).

- [ ] **Step 8: Run the break-it check**

Delete the two lines that drain the queue in `TcpTransport.listen` (`const queued = ...` through the `for` loop). Run the tests.
Expected: the TCP "drains packets that were queued before listen()" test times out on its own assertion. Restore, then do the same to `UdpTransport.listen` and confirm the UDP one fails. Restore.

Then delete `if (this.failure) onError(this.failure)`. Run.
Expected: "reports a failure that was already recorded before listen()" fails on `sink.errors[0]`. Restore.

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/transport/ test/transport/listen.spec.ts test/emulator/index.ts
git commit -m "feat(transport): one-way listen() mode for realtime subscriptions

Registration is request-response and must share the subscription's
socket, so the mode goes on the existing transports rather than into a
streaming sibling that would duplicate the framing accumulator. This
deviates from the handoff's suggestion; the design spec §3.2 and §10 say
why.

The transition is one-way per socket: receive() rejects afterwards and a
second listen() throws. listen() drains the receive queue and replays an
already-recorded failure — a packet arriving between a reply and this
call is a real event, and a listener over a dead socket would otherwise
hang instead of failing.

Break-it check: removing the drain times out the queued-packet test on
both transports; removing the failure replay fails the recorded-failure
test. Both on their intended assertions."
```

---

## Task 6: The emulator registers subscriptions

**Files:**
- Modify: `test/emulator/index.ts`
- Modify: `test/emulator/emulator.spec.ts`

**Interfaces:**
- Consumes: `pushEvent` / `pushRaw` / `eventPacket` from Task 5.
- Produces: a `CMD.REG_EVENT` handler, `EmulatorState.eventMask`, and `EmulatorOptions.pushWithAck`.

- [ ] **Step 1: Write the failing test**

Append to `test/emulator/emulator.spec.ts`:

```ts
  it('acknowledges a subscription and records the mask it was given', async () => {
    const emulator = await startEmulator({ transport: 'tcp' })
    try {
      const transport = new TcpTransport({ host: '127.0.0.1', port: emulator.port })
      await transport.connect()
      await transport.send(
        encodePayload({
          command: CMD.REG_EVENT,
          sessionId: 1,
          replyId: 0,
          data: Buffer.from([0x01, 0x00, 0x00, 0x00]),
        }),
      )
      const reply = decodePayload(await transport.receive(2000))
      expect(reply.command).toBe(CMD.ACK_OK)
      expect(emulator.state.eventMask).toBe(1)
      await transport.close()
    } finally {
      await emulator.close()
    }
  })

  // The registration ack and the events are written in one tick, so the
  // client's absorb() consumes the ack with its pending waiter and finds no
  // waiter for the events, which land in the queue. That is the queued-packet
  // race the listen() drain exists for, made deterministic.
  it('can push events in the same write as the registration ack', async () => {
    const emulator = await startEmulator({
      transport: 'tcp',
      pushWithAck: [{ eventType: 1, data: Buffer.from([0x01]) }],
    })
    try {
      const transport = new TcpTransport({ host: '127.0.0.1', port: emulator.port })
      await transport.connect()
      await transport.send(
        encodePayload({ command: CMD.REG_EVENT, sessionId: 1, replyId: 0, data: Buffer.alloc(4) }),
      )
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
      // The event arrived too, and is waiting.
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.REG_EVENT)
      await transport.close()
    } finally {
      await emulator.close()
    }
  })
```

Add whatever imports that file is missing (`CMD`, `encodePayload`, `decodePayload`, `TcpTransport`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/emulator/emulator.spec.ts`
Expected: FAIL — the emulator answers `ACK_ERROR` for the unknown command 500, so `expect(reply.command).toBe(CMD.ACK_OK)` fails with `expected 2001 to be 2000`.

- [ ] **Step 3: Write the implementation**

In `test/emulator/index.ts`:

Add to `EmulatorOptions`:

```ts
  /**
   * Events written in the SAME handler return as the registration ack, so
   * they land while the client still has no listener attached. Deterministic:
   * the ack consumes the pending waiter, the events find none and queue.
   */
  pushWithAck?: Array<{ eventType: number; data: Buffer }>
```

Add to `EmulatorState`:

```ts
  /** The mask the client last registered with, or null if it never did. */
  eventMask: number | null
```

Initialise it in `buildState` with `eventMask: null`.

Add to `baseHandlers`:

```ts
  [CMD.REG_EVENT]: (req, state) => {
    state.eventMask = req.data.length >= 4 ? req.data.readUInt32LE(0) : 0
    const ack = reply(state, req, CMD.ACK_OK)
    const pushes = state.opts.pushWithAck ?? []
    return [ack, ...pushes.map((p) => eventPacket(p.eventType, p.data))]
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/emulator/emulator.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the break-it check**

Reverse the returned array to `[...pushes.map(...), ack]`. Run the tests.
Expected: the same-write test fails on the FIRST assertion — the event arrives where the ack was expected. This confirms the ordering the test depends on is the ordering the emulator produces, rather than a timing accident. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add test/emulator/
git commit -m "test(emulator): register subscriptions and push unsolicited events

pushWithAck writes events in the same handler return as the registration
ack, which makes the queued-before-listen race deterministic instead of a
timing accident: the ack consumes the pending waiter, the events find
none and queue.

Break-it check: reversing the returned array fails the ordering assertion
the test depends on."
```

---

## Task 7: `Session.subscribe()`

**Files:**
- Modify: `src/session/Session.ts`
- Create: `test/session/subscribe.spec.ts`

**Interfaces:**
- Consumes: `encodeEventMask` (Task 1), `Transport.listen` (Task 5), the emulator's `REG_EVENT` handler (Task 6).
- Produces: `Session.subscribe(mask: number, onPacket: (pkt: DecodedPacket) => void, onError: (err: Error) => void): Promise<void>` and `get subscribed(): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/session/subscribe.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkProtocolError } from '../../src/errors.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import type { DecodedPacket } from '../../src/codec/packet.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const kind of ['tcp', 'udp'] as const) {
  const make = (port: number) =>
    kind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Session.subscribe over ${kind}`, () => {
    it('registers with the four-byte mask and reports itself subscribed', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})

      const registration = running.received.find((p) => p.command === CMD.REG_EVENT)
      expect(registration?.data.toString('hex')).toBe('01000000')
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE)
      expect(session.subscribed).toBe(true)
    })

    it('delivers pushed events to the packet handler', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      const seen: DecodedPacket[] = []
      let settle: () => void = () => {}
      const arrived = new Promise<void>((r) => { settle = r })
      await session.subscribe(
        EVENT_FLAG.ATTENDANCE,
        (pkt) => { seen.push(pkt); settle() },
        () => {},
      )
      running.pushEvent(EVENT_FLAG.ATTENDANCE, Buffer.from([0x42]))
      await arrived
      expect(seen[0]?.command).toBe(CMD.REG_EVENT)
      expect(seen[0]?.sessionId).toBe(EVENT_FLAG.ATTENDANCE)
    })

    it('delivers events that arrived alongside the registration ack', async () => {
      running = await startEmulator({
        transport: kind,
        pushWithAck: [
          { eventType: EVENT_FLAG.ATTENDANCE, data: Buffer.from([0x01]) },
          { eventType: EVENT_FLAG.ATTENDANCE, data: Buffer.from([0x02]) },
        ],
      })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      const seen: DecodedPacket[] = []
      await session.subscribe(EVENT_FLAG.ATTENDANCE, (pkt) => seen.push(pkt), () => {})
      expect(seen.map((p) => p.data.toString('hex'))).toEqual(['01', '02'])
    })

    // A device that does not support realtime must cost one call, not the
    // connection: the caller can still poll with it.
    it('throws on a refused registration and leaves the session usable', async () => {
      running = await startEmulator({
        transport: kind,
        handlers: { [CMD.REG_EVENT]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})).rejects.toThrow(
        ZkProtocolError,
      )
      expect(session.subscribed).toBe(false)
      await expect(session.execute(CMD.GET_FREE_SIZES)).resolves.toBeDefined()
    })
  })
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/session/subscribe.spec.ts`
Expected: FAIL — `session.subscribe is not a function`.

- [ ] **Step 3: Split the transmit half out of `send`**

In `src/session/Session.ts`, replace the body of the private `send` with two methods, keeping its whole existing JSDoc block on `send`:

```ts
  /** Encodes and transmits one request without awaiting a reply. */
  private async transmit(
    command: number,
    data?: Buffer,
    override?: { sessionId: number },
  ): Promise<void> {
    const sessionId = override?.sessionId ?? this.currentSessionId
    const payload = encodePayload({ command, sessionId, replyId: this.replyId, data })
    this.replyId = (this.replyId + 1) & 0xffff
    await this.transport.send(payload)
  }

  private async send(
    command: number,
    data?: Buffer,
    override?: { sessionId: number },
  ): Promise<DecodedPacket> {
    await this.transmit(command, data, override)
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }
```

- [ ] **Step 4: Add `subscribe` and `subscribed`**

Add the field beside `open_`:

```ts
  private subscribed_ = false
```

and the accessor beside `sessionId`:

```ts
  /** True once this session has switched its transport to listening. */
  get subscribed(): boolean {
    return this.subscribed_
  }
```

and the method, after `execute`:

```ts
  /**
   * Registers for realtime events and switches the transport to listening.
   *
   * The registration itself is an ordinary request-response exchange, which
   * is why it runs before the mode flip and over the same socket. A refused
   * registration throws and leaves the session in request mode: firmware
   * without realtime support costs one call, not the connection.
   */
  async subscribe(
    mask: number,
    onPacket: (pkt: DecodedPacket) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const res = await this.send(CMD.REG_EVENT, encodeEventMask(mask))
    if (res.command !== CMD.ACK_OK) {
      throw new ZkProtocolError(
        `device refused a realtime subscription with command ${res.command}`,
      )
    }
    this.subscribed_ = true
    this.transport.listen((payload) => {
      // A malformed push must reach the subscription as an error rather than
      // throw inside a socket data handler, where nothing would catch it.
      try {
        onPacket(decodePayload(payload))
      } catch (err) {
        onError(err as Error)
      }
    }, onError)
  }
```

Import `encodeEventMask` from `../codec/events.js`.

- [ ] **Step 5: Make `close()` subscription-aware**

Replace the body of `close`:

```ts
  async close(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    if (this.subscribed_) {
      // The socket is listening, so a reply could never be read — the goodbye
      // is sent without awaiting one. It is still sent: on UDP there is no
      // connection close to tell the device the session is over, so skipping
      // it would leave the device holding the session slot.
      await this.transmit(CMD.EXIT).catch(() => {})
      this.subscribed_ = false
      await this.transport.close()
      return
    }
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close()
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run test/session/subscribe.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the break-it check**

Set `this.subscribed_ = true` before the `res.command !== CMD.ACK_OK` check. Run the tests.
Expected: "throws on a refused registration and leaves the session usable" fails on `expect(session.subscribed).toBe(false)`. Restore.

Then remove the `try`/`catch` around `onPacket(decodePayload(payload))` and confirm the suite still passes — it will, because no test pushes a malformed packet yet; that gap is closed by Task 10 scenario 5. Restore the guard and note this in the commit rather than pretending it was covered.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/session/Session.ts test/session/subscribe.spec.ts
git commit -m "feat(session): register realtime subscriptions

subscribe() sends CMD_REG_EVENT over the ordinary request-response path,
then flips the transport to listening. A refused registration throws and
leaves the session in request mode, so firmware without realtime support
costs one call rather than the connection.

close() on a subscribed session sends the goodbye without awaiting a
reply it could not read. It is still sent: UDP has no connection close,
so skipping it leaves the device holding the session slot.

Break-it check: setting subscribed_ before the ack check fails the
refused-registration test on its intended assertion. The decode guard in
the listen callback is NOT yet covered by a test — Task 10 scenario 5
closes that."
```

---

## Task 8: The subscription stream

**Files:**
- Create: `src/realtime/Subscription.ts`
- Create: `test/realtime/subscription.spec.ts`

**Interfaces:**
- Consumes: `Session` (Task 7), `decodeRealtimeEvent` / `isEventPacket` (Tasks 1–3).
- Produces: `SubscribeOptions`, `ZkEventStream`, `DEFAULT_BUFFER_LIMIT`, `class Subscription implements ZkEventStream` with `push(pkt: DecodedPacket): void`, `fail(err: Error): void`, `close(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `test/realtime/subscription.spec.ts`. These drive the class directly — the socket-level path is Task 10.

```ts
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { Subscription } from '../../src/realtime/Subscription.js'
import type { Session } from '../../src/session/Session.js'
import type { ZkRealtimeEvent } from '../../src/types.js'

/** A Session stand-in: the subscription only ever closes it. */
function fakeSession(): { session: Session; closed: () => number } {
  let closes = 0
  const session = { close: async () => { closes += 1 } } as unknown as Session
  return { session, closed: () => closes }
}

function attendancePayload(userId: string): Buffer {
  const buf = Buffer.alloc(32)
  buf.write(userId, 0, 9, 'ascii')
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

const pushed = (eventType: number, data: Buffer) =>
  decodePayload(encodePayload({ command: CMD.REG_EVENT, sessionId: eventType, replyId: 0, data }))

const opts = { events: EVENT_FLAG.ATTENDANCE, bufferLimit: 4, idleTimeoutMs: 0 }

async function drain(stream: AsyncIterable<ZkRealtimeEvent>, count: number): Promise<ZkRealtimeEvent[]> {
  const got: ZkRealtimeEvent[] = []
  for await (const ev of stream) {
    got.push(ev)
    if (got.length >= count) break
  }
  return got
}

describe('Subscription', () => {
  it('yields decoded events in the order they arrived', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('A1')))
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('B2')))
    const got = await drain(sub, 2)
    expect(got.map((e) => (e.kind === 'attendance' ? e.userId : null))).toEqual(['A1', 'B2'])
    await sub.close()
  })

  it('delivers an event that arrives while a consumer is already waiting', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    const pending = drain(sub, 1)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('C3')))
    const got = await pending
    expect(got[0]).toMatchObject({ kind: 'attendance', userId: 'C3' })
    await sub.close()
  })

  it('throws a lost connection out of the iterator', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.fail(new ZkConnectionError('peer went away'))
    await expect(drain(sub, 1)).rejects.toThrow(ZkConnectionError)
  })

  // Events already received are worth more than a prompt error.
  it('drains queued events before reporting a failure', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('D4')))
    sub.fail(new ZkConnectionError('peer went away'))
    const iterator = sub[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'attendance', userId: 'D4' },
    })
    await expect(iterator.next()).rejects.toThrow(ZkConnectionError)
  })

  it('ends the stream when the consumer falls further behind than the buffer allows', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    for (let i = 0; i < 5; i += 1) {
      sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload(`U${i}`)))
    }
    const iterator = sub[Symbol.asyncIterator]()
    for (let i = 0; i < 4; i += 1) await iterator.next()
    await expect(iterator.next()).rejects.toThrow(ZkProtocolError)
  })

  it('ends the stream on a packet that is not an event', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(decodePayload(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 3 })))
    await expect(drain(sub, 1)).rejects.toThrow(ZkProtocolError)
  })

  it('ends the stream when nothing arrives within the idle timeout', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, { ...opts, idleTimeoutMs: 60 })
    await expect(drain(sub, 1)).rejects.toThrow(ZkTimeoutError)
  })

  it('closes the session exactly once, however often close() is called', async () => {
    const { session, closed } = fakeSession()
    const sub = new Subscription(session, opts)
    await sub.close()
    await sub.close()
    expect(closed()).toBe(1)
  })

  it('ends iteration cleanly after close()', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    await sub.close()
    expect(await sub[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/realtime/subscription.spec.ts`
Expected: FAIL — `Failed to resolve import "../../src/realtime/Subscription.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/realtime/Subscription.ts`:

```ts
import { decodeRealtimeEvent, isEventPacket } from '../codec/events.js'
import { ZkProtocolError, ZkTimeoutError } from '../errors.js'
import type { DecodedPacket } from '../codec/packet.js'
import type { Session } from '../session/Session.js'
import type { ZkRealtimeEvent } from '../types.js'

/** Events held while the consumer is behind, before the stream gives up. */
export const DEFAULT_BUFFER_LIMIT = 256

export interface SubscribeOptions {
  /** Bitmask of EVENT_FLAG values. Defaults to EVENT_FLAG.ATTENDANCE. */
  events?: number
  /** Events buffered while the consumer is behind. Defaults to 256. */
  bufferLimit?: number
  /**
   * Ends the stream when no event arrives for this long. Off by default, and
   * that default is deliberate: nobody badges at 03:00, so a default idle
   * timeout would kill healthy subscriptions nightly and teach consumers to
   * ignore the error.
   */
  idleTimeoutMs?: number
}

/**
 * A live subscription to a device's events.
 *
 * An async iterable rather than an event emitter, so a lost connection cannot
 * be ignored: it throws out of the `for await`. An emitter's 'error' needs one
 * stray listener anywhere to become silence.
 *
 * The stream does NOT reconnect and does NOT backfill. Realtime complements
 * polling rather than replacing it, so the next poll is the recovery; a silent
 * reconnect would claim a completeness guarantee that cannot be honoured,
 * since a device buffers nothing for a subscriber that went away.
 */
export interface ZkEventStream extends AsyncIterable<ZkRealtimeEvent> {
  close(): Promise<void>
}

/**
 * Exported because it appears in `Subscription`'s constructor signature —
 * TypeScript refuses to emit a declaration naming a type it cannot reach.
 * Exported from this module only; it is not part of the published API.
 */
export interface ResolvedOptions {
  events: number
  bufferLimit: number
  idleTimeoutMs: number
}

export class Subscription implements ZkEventStream {
  private readonly queue: ZkRealtimeEvent[] = []
  private waiter: ((result: IteratorResult<ZkRealtimeEvent>) => void) | null = null
  private rejectWaiter: ((err: Error) => void) | null = null
  private failure: Error | null = null
  private ended = false
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly session: Session,
    private readonly opts: ResolvedOptions,
  ) {
    this.armIdleTimer()
  }

  /** Accepts one packet the transport pushed. Never throws. */
  push(pkt: DecodedPacket): void {
    if (this.ended) return
    if (!isEventPacket(pkt)) {
      // Deliberately strict: while listening, nothing else should arrive. If
      // something does, this library's model of the connection is wrong, and
      // continuing means guessing which packets mean what.
      this.fail(
        new ZkProtocolError(
          `a non-event packet (command ${pkt.command}) arrived on a listening connection`,
        ),
      )
      return
    }
    this.armIdleTimer()
    const event = decodeRealtimeEvent(pkt)
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      this.rejectWaiter = null
      waiter({ value: event, done: false })
      return
    }
    this.queue.push(event)
    if (this.queue.length > this.opts.bufferLimit) {
      this.fail(
        new ZkProtocolError(
          `event buffer of ${this.opts.bufferLimit} overflowed; the consumer is not keeping up`,
        ),
      )
    }
  }

  /**
   * Ends the stream with an error.
   *
   * Events already queued are still delivered first — losing readings that
   * arrived intact, because the connection died afterwards, would be worse
   * than reporting the failure a few iterations later.
   */
  fail(err: Error): void {
    if (this.ended) return
    this.ended = true
    this.clearIdleTimer()
    this.failure = err
    const waiter = this.waiter
    const reject = this.rejectWaiter
    if (waiter && this.queue.length === 0) {
      // A waiting consumer has nothing queued to drain, so it fails now.
      this.waiter = null
      this.rejectWaiter = null
      reject?.(err)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ZkRealtimeEvent> {
    return {
      next: (): Promise<IteratorResult<ZkRealtimeEvent>> => {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        if (this.failure) return Promise.reject(this.failure)
        if (this.ended || this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<ZkRealtimeEvent>>((resolve, reject) => {
          this.waiter = resolve
          this.rejectWaiter = reject
        })
      },
    }
  }

  /** Ends the subscription and the connection it rides on. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.ended = true
    this.clearIdleTimer()
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      this.rejectWaiter = null
      waiter({ value: undefined, done: true })
    }
    await this.session.close()
  }

  private armIdleTimer(): void {
    if (this.opts.idleTimeoutMs <= 0) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.fail(new ZkTimeoutError(`no event within ${this.opts.idleTimeoutMs}ms`))
    }, this.opts.idleTimeoutMs)
    // Never hold the process open for a timer whose only job is to give up.
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/realtime/subscription.spec.ts`
Expected: PASS, 9 tests. If the "throws a lost connection out of the iterator" test hangs instead of rejecting, the `fail()` path is not reaching a waiting consumer — check that `rejectWaiter` is cleared alongside `waiter` everywhere.

- [ ] **Step 5: Run the break-it check**

Change `push` so overflow drops the oldest event instead of failing:

```ts
    if (this.queue.length > this.opts.bufferLimit) this.queue.shift()
```

Run the tests.
Expected: the overflow test fails — `iterator.next()` resolves instead of rejecting. This is the silent-drop behaviour the bound exists to prevent. Restore.

Then move the `fail()` rejection ahead of the queue drain in `next()` (check `this.failure` before `this.queue.shift()`). Run.
Expected: "drains queued events before reporting a failure" fails on its first assertion. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/realtime/Subscription.ts test/realtime/subscription.spec.ts
git commit -m "feat(realtime): the event stream, bounded and fail-loud

An async iterable rather than an emitter: a lost connection throws out of
the for-await and cannot be swallowed by a stray listener.

The queue is bounded and overflowing ends the stream. Silently dropping
would lose punches; growing without limit is the defect this release
already fixed in the TCP accumulator. Queued events drain before a
failure is reported — readings that arrived intact are worth more than a
prompt error.

Break-it check: dropping the oldest event on overflow, and reporting the
failure before draining, each fail their own test on the intended
assertion."
```

---

## Task 9: `ZkDevice.subscribe()`, the mode guard, and the exports

**Files:**
- Modify: `src/ZkDevice.ts`, `src/index.ts`, `package.json`
- Create: `test/realtime/device.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `ZkDevice.subscribe(opts?: SubscribeOptions): Promise<ZkEventStream>`; the public exports `EVENT_FLAG`, `SubscribeOptions`, `ZkEventStream`, `ZkRealtimeEvent`.

- [ ] **Step 1: Write the failing tests**

Create `test/realtime/device.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { ZkConnectionError } from '../../src/errors.js'
import { ZkDevice } from '../../src/ZkDevice.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkEventStream } from '../../src/realtime/Subscription.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
let stream: ZkEventStream | null = null
afterEach(async () => {
  await stream?.close().catch(() => {}); stream = null
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

for (const transport of ['tcp', 'udp'] as const) {
  describe(`ZkDevice.subscribe over ${transport}`, () => {
    it('registers with the attendance mask by default', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE)
    })

    it('registers with a caller-supplied mask', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe({ events: EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM })
      expect(running.state.eventMask).toBe(EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM)
    })

    // Without this guard, the pre-existing queue hands the next receive() a
    // pushed event as though it were a reply, and getInfo() decodes a badge
    // as storage counters.
    it('refuses the read commands while subscribed', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await expect(device.getInfo()).rejects.toThrow(ZkConnectionError)
      await expect(device.getUsers()).rejects.toThrow(ZkConnectionError)
      await expect(device.getAttendanceLogs()).rejects.toThrow(ZkConnectionError)
    })

    it('refuses a second subscription on the same device', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await expect(device.subscribe()).rejects.toThrow(ZkConnectionError)
    })

    it('reads normally again after reconnecting', async () => {
      running = await startEmulator({ transport, info: { userCount: 2, recordCount: 0, recordCapacity: 10 } })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe()
      await stream.close()
      stream = null
      await device.connect()
      await expect(device.getInfo()).resolves.toMatchObject({ userCount: 2 })
    })

    it('ends the subscription when the device is disconnected', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      const open = await device.subscribe()
      await device.disconnect()
      device = null
      expect(await open[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
    })
  })
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/realtime/device.spec.ts`
Expected: FAIL — `device.subscribe is not a function`.

- [ ] **Step 3: Implement on `ZkDevice`**

In `src/ZkDevice.ts`, add the imports:

```ts
import { EVENT_FLAG } from './codec/events.js'
import { DEFAULT_BUFFER_LIMIT, Subscription, type SubscribeOptions, type ZkEventStream } from './realtime/Subscription.js'
```

Add the field beside `session`:

```ts
  private stream: Subscription | null = null
```

Add the guard next to `requireSession`:

```ts
  /**
   * A session that can still answer requests.
   *
   * One ZkDevice owns one connection and is in exactly one mode. A consumer
   * that needs to poll and listen at once constructs two instances, which
   * makes "open a second connection to this device" a visible decision rather
   * than an assumption buried here — the number of concurrent connections a
   * device accepts has never been observed.
   */
  private requireIdleSession(): Session {
    const session = this.requireSession()
    if (session.subscribed) {
      throw new ZkConnectionError(
        'this device is subscribed to realtime events; close the stream, or use a separate ZkDevice to read',
      )
    }
    return session
  }
```

Change `getInfo`, `getUsers` and `getAttendanceLogs` to call `this.requireIdleSession()` instead of `this.requireSession()`.

Add the method after `getAttendanceLogs`:

```ts
  /**
   * Subscribes to the events the device pushes.
   *
   * The stream does not reconnect and does not backfill: realtime complements
   * polling rather than replacing it, so a dropped connection ends the stream
   * loudly and the next poll recovers whatever was missed.
   *
   * While subscribed this device answers no read commands. Closing the stream
   * closes the connection; call connect() again to read.
   */
  async subscribe(opts?: SubscribeOptions): Promise<ZkEventStream> {
    const session = this.requireIdleSession()
    const resolved = {
      events: opts?.events ?? EVENT_FLAG.ATTENDANCE,
      bufferLimit: opts?.bufferLimit ?? DEFAULT_BUFFER_LIMIT,
      idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
    }
    const subscription = new Subscription(session, resolved)
    await session.subscribe(
      resolved.events,
      (pkt) => subscription.push(pkt),
      (err) => subscription.fail(err),
    )
    this.stream = subscription
    return subscription
  }
```

Update `connect` and `disconnect` to clear the stream. In `connect`, before closing the existing session:

```ts
    this.stream = null
```

In `disconnect`, before closing the session:

```ts
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
```

`Subscription.close()` closes the session, and `Session.close()` is idempotent, so the existing `if (session) await session.close()` that follows stays as it is.

- [ ] **Step 4: Export the four names**

In `src/index.ts`:

```ts
export { EVENT_FLAG } from './codec/events.js'
export type { SubscribeOptions, ZkEventStream } from './realtime/Subscription.js'
```

and add `ZkRealtimeEvent` to the existing `./types.js` type export block. Bump the constant:

```ts
export const VERSION = '0.2.0'
```

Bump `"version": "0.2.0"` in `package.json`.

Do **not** export `Subscription`, `DEFAULT_BUFFER_LIMIT`, `decodeRealtimeEvent`, `decodeRealtimeAttendance`, `encodeEventMask`, `isEventPacket` or `readEventType`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/realtime/device.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Assert the export surface**

Add to `test/smoke.spec.ts`:

```ts
it('exports exactly the public surface v0.2 promises', async () => {
  const api = await import('../src/index.js')
  expect(Object.keys(api).sort()).toEqual([
    'EVENT_FLAG',
    'VERSION',
    'ZkAuthError',
    'ZkConnectionError',
    'ZkDevice',
    'ZkError',
    'ZkFramingError',
    'ZkProtocolError',
    'ZkTimeoutError',
    'decodeZkTime',
    'decodeZkTime6',
  ])
})
```

Run: `pnpm vitest run test/smoke.spec.ts`. If it fails, the listed array is wrong or something leaked into the exports — fix whichever is actually at fault, and do not "fix" it by widening the expectation to whatever was found.

- [ ] **Step 7: Run the break-it check**

Change `getInfo` back to `this.requireSession()`. Run `pnpm vitest run test/realtime/device.spec.ts`.
Expected: "refuses the read commands while subscribed" fails on the `getInfo` assertion — and note that it fails by *timing out or misdecoding*, which is the misrouting this guard prevents. Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run
git add src/ZkDevice.ts src/index.ts package.json test/realtime/device.spec.ts test/smoke.spec.ts
git commit -m "feat: ZkDevice.subscribe, and one mode per device

One ZkDevice owns one connection and is in exactly one mode: while
subscribed, the read commands throw. Without that guard the pre-existing
receive queue hands the next receive() a pushed event as though it were a
reply, and getInfo() decodes a badge as storage counters — a case the
v0.1 concurrent-receive guard does not cover, because there is no second
receive() in flight, only a packet nobody asked for.

A consumer that needs to poll and listen at once constructs two devices,
which keeps 'open a second connection' a visible decision: the number of
concurrent connections a device accepts has never been observed.

The export surface grew by exactly four names and one method, pinned by a
smoke test.

Break-it check: reverting getInfo to requireSession fails the guard test."
```

---

## Task 10: The nine end-to-end scenarios

**Files:**
- Create: `test/realtime/scenarios.spec.ts`

**Interfaces:**
- Consumes: everything above. Produces no new API.

- [ ] **Step 1: Write the scenario suite**

Create `test/realtime/scenarios.spec.ts`. Each `it` maps to one numbered scenario in spec §7.2.

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkConnectionError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { ZkDevice } from '../../src/ZkDevice.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkEventStream } from '../../src/realtime/Subscription.js'
import type { ZkRealtimeEvent } from '../../src/types.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
let stream: ZkEventStream | null = null
afterEach(async () => {
  await stream?.close().catch(() => {}); stream = null
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

function large(userId: string): Buffer {
  const buf = Buffer.alloc(36)
  buf.write(userId, 0, 9, 'ascii')
  buf.writeUInt16LE(1, 24)
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

function small(uid: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.writeUInt8(uid, 0)
  buf.set([26, 8, 27, 8, 1, 30], 4)
  return buf
}

/** Takes `count` events, or throws whatever the stream throws first. */
async function take(s: ZkEventStream, count: number): Promise<ZkRealtimeEvent[]> {
  const got: ZkRealtimeEvent[] = []
  for await (const ev of s) {
    got.push(ev)
    if (got.length >= count) break
  }
  return got
}

for (const transport of ['tcp', 'udp'] as const) {
  describe(`realtime scenarios over ${transport}`, () => {
    const connect = async (emulator: Emulator): Promise<ZkDevice> => {
      const d = new ZkDevice({ host: '127.0.0.1', port: emulator.port, transport, timeoutMs: 2000 })
      await d.connect()
      return d
    }

    // Scenario 1
    it('decodes both dialects across a run of events', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('0001234'))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, small(7))
      const got = await take(stream, 2)
      expect(got[0]).toMatchObject({ kind: 'attendance', userId: '0001234', userIdSource: 'device', uid: null })
      expect(got[1]).toMatchObject({ kind: 'attendance', userId: null, userIdSource: null, uid: 7 })
      expect(got[0]).toMatchObject({ timestamp: expect.objectContaining({ local: '2026-08-27T08:01:30' }) })
    })

    // Scenario 2 — the queued-before-listen race, made deterministic by
    // pushWithAck: the events are written in the same handler return as the
    // registration ack, so they land while no listener is attached yet.
    it('delivers events that arrived alongside the registration ack', async () => {
      running = await startEmulator({
        transport,
        pushWithAck: [
          { eventType: EVENT_FLAG.ATTENDANCE, data: large('EARLY1') },
          { eventType: EVENT_FLAG.ATTENDANCE, data: large('EARLY2') },
        ],
      })
      device = await connect(running)
      stream = await device.subscribe()
      const got = await take(stream, 2)
      expect(got.map((e) => (e.kind === 'attendance' ? e.userId : null))).toEqual(['EARLY1', 'EARLY2'])
    })

    // Scenario 3
    it('ends the stream when a burst outruns the buffer', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe({ bufferLimit: 3 })
      for (let i = 0; i < 8; i += 1) running.pushEvent(EVENT_FLAG.ATTENDANCE, large(`U${i}`))
      await new Promise((r) => setTimeout(r, 100))
      await expect(take(stream, 8)).rejects.toThrow(ZkProtocolError)
    })

    // Scenario 4
    it('ends the stream on a packet that is not an event', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushRaw(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 9 }))
      await expect(take(stream, 1)).rejects.toThrow(ZkProtocolError)
    })

    // Scenario 5
    it('surfaces an unknown event type and an unknown payload length, and survives both', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe({ events: EVENT_FLAG.ATTENDANCE | EVENT_FLAG.ALARM })
      running.pushEvent(EVENT_FLAG.ALARM, Buffer.from([0x3a, 0x00]))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, Buffer.alloc(20, 0x11))
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('AFTER'))
      const got = await take(stream, 3)
      expect(got[0]).toEqual({ kind: 'unknown', eventType: EVENT_FLAG.ALARM, raw: '3a00' })
      expect(got[1]).toEqual({ kind: 'unknown', eventType: EVENT_FLAG.ATTENDANCE, raw: '11'.repeat(20) })
      expect(got[2]).toMatchObject({ kind: 'attendance', userId: 'AFTER' })
    })

    // Scenario 7
    it('times out and stays in request mode when the registration is never acked', async () => {
      running = await startEmulator({
        transport,
        handlers: { [CMD.REG_EVENT]: () => null },
      })
      device = await connect(running)
      await expect(device.subscribe()).rejects.toThrow(ZkTimeoutError)
      // Still in request mode: a read command works rather than being refused.
      await expect(device.getInfo()).resolves.toBeDefined()
    })

    // Scenario 8
    it('keeps an in-flight event for the stream even when a read is refused', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      stream = await device.subscribe()
      running.pushEvent(EVENT_FLAG.ATTENDANCE, large('INFLIGHT'))
      await expect(device.getInfo()).rejects.toThrow(ZkConnectionError)
      const got = await take(stream, 1)
      expect(got[0]).toMatchObject({ kind: 'attendance', userId: 'INFLIGHT' })
    })

    // Scenario 9
    it('closes cleanly while events are still arriving', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      const open = await device.subscribe()
      for (let i = 0; i < 5; i += 1) running.pushEvent(EVENT_FLAG.ATTENDANCE, large(`C${i}`))
      await open.close()
      stream = null
      await device.disconnect()
      device = null
      expect(running.socketErrors).toEqual([])
    })
  })
}

// Scenario 6 is TCP-only, and explicitly so rather than by omission: UDP has
// no connection to drop. A device that stops answering over UDP is
// indistinguishable from a quiet one, which is what idleTimeoutMs is for —
// covered by the idle-timeout test below.
describe('realtime scenarios, TCP only', () => {
  it('throws a lost connection out of the iterator', async () => {
    running = await startEmulator({ transport: 'tcp' })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 2000 })
    await device.connect()
    stream = await device.subscribe()
    for (const socket of running.sockets) socket.destroy()
    await expect(take(stream, 1)).rejects.toThrow(ZkConnectionError)
  })
})

describe('realtime scenarios, UDP only', () => {
  it('ends the stream on the idle timeout when a device simply stops answering', async () => {
    running = await startEmulator({ transport: 'udp' })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport: 'udp', timeoutMs: 2000 })
    await device.connect()
    stream = await device.subscribe({ idleTimeoutMs: 100 })
    await expect(take(stream, 1)).rejects.toThrow(ZkTimeoutError)
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `pnpm vitest run test/realtime/scenarios.spec.ts`
Expected: PASS, 18 tests. Any hang here is almost certainly a socket left open on a failure path — the second most common defect family in v0.1. `server.close()` waits for existing connections, so suspect an undestroyed socket before your own logic.

- [ ] **Step 3: Run the break-it checks**

Three, each on a different guard:

1. In `Subscription.push`, drop the `isEventPacket` check. Run — scenario 4 must fail (the ACK_OK is decoded as an event of type 1 rather than ending the stream). Restore.
2. In `decodeRealtimeEvent`, return the attendance branch even when `decodeRealtimeAttendance` returns null (use `decoded!`). Run — scenario 5 must fail, or throw. Restore.
3. In `Session.subscribe`, set `subscribed_ = true` before awaiting the reply. Run — scenario 7's second assertion must fail. Restore.

- [ ] **Step 4: Commit**

```bash
pnpm typecheck && pnpm vitest run
git add test/realtime/scenarios.spec.ts
git commit -m "test: the nine realtime scenarios, over both transports

Scenario 2 uses pushWithAck so the queued-before-listen race is
deterministic rather than a timing accident. Scenario 6 is TCP-only and
skipped explicitly: UDP has no connection to drop, and a device that
stops answering over UDP is indistinguishable from a quiet one — the
UDP-only idle-timeout test covers that shape instead.

Break-it checks: removing the isEventPacket guard fails scenario 4;
forcing a partial attendance decode fails scenario 5; setting subscribed_
before the ack fails scenario 7."
```

---

## Task 11: Oracle capture and the acknowledgment adjudication

The decision rule is fixed in spec §8.1 **before** any capture is taken. Do not renegotiate it after seeing the data.

**Files:**
- Create: `tools/oracle/capture_pyzk_realtime.py`, `tools/oracle/capture_zkjs_realtime.ts`, `test/oracle/realtime.spec.ts`
- Modify: `tools/oracle/capture.ts`, `src/codec/events.ts`, `PROVENANCE.md`
- Create (generated): `test/fixtures/oracle/realtime/*.json`

**Interfaces:**
- Consumes: the emulator's `REG_EVENT` handler and `pushWithAck`.
- Produces: `ackEvent(sessionId: number, replyId?: number): Buffer` in `src/codec/events.ts` — internal, never exported from `src/index.ts`.

- [ ] **Step 1: Write the pyzk driver**

`pyzk` is GPL-2.0. **Its source is not opened, read, or searched — here or anywhere.** This calls its documented public API and observes the bytes it puts on the socket.

Create `tools/oracle/capture_pyzk_realtime.py`:

```python
"""Drives pyzk's realtime capture against the local emulator.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    conn = ZK("127.0.0.1", port=port, timeout=3, force_udp=force_udp)
    try:
        conn.connect()
        seen = 0
        for _ in conn.live_capture():
            seen += 1
            if seen >= 3:
                break
    except Exception as exc:  # the emulator answers only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Write the zkteco-js driver**

Create `tools/oracle/capture_zkjs_realtime.ts`:

```ts
/**
 * Drives zkteco-js's realtime path (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 */
import ZKLib from 'zkteco-js'

const port = Number(process.argv[2])
const transport = process.argv[3]

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'getError' in err && typeof err.getError === 'function') {
    return JSON.stringify(err.getError())
  }
  return String(err)
}

async function main(): Promise<void> {
  const device = new ZKLib('127.0.0.1', port, 5000, 5000)
  try {
    if (transport === 'udp') {
      // Same workaround as capture_zkjs.ts: zkteco-js's TCP-to-UDP fallback
      // checks `err.code` on a wrapper object that never carries one, so the
      // UDP branch is unreachable. Drive its own ZUDP instance directly, so
      // the bytes on the wire are still entirely zkteco-js's construction.
      await device.zudp.createSocket()
      await device.zudp.connect()
      device.connectionType = 'udp'
      await device.zudp.getRealTimeLogs(() => {})
    } else {
      await device.createSocket()
      await device.ztcp.getRealTimeLogs(() => {})
    }
    // Stay alive long enough for the pushed events to arrive and for any
    // acknowledgment the library might send to be recorded.
    await new Promise((r) => setTimeout(r, 800))
  } catch (err) {
    process.stderr.write(`zkteco-js stopped: ${describeError(err)}\n`)
  } finally {
    try {
      await device.disconnect()
    } catch {
      // the emulator may close first
    }
  }
}

void main()
```

- [ ] **Step 3: Add the capture to the driver**

In `tools/oracle/capture.ts`, add near the other directory constants:

```ts
// Realtime captures live in their own directory, NOT in OUT_DIR.
// test/oracle/fixtures.spec.ts scans every *.json directly under OUT_DIR and
// asserts an exact count of discriminating packets for the reply-id
// adjudication; these fixtures answer a different question and would silently
// change a number that test pins on purpose.
const REALTIME_DIR = path.join(OUT_DIR, 'realtime')
```

and a capture function beside `capture`:

```ts
/**
 * Records what an oracle puts on the wire for a realtime subscription.
 *
 * The emulator pushes three events in the same handler return as the
 * registration ack, so the oracle receives them without any timing
 * coordination between the two processes.
 */
async function captureRealtime(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
): Promise<void> {
  const pushes = [0x01, 0x02, 0x03].map((n) => {
    const data = Buffer.alloc(36)
    data.write(`ORACLE${n}`, 0, 9, 'ascii')
    data.set([26, 8, 27, 8, 1, n], 26)
    return { eventType: 1, data }
  })
  const emulator = await startEmulator({
    transport,
    sessionId: EMULATOR_SESSION_ID,
    pushWithAck: pushes,
  })
  try {
    if (source === 'pyzk') {
      await run(pythonPath(), [
        'tools/oracle/capture_pyzk_realtime.py', String(emulator.port), transport,
      ])
    } else {
      await run(
        'npx',
        ['tsx', 'tools/oracle/capture_zkjs_realtime.ts', String(emulator.port), transport],
        true,
      )
    }
    await new Promise((r) => setTimeout(r, 300))

    const packets = emulator.received.map((p, i) => ({
      hex: emulator.receivedRaw[i]!.toString('hex'),
      command: p.command,
      checksum: p.checksum,
      sessionId: p.sessionId,
      replyId: p.replyId,
      data: p.data.toString('hex'),
    }))
    const fixture = { source, transport, emulatorSessionId: EMULATOR_SESSION_ID, packets }
    mkdirSync(REALTIME_DIR, { recursive: true })
    const file = path.join(REALTIME_DIR, `realtime-${transport}-${source}.json`)
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`wrote ${file} (${packets.length} packets)\n`)
  } finally {
    await emulator.close()
  }
}
```

and, at the bottom of the file:

```ts
for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await captureRealtime(source, transport)
  }
}
```

- [ ] **Step 4: Run the capture**

```bash
pnpm oracle:capture
```

Expected: four new files under `test/fixtures/oracle/realtime/`, and the pre-existing fixtures unchanged. **If any pre-existing fixture changed, stop and explain why before committing** — a change there is a change in what this library believes devices expect.

Read the four new files. For each, note:
- whether a packet with `command: 500` is present, and its `data` (the 4-byte mask);
- every packet that appears **after** that one, and its command.

If a fixture has no `command: 500` packet at all, that oracle never registered a subscription and contributed no evidence either way (spec §8.1, fourth branch). Record that as nothing, not as agreement.

- [ ] **Step 5: Apply the decision rule and write the adjudication test**

Create `test/oracle/realtime.spec.ts`. Fill the constants from what Step 4 actually observed — this test pins the evidence, so it must state the real figures, not the expected ones.

```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'

interface Packet { command: number; data: string }
interface Fixture { source: string; transport: string; packets: Packet[] }

const DIR = path.join('test', 'fixtures', 'oracle', 'realtime')
const FILES = ['realtime-tcp-pyzk.json', 'realtime-tcp-zkteco-js.json',
               'realtime-udp-pyzk.json', 'realtime-udp-zkteco-js.json']

const load = (file: string): Fixture =>
  JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as Fixture

describe('realtime oracle fixtures', () => {
  it('captured every oracle and transport combination', () => {
    // A silently empty fixture is the failure mode this guards: a spawn that
    // failed writes zero packets while the suite stays green.
    for (const file of FILES) expect(load(file).packets.length).toBeGreaterThan(0)
  })

  it('registers with a four-byte mask wherever a subscription was registered', () => {
    for (const file of FILES) {
      const registration = load(file).packets.find((p) => p.command === CMD.REG_EVENT)
      if (!registration) continue // contributed no evidence; see PROVENANCE.md
      expect(registration.data).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  // THE ADJUDICATION (design spec §8.1). The rule was fixed before capture:
  // neither acknowledges -> we do not acknowledge; both do -> we do; they
  // disagree -> follow the specification; one never registers -> it
  // contributed nothing and the other decides, scoped to a single source.
  //
  // The comment block below states, per fixture, whether a subscription was
  // registered and which commands followed it — transcribed from Step 4's
  // reading of the captured files, since these figures are the evidence.
  it('records what each oracle sent after registering', () => {
    for (const file of FILES) {
      const { packets } = load(file)
      const at = packets.findIndex((p) => p.command === CMD.REG_EVENT)
      if (at === -1) continue
      const after = packets.slice(at + 1)
      // The expectation is the observed command sequence. `[]` — no oracle
      // sent anything after registering — is the outcome the specification
      // conflicts with and zkteco-js's source predicts, and under the rule it
      // means this library does not acknowledge. Any other observed sequence
      // is written here literally and the rule applied to it instead.
      expect(after.map((p) => p.command)).toEqual([])
    }
  })
})
```

- [ ] **Step 6: Add `ackEvent`, internal and unused-or-used per the rule**

Append to `src/codec/events.ts`:

```ts
/**
 * Builds the acknowledgment a client is documented to send after each event.
 *
 * The protocol documentation says the client answers every pushed event with
 * CMD_ACK_OK carrying the session id and a zero reply number. zkteco-js sends
 * nothing at all. The adjudication in the design spec §8.1 settled which this
 * library follows; see PROVENANCE.md for the captured figures.
 *
 * If the rule resolved to NOT acknowledging, this stays here, tested and
 * called from nowhere, exactly as `applyReplyIdQuirk` does — internal to the
 * package, never part of the published API, and one call site away in
 * `Session.subscribe`. If the first real terminal delivers exactly one event
 * and then goes silent, this is the first thing to try.
 */
export function ackEvent(sessionId: number, replyId = 0): Buffer {
  return encodePayload({ command: CMD.ACK_OK, sessionId, replyId })
}
```

Import `encodePayload` from `./packet.js`. Add a unit test to `test/codec/events.spec.ts`:

```ts
describe('ackEvent', () => {
  it('builds an ACK_OK carrying the session id and a zero reply number', () => {
    const pkt = decodePayload(ackEvent(0x1f2e))
    expect(pkt).toMatchObject({ command: CMD.ACK_OK, sessionId: 0x1f2e, replyId: 0 })
  })
})
```

If — and only if — the rule resolved to acknowledging, wire it into `Session.subscribe`'s listen callback, after `onPacket`:

```ts
        void this.transport.send(ackEvent(this.currentSessionId)).catch(() => {})
```

and add a scenario to `test/realtime/scenarios.spec.ts` asserting the emulator received one `ACK_OK` per pushed event.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/oracle/ test/codec/events.spec.ts`
Expected: PASS. The adjudication test must assert the figures actually observed.

- [ ] **Step 8: Record the evidence in PROVENANCE.md**

Add a section stating, per oracle and transport: whether it registered a subscription, the mask bytes it sent, and how many packets it sent afterwards. Then state the conclusion **scoped to exactly that evidence**. Wording requirements:

- If only one oracle registered, say so explicitly and scope the claim to a single source, the way the comm-key claim is scoped. An absence of evidence is never filed as agreement.
- The event-type-at-offset-4 claim is **behavioural** evidence, not a byte match: no oracle sends an event, so the most that can be said is that an independent implementation decoded the emulator's bytes into the right values. Say that, and say it is weaker than a byte match.

- [ ] **Step 9: Commit**

```bash
pnpm typecheck && pnpm vitest run
git add tools/oracle/ test/fixtures/oracle/realtime/ test/oracle/realtime.spec.ts src/codec/events.ts test/codec/events.spec.ts PROVENANCE.md
git commit -m "test(oracle): capture the realtime exchange and adjudicate the ack

The decision rule was fixed in the design spec before any capture was
taken, and is applied as written. The figures are in PROVENANCE.md,
scoped to exactly what the data supports.

ackEvent() is implemented and tested but internal to the package and not
part of the published API — the same disposition applyReplyIdQuirk got
when the reply-id quirk was refuted.

Fixtures live under test/fixtures/oracle/realtime/, not OUT_DIR, so the
checksum adjudication's exact-count guard keeps meaning what it claims."
```

---

## Task 12: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`, `.github/ISSUE_TEMPLATE/device-report.yml`

**Interfaces:** none.

- [ ] **Step 1: Document the subscription in the README**

Add a section after the existing attendance-reading example. It must contain a working example and these three statements:

```markdown
### Realtime events

```ts
const device = new ZkDevice({ host: '192.168.1.201' })
await device.connect()
const stream = await device.subscribe()          // attendance events by default

for await (const event of stream) {
  if (event.kind === 'attendance') console.log(event.userId, event.timestamp.local)
}
```

**The stream does not reconnect and does not backfill.** A lost connection
throws out of the `for await` and the events that occur before you subscribe
again are gone — the device buffers nothing for a subscriber that went away.
Realtime is a latency improvement on top of polling, not a replacement for it:
keep reading the log on a schedule, and let it recover whatever the stream
missed.

**One device, one mode.** While subscribed, `getInfo()`, `getUsers()` and
`getAttendanceLogs()` throw. To poll and listen at the same time, construct a
second `ZkDevice` — which opens a second connection, and the number of
concurrent connections a terminal accepts has never been verified against
hardware.

**Some models send no identity.** The larger event payload carries the printed
user id; the smaller one carries only a device-internal `uid`, which is
recycled after a user is deleted and is therefore not an identity. `userId` is
`null` there rather than a guess.
```

- [ ] **Step 2: Extend the v0.1 first-hardware checklist**

In `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`, §12, append items 8 to 13 and the three confirmations, copied from §12 of the realtime spec. Add a line under the section heading noting that items 8 onward come from the realtime design spec.

- [ ] **Step 3: Extend the device report template**

In `.github/ISSUE_TEMPLATE/device-report.yml`, add fields asking a reporter with real hardware:

- whether realtime events arrive at all, and whether they keep arriving after the first one (settles the acknowledgment question);
- which payload length the events carry;
- whether the subscription survives an idle period of an hour;
- whether the device accepts a second simultaneous connection on 4370.

Keep the existing field style and `id` naming convention of that file.

- [ ] **Step 4: Verify and commit**

```bash
pnpm typecheck && pnpm vitest run && pnpm build
git add README.md docs/superpowers/specs/ .github/ISSUE_TEMPLATE/device-report.yml
git commit -m "docs: realtime subscription, and six more first-hardware questions

The README says plainly that the stream does not reconnect, that a device
is in one mode at a time, and that some models send no usable identity —
the three things a consumer will otherwise discover in production.

The device report template now asks the questions only hardware can
answer, so the first real device settles them instead of prompting a
fresh investigation."
```

---

## Definition of done

Check every line before calling this complete (spec §11):

- [ ] `pnpm test` and `pnpm typecheck` clean; `pnpm build` succeeds.
- [ ] CI green on Node 20.19/22/24 across Ubuntu and Windows.
- [ ] All nine scenarios of spec §7.2 pass over both transports, with scenario 6's TCP-only skip stated in the code.
- [ ] Every regression test in this plan was shown to fail when the code it guards was broken, on the intended assertion, and each commit message says so.
- [ ] The §8.1 adjudication was carried out, the rule applied as written, the figures recorded in `PROVENANCE.md` scoped to exactly what they support.
- [ ] Realtime fixtures are under `test/fixtures/oracle/realtime/`, and `test/oracle/fixtures.spec.ts` still passes with its original exact count.
- [ ] `src/index.ts` exports exactly the v0.1 surface plus `EVENT_FLAG`, `SubscribeOptions`, `ZkEventStream`, `ZkRealtimeEvent`, pinned by the smoke test.
- [ ] `package.json` still contains `"dependencies": {}` literally.
- [ ] No file under `tools/oracle/.venv/` was ever opened.
- [ ] `TcpTransport.buffered` no longer grows on a rejected oversized length.
- [ ] Six items and three confirmations added to §12 of the v0.1 spec.
