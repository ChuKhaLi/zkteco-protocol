# User Record Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `parseUserData` handing callers seven fabricated users when a device sends a user body whose length divides evenly by both the 72-byte and the 28-byte record width.

**Architecture:** Derive the user record width by dividing the body length by a device-supplied `userCount`, exactly as `detectRecordSize` already does for attendance. No record byte is inspected. A derived width of 28 is refused, not decoded — this library gains no second decoder. Without a count, the 72-byte read continues for every body length that is not a non-zero multiple of `lcm(72, 28) = 504`.

**Tech Stack:** TypeScript, Node built-ins only (`node:net`, `node:dgram`), vitest, tsup, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-04-zkteco-user-record-width-design.md`

## Global Constraints

- **No runtime dependencies.** `node:net` and `node:dgram` only, never a native module.
- **Never fabricate an identity.** An unresolvable user id is `null`; never a plausible-looking substitute.
- **Refuse rather than guess.** Data failing a framing check throws; it is never parsed into plausible-looking garbage.
- **No write paths.** Not access control, not clock-setting, not user writes.
- **Do not read `pyzk` source. It is GPL-2.0.** `adrobinoga/zk-protocol` carries no license — restate in our own words. `zkteco-js` is MIT and may be read.
- **Do not add first-hardware checklist items.** The twenty-three existing ones are the backlog.
- **Never return a `Date`.** `ZkNaiveTime` only.
- **Run `pnpm build` before `pnpm test`.** `test/smoke.spec.ts` reads `dist/index.js`; with no `dist/` it fails with ENOENT, with a stale one it passes against a bundle that no longer matches `src/`.
- **A fix needs a test in both directions.** A single test fixes one direction and ships the other.
- **Check that a failing test fails for the reason intended.** A prescribed mutation that never reaches its assertion turns a test red while proving nothing.
- **No new decoder for the 28-byte dialect**, and no byte-level discriminator between the widths. Both are out of scope per spec §2.2.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Width detection in the codec

**Files:**
- Modify: `src/codec/records/user.ts` (whole file: constants, new `detectUserRecordSize`, `parseUserData` signature, doc comment)
- Test: `test/codec/records/user.spec.ts`

**Interfaces:**
- Consumes: `ZkFramingError` from `src/errors.js` — constructor `(message: string, raw?: Buffer)`.
- Produces:
  - `USER_RECORD_SIZE = 72` (already exported, unchanged)
  - `ALTERNATE_USER_RECORD_SIZE = 28`
  - `AMBIGUOUS_USER_BODY_MODULUS = 504`
  - `detectUserRecordSize(bodyLength: number, userCount: number | null): typeof USER_RECORD_SIZE`
  - `parseUserData(data: Buffer, userCount: number | null): ZkUser[]` — **second parameter is required, no default.** Task 2 depends on this exact signature.

- [ ] **Step 1: Update the 13 existing call sites in the spec file so they compile**

The second parameter is required, so every existing call must pass `null` explicitly. This is not
busywork — it is the regression guard. Every one of these tests asserts today's behaviour, and
they must all still pass unchanged, which is what proves §4.3's "byte-for-byte identical to today"
claim.

In `test/codec/records/user.spec.ts`, add `, null` to the `parseUserData(...)` call on lines 28,
33, 37, 38, 51, 57, 62, 66, 71, 76, 83, 103. For example line 28 becomes:

```typescript
    const [u] = parseUserData(withHeader(userRec(5, '000123', 'Alice')), null)
```

and line 66 becomes:

```typescript
    expect(parseUserData(withHeader(), null)).toEqual([])
```

Also update `test/diagnostics/report.spec.ts:470`, which calls `parseUserData(short)`:

```typescript
    const steps = await stepsFrom('users', () => parseUserData(short, null))
```

- [ ] **Step 2: Write the failing tests**

Append to `test/codec/records/user.spec.ts`. Import the new names on line 2:

```typescript
import {
  ALTERNATE_USER_RECORD_SIZE,
  AMBIGUOUS_USER_BODY_MODULUS,
  USER_RECORD_SIZE,
  detectUserRecordSize,
  parseUserData,
} from '../../../src/codec/records/user.js'
```

```typescript
describe('detectUserRecordSize', () => {
  // 18 x 28 = 504 = 7 x 72. This is the whole defect: the body is a whole
  // number of records under BOTH widths, so the `% 72` guard passes and the
  // caller receives seven users assembled from slices of eighteen other
  // people's records.
  const AMBIGUOUS = AMBIGUOUS_USER_BODY_MODULUS

  it('refuses an ambiguous body length when no count is available', () => {
    expect(() => detectUserRecordSize(AMBIGUOUS, null)).toThrow(ZkFramingError)
    // The message is the entire evidentiary output of this change on first
    // hardware, so assert it names both readings, not just that it threw.
    expect(() => detectUserRecordSize(AMBIGUOUS, null)).toThrow(/7 record\(s\) of 72 bytes, or 18 of 28/)
  })

  it('resolves an ambiguous body length when the count settles it', () => {
    expect(detectUserRecordSize(AMBIGUOUS, 7)).toBe(USER_RECORD_SIZE)
  })

  it('refuses rather than decodes when the count implies the 28-byte dialect', () => {
    expect(() => detectUserRecordSize(AMBIGUOUS, 18)).toThrow(/28-byte/)
    expect(() => detectUserRecordSize(AMBIGUOUS, 18)).toThrow(ZkFramingError)
  })

  it('reads an unambiguous body as 72 bytes without a count, exactly as before', () => {
    // 8 x 72 = 576, which is not a multiple of 504. Nothing about this case
    // changes; the test exists so an over-broad guard cannot pass review.
    expect(detectUserRecordSize(8 * USER_RECORD_SIZE, null)).toBe(USER_RECORD_SIZE)
  })

  it('reads an empty body as zero records under a null or zero count', () => {
    expect(detectUserRecordSize(0, null)).toBe(USER_RECORD_SIZE)
    expect(detectUserRecordSize(0, 0)).toBe(USER_RECORD_SIZE)
  })

  it('refuses an empty body against a count that claims users', () => {
    // The mirror of the zero-count case below: an early return of [] here
    // would answer "how many are enrolled" with a fabricated absence.
    expect(() => detectUserRecordSize(0, 5)).toThrow(/count is 5 but the body is empty/)
  })

  it('refuses a zero count against a non-empty body', () => {
    // FREE_SIZES_OFFSET is unverified. If the userCount offset is wrong the
    // field reads a spurious 0, and returning [] would report "nobody is
    // enrolled" for a device with users -- which then silently disables
    // user-id resolution for every attendance record.
    expect(() => detectUserRecordSize(AMBIGUOUS, 0)).toThrow(/count is 0 but the body carries 504 bytes/)
  })

  it('refuses a count that does not divide the body', () => {
    expect(() => detectUserRecordSize(500, 7)).toThrow(/does not divide evenly by 7/)
    // A body that IS a whole number of 72-byte records (5 x 72 = 360) but
    // whose count disagrees. The width is never re-derived from the body
    // alone once a count has been supplied.
    expect(() => detectUserRecordSize(360, 7)).toThrow(/does not divide evenly by 7/)
  })

  it('refuses a body that divides by the count into neither known width', () => {
    // 5 x 72 = 360 over a count of 7 is 51.43 -- not an integer, so this is
    // caught by the divisibility rule. 360 over a count of 5 is 72 and must
    // pass; 360 over a count of 9 is 40, a whole number that is neither
    // width, and is what this row actually exercises.
    expect(detectUserRecordSize(360, 5)).toBe(USER_RECORD_SIZE)
    expect(() => detectUserRecordSize(360, 9)).toThrow(/derived user record size 40 is not 72/)
  })

  it('refuses a body that is not a whole number of 72-byte records without a count', () => {
    expect(() => detectUserRecordSize(100, null)).toThrow(/not a multiple of 72/)
  })

  it('refuses a negative or fractional count', () => {
    expect(() => detectUserRecordSize(144, -1)).toThrow(/non-negative integer/)
    expect(() => detectUserRecordSize(144, 1.5)).toThrow(/non-negative integer/)
  })

  it('exports the alternate width and the ambiguous modulus', () => {
    expect(ALTERNATE_USER_RECORD_SIZE).toBe(28)
    // lcm(72, 28). Pinned so a later edit cannot quietly narrow the guard.
    expect(AMBIGUOUS_USER_BODY_MODULUS).toBe(504)
    expect(AMBIGUOUS_USER_BODY_MODULUS % USER_RECORD_SIZE).toBe(0)
    expect(AMBIGUOUS_USER_BODY_MODULUS % ALTERNATE_USER_RECORD_SIZE).toBe(0)
  })
})

describe('parseUserData width handling', () => {
  it('refuses a 504-byte body rather than returning seven fabricated users', () => {
    // Eighteen 28-byte records, built as raw bytes because this library has
    // no 28-byte encoder and must not gain one.
    const body = Buffer.alloc(18 * ALTERNATE_USER_RECORD_SIZE, 0x41)
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    const data = Buffer.concat([head, body])
    expect(data.length - 4).toBe(504)
    expect(() => parseUserData(data, null)).toThrow(ZkFramingError)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail, and confirm each fails for the intended reason**

Run: `npx vitest run test/codec/records/user.spec.ts`

Expected: the `detectUserRecordSize` describe block fails with `detectUserRecordSize is not a
function` / import errors, and `refuses a 504-byte body...` fails because `parseUserData`
**returned seven users instead of throwing**.

That last one is the check that matters. Read the failure output and confirm it says the assertion
`expected [Function] to throw` failed — not that the import failed or the buffer construction threw.
A test that goes red because a symbol is missing has proved nothing about the defect. If it is red
for the wrong reason, fix the test before writing any implementation.

- [ ] **Step 4: Write the implementation**

Replace the constants and `parseUserData` in `src/codec/records/user.ts`. Keep `decodeOne` exactly
as it is — it decodes a 72-byte record and nothing about that changes.

```typescript
export const USER_RECORD_SIZE = 72

/**
 * The other width the reference decodes over UDP (`zkteco-js`
 * helper/utils.js:114-126). This library has no decoder for it. The constant
 * exists so a refusal can name what it refused; adding a decoder would be a
 * new wire hypothesis and is out of scope (design §2.2).
 */
export const ALTERNATE_USER_RECORD_SIZE = 28

/**
 * lcm(72, 28). A body length divisible by both widths is a whole number of
 * records under either reading, so a division-free guard cannot tell them
 * apart: 504 bytes is seven 72-byte records or eighteen 28-byte ones. This is
 * the entire exposure -- every other length is decidable.
 */
export const AMBIGUOUS_USER_BODY_MODULUS = 504
```

```typescript
/**
 * Derives the user record width, by division against the device's own user
 * count where one is available.
 *
 * This is `detectRecordSize`'s technique (records/attendance.ts), applied to
 * the one bulk parser that never took a count. It reads no record bytes:
 * discriminating the widths from the bytes is a new wire hypothesis, and the
 * first hardware run is where that gets settled.
 *
 * Without a count the 72-byte read continues for every decidable length, so a
 * device whose CMD_GET_FREE_SIZES reply is broken keeps a working user read.
 * The count is what rescues a legitimate 72-byte device with a multiple of
 * seven users; it is not what closes the hole.
 */
export function detectUserRecordSize(
  bodyLength: number,
  userCount: number | null,
): typeof USER_RECORD_SIZE {
  // Zero records is zero users under either width -- arithmetically ambiguous
  // (0 is a multiple of 504), semantically not. Handled HERE rather than by an
  // early return in parseUserData, because an empty body against a count that
  // claims users is a contradiction, and answering it with [] would be the
  // same fabricated absence reached from the other direction.
  if (bodyLength === 0) {
    if (userCount === null || userCount === 0) return USER_RECORD_SIZE
    throw new ZkFramingError(`user count is ${userCount} but the body is empty`)
  }

  if (userCount === null) {
    if (bodyLength % USER_RECORD_SIZE !== 0) {
      throw new ZkFramingError(
        `user body of ${bodyLength} bytes is not a multiple of ${USER_RECORD_SIZE}`,
      )
    }
    if (bodyLength % AMBIGUOUS_USER_BODY_MODULUS === 0) {
      throw new ZkFramingError(
        `user body of ${bodyLength} bytes is undecidable without a user count: ` +
          `${bodyLength / USER_RECORD_SIZE} record(s) of ${USER_RECORD_SIZE} bytes, ` +
          `or ${bodyLength / ALTERNATE_USER_RECORD_SIZE} of ${ALTERNATE_USER_RECORD_SIZE}. ` +
          `This library decodes only ${USER_RECORD_SIZE}-byte user records, and ` +
          `CMD_GET_FREE_SIZES supplied no count to settle it.`,
      )
    }
    return USER_RECORD_SIZE
  }

  if (!Number.isInteger(userCount) || userCount < 0) {
    throw new ZkFramingError(`user count must be a non-negative integer, got ${userCount}`)
  }
  if (userCount === 0) {
    throw new ZkFramingError(
      `user count is 0 but the body carries ${bodyLength} bytes; the count and the body ` +
        'contradict each other. FREE_SIZES_OFFSET is unverified, so a wrong userCount offset ' +
        'looks exactly like this.',
    )
  }
  if (bodyLength % userCount !== 0) {
    throw new ZkFramingError(
      `user body of ${bodyLength} bytes does not divide evenly by ${userCount} user(s)`,
    )
  }
  const size = bodyLength / userCount
  if (size === ALTERNATE_USER_RECORD_SIZE) {
    throw new ZkFramingError(
      `user body of ${bodyLength} bytes over a count of ${userCount} implies ` +
        `${ALTERNATE_USER_RECORD_SIZE}-byte user records. This library decodes only ` +
        `${USER_RECORD_SIZE}-byte records and will not guess at the ` +
        `${ALTERNATE_USER_RECORD_SIZE}-byte dialect.`,
    )
  }
  if (size !== USER_RECORD_SIZE) {
    throw new ZkFramingError(`derived user record size ${size} is not ${USER_RECORD_SIZE}`)
  }
  return USER_RECORD_SIZE
}
```

Then replace `parseUserData`, **including its doc comment** — the existing one describes the
fabrication as unaddressed and must not survive the change:

```typescript
/**
 * Decodes a user-list payload: a 4-byte little-endian totalSize followed by
 * fixed-width records.
 *
 * `userCount` is the device's own count from CMD_GET_FREE_SIZES, or `null`
 * when none is available. It is required rather than defaulted so a call site
 * that has a count cannot lose it silently in a later edit. See
 * `detectUserRecordSize` for what each case refuses.
 *
 * Until v0.6 this assumed 72 bytes unconditionally, and a body that was a
 * whole number of records under BOTH widths -- any multiple of 504 -- was
 * parsed into users nobody had enrolled.
 */
export function parseUserData(data: Buffer, userCount: number | null): ZkUser[] {
  if (data.length < 4) {
    throw new ZkFramingError('user payload too short to hold its size header', data)
  }
  const totalSize = data.readUInt32LE(0)
  if (data.length < 4 + totalSize) {
    throw new ZkFramingError(
      `user payload declares ${totalSize} bytes but only ${data.length - 4} arrived`,
      data.subarray(0, 16),
    )
  }
  const body = data.subarray(4, 4 + totalSize)
  const size = detectUserRecordSize(body.length, userCount)
  const out: ZkUser[] = []
  for (let off = 0; off + size <= body.length; off += size) {
    out.push(decodeOne(body.subarray(off, off + size)))
  }
  return out
}
```

Note `src/commands/users.ts:18` will now fail typecheck. That is expected and Task 2 fixes it; do
not patch it here with a `null` you would then have to unpick.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/codec/records/user.spec.ts test/diagnostics/report.spec.ts`
Expected: PASS, including all twelve pre-existing `parseUserData` tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/codec/records/user.ts test/codec/records/user.spec.ts test/diagnostics/report.spec.ts
git commit -m "$(cat <<'EOF'
fix(codec): the user record width is derived, not assumed

28 and 72 share a factor of 4, so a body of 504 bytes is eighteen 28-byte
records and also seven 72-byte ones. The `% 72` guard passed it and the
caller received seven users assembled from slices of other people's
records.

detectUserRecordSize divides the body by the device's own user count, the
technique records/attendance.ts has used since v0.3. It reads no record
bytes, so it adds no wire hypothesis. A derived width of 28 is refused
rather than decoded: this library still has no second decoder.

Without a count, only a non-zero multiple of 504 is refused, so every
body that decoded correctly before still decodes -- the twelve existing
parser tests pass untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Supply the count from the three call sites

**Files:**
- Modify: `src/commands/users.ts` (whole file)
- Modify: `src/commands/attendance.ts` — the `getUsers` call inside `getAttendanceLogs`
- Modify: `src/ZkDevice.ts:171-173` — `getUsers()`
- Modify: `src/diagnostics/probe.ts:669` — the `users` step
- Test: `test/commands/users.spec.ts`, `test/ZkDevice.spec.ts`

**Interfaces:**
- Consumes: `parseUserData(data: Buffer, userCount: number | null): ZkUser[]` and
  `detectUserRecordSize` from Task 1. `getInfo(session): Promise<ZkDeviceInfo>` from
  `src/commands/info.js`, whose result has `userCount: number`.
- Produces: `getUsers(session: Session, transport: 'tcp' | 'udp', userCount: number | null): Promise<ZkUser[]>`.
  `ZkDevice.getUsers(): Promise<ZkUser[]>` is **unchanged** — `test/smoke.spec.ts` pins the public
  surface and must stay green without being edited.

- [ ] **Step 1: Write the failing tests**

Append to `test/commands/users.spec.ts`, inside the existing
`for (const transportKind of ['tcp', 'udp'] as const)` loop so both transports run it. The emulator
already serves 28-byte records via `userRecordSize` (added for experiment E4), so this drives the
real defect over a real socket, not just through the parser.

```typescript
  describe(`user record width (${transportKind})`, () => {
    /** Eighteen users: 18 x 28 = 504 = 7 x 72, the ambiguous length. */
    const eighteen = Array.from({ length: 18 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
    /** Seven users at 72 bytes: also 504. A legitimate device that must keep working. */
    const seven = Array.from({ length: 7 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))

    it('refuses a 28-byte device rather than returning seven fabricated users', async () => {
      // Before v0.6 this RESOLVED to seven ZkUser objects whose uid, name and
      // printed id were sliced out of the middle of other people's records.
      running = await startEmulator({ transport: transportKind, users: eighteen, userRecordSize: 28 })
      session = await openSession(running.port)
      await expect(getUsers(session, transportKind, null)).rejects.toThrow(ZkFramingError)
    })

    it('names the 28-byte dialect when the count settles it', async () => {
      running = await startEmulator({ transport: transportKind, users: eighteen, userRecordSize: 28 })
      session = await openSession(running.port)
      await expect(getUsers(session, transportKind, 18)).rejects.toThrow(/28-byte/)
    })

    it('reads seven 72-byte users when the count settles it', async () => {
      // The other direction: without this, refusing everything would pass.
      running = await startEmulator({ transport: transportKind, users: seven, userRecordSize: 72 })
      session = await openSession(running.port)
      const got = await getUsers(session, transportKind, 7)
      expect(got.map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('refuses seven 72-byte users with no count, because the length is undecidable', async () => {
      running = await startEmulator({ transport: transportKind, users: seven, userRecordSize: 72 })
      session = await openSession(running.port)
      await expect(getUsers(session, transportKind, null)).rejects.toThrow(/undecidable/)
    })

    it('reads an unambiguous list with no count, exactly as before', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
      running = await startEmulator({ transport: transportKind, users: eight, userRecordSize: 72 })
      session = await openSession(running.port)
      expect((await getUsers(session, transportKind, null)).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })
  })
```

Add `ZkFramingError` to the `src/errors.js` import at the top of the file (it currently imports
only `ZkAuthError`).

Then in `test/ZkDevice.spec.ts`, a test that the public entry point degrades rather than dying when
the count cannot be read. That file has an `afterEach` managing module-level `running` and `device`
already, and its `startEmulator` calls take an `info` option — follow both. It has no user-record
helper, so add this one beside the existing `rec40` at line 17:

```typescript
/** A 72-byte emulator user; the emulator serves `raw` verbatim. */
function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(72)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 9, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}
```

and the test, at the top level of the file (outside the per-transport loop — the degradation is
transport-independent):

```typescript
it('still reads users when the device will not report a user count', async () => {
  // ZkDevice.getUsers() asks for a count to derive the record width. A device
  // whose free-sizes reply is refused must not lose a user read that works:
  // the no-count path reads 72-byte records for every decidable length, and
  // eight users is 576 bytes, which is not a multiple of 504.
  //
  // ACK_UNAUTH rather than a timeout on purpose. A timeout closes the session
  // (spec v0.5 section 5.2), so it would prove the degradation only by
  // killing the thing being tested.
  const eight = Array.from({ length: 8 }, (_, i) => emUser(i + 1, String(i + 1), `U${i + 1}`))
  running = await startEmulator({
    transport: 'tcp',
    users: eight,
    handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
  })
  device = new ZkDevice({ host: '127.0.0.1', port: running.port })
  await device.connect()
  expect((await device.getUsers()).map((u) => u.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  await device.disconnect()
  device = null
})
```

Add `reply` to the `./emulator/index.js` import on line 6, and `import type { ZkUser } from '../src/types.js'`.

- [ ] **Step 2: Make the tests fail for the intended reason, not on arity**

A plain run now fails to compile, because `getUsers` still takes two parameters. A compile failure
proves nothing about behaviour, so this step has two parts and the order matters.

First, do Step 3 — the `getUsers` signature change alone, with `parseUserData` receiving the count.
Then run:

`npx vitest run test/commands/users.spec.ts test/ZkDevice.spec.ts`

Expected, and check each one:

- `refuses a 28-byte device rather than returning seven fabricated users` — must fail with
  **"promise resolved instead of rejecting"**. That resolved value is the defect: seven `ZkUser`
  objects that no device enrolled. If it fails any other way, the test is not reaching the defect
  and must be fixed before continuing.
- `refuses seven 72-byte users with no count` — same shape, resolves instead of rejecting.
- `reads seven 72-byte users when the count settles it` and `reads an unambiguous list with no
  count` — these should **pass already**, since Task 1 left both paths decoding. If either fails,
  Task 1's guard is over-broad and the fix belongs there, not here.

The last two passing while the first two fail is the evidence that the change is targeted rather
than a blanket refusal.

- [ ] **Step 3: Change `getUsers` to take the count**

`src/commands/users.ts` in full:

```typescript
import { CMD } from '../codec/commands.js'
import { parseUserData } from '../codec/records/user.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkUser } from '../types.js'

/**
 * Reads the enrolled user list.
 *
 * This is not an optional convenience: the 8- and 16-byte attendance dialects
 * carry no printed user id, so resolving a punch to a person depends on it.
 *
 * `userCount` is the device's own count from CMD_GET_FREE_SIZES, and it
 * decides the record width (codec/records/user.ts). Pass `null` when no count
 * is available; that is a supported state, not a failure. It is NOT fetched
 * here on purpose -- this function runs inside the attendance poll loop, and
 * a hidden CMD_GET_FREE_SIZES round-trip per poll would keep the terminal
 * busy for the people badging at it. Every caller supplies it.
 */
export async function getUsers(
  session: Session,
  transport: 'tcp' | 'udp',
  userCount: number | null,
): Promise<ZkUser[]> {
  const stream = await readBulk(session, CMD.USERTEMP_RRQ, transport)
  return parseUserData(stream, userCount)
}
```

- [ ] **Step 4: Pass the count from `getAttendanceLogs`**

In `src/commands/attendance.ts`, the line currently reading
`const users = needsLookup ? await getUsers(session, transport) : []` becomes:

```typescript
  // `after` is the count read AFTER the attendance transfer, so it is the
  // freshest one this call holds and it costs no extra round-trip -- which is
  // the whole reason getUsers does not fetch a count itself.
  const users = needsLookup ? await getUsers(session, transport, after.userCount) : []
```

- [ ] **Step 5: Pass the count from `ZkDevice.getUsers()`**

Replace `src/ZkDevice.ts:171-173`:

```typescript
  /**
   * Reads the enrolled user list.
   *
   * Asks the device for its user count first, because the record width is
   * derived by dividing the body by it (codec/records/user.ts). The count is
   * what lets a legitimate 72-byte device with a multiple of seven users be
   * read at all, since 7 x 72 and 18 x 28 are the same 504 bytes.
   */
  async getUsers(): Promise<ZkUser[]> {
    const session = this.requireIdleSession()
    // Swallowed deliberately, and only here. "No count" is a defined
    // behaviour, not a guess: the read falls back to 72-byte records for
    // every body length that is not ambiguous, so a device whose free-sizes
    // reply is broken keeps a working user list. It cannot mask a dead
    // session either -- under spec v0.5 section 5.2 a timeout closes the
    // session, so the read below then fails with its own message.
    let userCount: number | null = null
    try {
      userCount = (await getInfo(session)).userCount
    } catch {
      userCount = null
    }
    return getUsers(session, this.transportKind, userCount)
  }
```

`getInfo` is already imported at `src/ZkDevice.ts:3`.

- [ ] **Step 6: Pass the count from the diagnostics probe**

In `src/diagnostics/probe.ts`, line 669 becomes:

```typescript
    users = await getUsers(session, opts.transport, findings.freeSizes?.userCount ?? null)
```

`findings.freeSizes` is assigned by the free-sizes step at `probe.ts:512`, which runs before this
one. If that step failed, `findings.freeSizes` is undefined and `null` selects the no-count path —
which is why the probe does not need a `try` of its own.

One property to expect rather than to "fix": the new refusal does **not** end the session, even
though `Session` abandons on a `ZkFramingError` raised inside its request path (`Session.ts:308`).
`parseUserData` is called after `readBulk` has already returned, so the throw happens outside that
path — exactly as `parseUserData`'s existing framing refusals already do. This is what lets the
probe carry on to its remaining steps after a user-read refusal instead of losing the rest of the
run, and it is why item 20 reports *not answered* rather than the whole probe dying.

- [ ] **Step 7: Run the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS. `test/smoke.spec.ts` must be green **without being edited** — if it is not, a
signature leaked onto the published surface and that is a design violation, not a test to update.

- [ ] **Step 8: Commit**

```bash
git add src/commands/users.ts src/commands/attendance.ts src/ZkDevice.ts src/diagnostics/probe.ts test/commands/users.spec.ts test/ZkDevice.spec.ts
git commit -m "$(cat <<'EOF'
fix(commands): every user read carries the count that decides its width

getUsers takes the device's user count and hands it to the parser. It
does not fetch one: it runs inside the attendance poll loop, and a hidden
CMD_GET_FREE_SIZES per poll would keep the terminal busy for the people
badging at it. getAttendanceLogs passes the count it already read after
the transfer, so the loop pays nothing; the probe passes the one its
free-sizes step already recorded; ZkDevice.getUsers asks for one and
degrades to null if the device will not say.

The emulator has served 28-byte records since experiment E4, so the new
tests drive eighteen of them over a real socket on both transports. That
read used to resolve to seven fabricated users.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `--out=` is rejected during parsing

**Files:**
- Modify: `src/cli.ts` — around line 100-113
- Test: `test/diagnostics/cli.spec.ts` — beside the existing `--raw-capture=` test at line 63

**Interfaces:**
- Consumes: nothing from Tasks 1-2. Independent.
- Produces: no new exports. `parseCliArgs` throws on `--out=`.

- [ ] **Step 1: Write the failing test**

In `test/diagnostics/cli.spec.ts`, beside the `--raw-capture=` tests:

```typescript
  it('refuses --out with no value, and accepts one with a path', () => {
    // `--out=` parsed as '' and reached writeOutputs, which failed on an
    // empty path after the whole probe had run. --raw-capture= was fixed to
    // fail during parsing; --out was left asymmetric.
    expect(() => parseCliArgs(['h', '--out='])).toThrow(/--out/)
    // The positive control: the rejection must not swallow a real path.
    expect(parseCliArgs(['h', '--out=report.md']).out).toBe('report.md')
    // And omitting it still means stdout, not an error.
    expect(parseCliArgs(['h']).out).toBe(null)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/diagnostics/cli.spec.ts -t 'refuses --out with no value'`
Expected: FAIL on the first assertion — `expected [Function] to throw` — because `''` is returned
rather than thrown on. The two control assertions should already pass; if either fails, the test is
wrong, not the code.

- [ ] **Step 3: Implement**

In `src/cli.ts`, after the existing `rawCapture` guard, add:

```typescript
  // `--out=` (no value) parses as the empty string and used to fail only when
  // writeOutputs tried the path, after the whole probe had run against the
  // device. Lower stakes than --raw-capture= above, whose output is
  // unredacted, but the same shape: rejected during parsing so it fails
  // before anything is probed.
  const out = values.out ?? null
  if (out === '') {
    throw new Error("--out needs a path, got ''. Omit --out to write the report to stdout.")
  }
```

and change the returned object's `out: values.out ?? null` to `out,`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/diagnostics/cli.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/diagnostics/cli.spec.ts
git commit -m "$(cat <<'EOF'
fix(cli): --out with no value is refused during parsing

--raw-capture= was fixed to fail before anything is probed; --out= was
left to fail later, when writeOutputs tried to open an empty path after
the whole run had already happened against the device.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `capture.ts`'s skip-and-exit-1 path gets a test

**Files:**
- Modify: `tools/oracle/run-oracle.ts` — add `reportFailures`
- Modify: `tools/oracle/capture.ts:257-260`
- Test: `test/oracle/run-oracle.spec.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3. Independent.
- Produces: `reportFailures(failures: string[], write: (s: string) => void): number` — returns the
  exit code the capture should adopt (`1` if any failure, `0` otherwise).

- [ ] **Step 1: Write the failing test**

`capture.ts` is a top-level-await script and cannot be imported by a test, which is why this path
was verified once by hand and never since. `tools/oracle/run-oracle.ts` already exists precisely as
the importable home for capture's decisions, and `test/oracle/run-oracle.spec.ts` already tests
`run`, `succeeded` and `describeFailure` with stub subprocesses and no `.venv`. Follow that.

Append to `test/oracle/run-oracle.spec.ts`:

```typescript
describe('reportFailures', () => {
  it('reports every failure and asks for exit 1', () => {
    const written: string[] = []
    const code = reportFailures(
      ['capture_pyzk.py: exit 2 — boom', 'capture_zkjs.ts: could not be spawned'],
      (s) => written.push(s),
    )
    expect(code).toBe(1)
    const all = written.join('')
    expect(all).toContain('2 oracle run(s) produced no fixture')
    // Every failure named, not just the count -- a summary that says "2
    // failed" without saying which sends the reader back to the scrollback.
    expect(all).toContain('capture_pyzk.py: exit 2 — boom')
    expect(all).toContain('capture_zkjs.ts: could not be spawned')
  })

  it('stays silent and asks for exit 0 when nothing failed', () => {
    // The other direction, and the branch that runs on every green capture.
    // Without it, `return 1` unconditionally would pass the test above.
    const written: string[] = []
    expect(reportFailures([], (s) => written.push(s))).toBe(0)
    expect(written).toEqual([])
  })
})
```

Add `reportFailures` to the existing import on line 2 of that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/oracle/run-oracle.spec.ts`
Expected: FAIL — `reportFailures is not a function`. This one is legitimately a missing-symbol
failure, because the function does not exist yet; the behavioural check is Step 4.

- [ ] **Step 3: Implement**

Append to `tools/oracle/run-oracle.ts`:

```typescript
/**
 * Names the oracle runs that produced no fixture and returns the exit code the
 * capture should adopt.
 *
 * Lives here rather than in capture.ts because that file is a top-level-await
 * script and cannot be imported by a test. The decision is three lines and the
 * consequence is not: a capture that skipped every fixture but exited 0 would
 * leave the committed evidence looking refreshed when nothing was rewritten.
 *
 * `write` is injected so a test can read what was printed without a subprocess.
 */
export function reportFailures(failures: string[], write: (s: string) => void): number {
  if (failures.length === 0) return 0
  write(`\n${failures.length} oracle run(s) produced no fixture:\n`)
  for (const line of failures) write(`  ${line}\n`)
  return 1
}
```

In `tools/oracle/capture.ts`, replace lines 257-260:

```typescript
// Only assigned on failure: setting process.exitCode unconditionally would
// clear a non-zero code set anywhere else in this script.
const exitCode = reportFailures(failures, (s) => process.stderr.write(s))
if (exitCode !== 0) process.exitCode = exitCode
```

and add `reportFailures` to capture.ts's existing import from `./run-oracle.js`.

- [ ] **Step 4: Run the tests, and verify the failure branch really is load-bearing**

Run: `npx vitest run test/oracle/run-oracle.spec.ts`
Expected: PASS.

Then confirm the tests would catch the defect they exist for: temporarily change `return 1` to
`return 0` in `reportFailures` and re-run. The first test must fail. Change it back. A test that
passes under that mutation is pinning nothing.

- [ ] **Step 5: Commit**

```bash
git add tools/oracle/run-oracle.ts tools/oracle/capture.ts test/oracle/run-oracle.spec.ts
git commit -m "$(cat <<'EOF'
test(oracle): the skip-and-exit-1 path is tested, not just remembered

capture.ts's decision to skip a fixture and exit 1 was verified once by an
induced-failure run and by nothing since. capture.ts is a top-level-await
script and cannot be imported, so the decision moves to run-oracle.ts
beside run/succeeded/describeFailure, which the suite already covers with
stub subprocesses and no venv.

Both directions: failures name every run and ask for exit 1; no failures
writes nothing and leaves the exit code alone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `PROVENANCE.md` — §*User record width and size* (starts at line 392)
- Modify: `docs/superpowers/plans/2026-09-04-continuing-past-v0.5.0-HANDOFF.md` — §1, §4.3, §4 intro
- Modify: `CLAUDE.md` — only if the architecture section's description of `records/user.ts` is now wrong; read it first and leave it alone if it is not.

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-4. Nothing produces code here.

- [ ] **Step 1: Rewrite PROVENANCE's user-record-width section**

The second paragraph currently ends with the claim that "Nothing detects that today, and nothing
here proposes a heuristic that would". Both halves are now false. Replace that paragraph's tail,
keeping the first paragraph about the nine-byte printed id exactly as it is.

The rewritten text must say, in the project's own voice:

- The width is derived by dividing the body by the device's `userCount` from `CMD_GET_FREE_SIZES`,
  the technique `detectRecordSize` has used for attendance since v0.3. **No record byte is
  inspected**, so this adds no wire hypothesis and the open question about discriminating the
  widths from the bytes is unchanged.
- A derived width of 28 is **refused, not decoded**. No second decoder exists; the sentence "adding
  one would be a new hypothesis" stays true.
- Without a count, only a non-zero multiple of 504 is refused, so every body that decoded correctly
  before still decodes.
- **The risk, stated plainly** (spec §9.2): `FREE_SIZES_OFFSET` is still unverified, and `userCount`
  is now load-bearing for the user read as `recordCount` already was for attendance. If that offset
  is wrong, a device that reads users fine starts refusing. That is correct under *refuse rather
  than guess*, and the no-count path bounds the blast radius, but it is a real way v0.6.0 could make
  first contact with hardware worse and it belongs on the record.
- E4 is unchanged by this: it showed `pyzk` decodes both widths over UDP, so neither oracle says
  what a device sends. Keep that sentence.

- [ ] **Step 2: Correct the v0.5.0 handoff**

Three edits, each removing a claim that is no longer true rather than rewriting it into its
aftermath:

1. **§1** says `v0.5.0` "is **not applied yet**" and lists the merge, push and tag as remaining
   work. The tag is applied at `155fcbc` and the package is published. Say so.
2. **§4 item 3** (the 28-byte UDP dialect) is closed by this cycle. Replace the entry with one line
   pointing at `docs/superpowers/specs/2026-09-04-zkteco-user-record-width-design.md` and the fact
   that the fabrication is now a refusal — per CLAUDE.md, *when you fix a recorded defect, delete
   its entry rather than rewriting it into its aftermath*.
3. **§4's count** — it opens "Four things this v0.5 sub-project surfaced". Two of the four were
   already closed before the handoff was written (`test/commands/info.spec.ts:60` covers the
   full-length `ACK_UNAUTH` free-sizes body; `src/diagnostics/report.ts:139` explains item 13's
   `registered` conjunct as deliberate defence), and item 3 is closed by this cycle. Make the
   number and the list agree.

- [ ] **Step 3: Verify no other doc still describes the old behaviour**

Run: `grep -rn "fabricated\|504\|28-byte\|28 and 72" README.md CLAUDE.md docs/ PROVENANCE.md src/`

Read every hit. Any sentence claiming the hazard is open, or that the library assumes 72
unconditionally, is now wrong and must be fixed. Do not add new claims — only remove false ones.

- [ ] **Step 4: Commit**

```bash
git add PROVENANCE.md docs/ CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: the user width hazard is closed, and what closing it cost

PROVENANCE said nothing detects the ambiguous body length and nothing
proposed a way to. Both are now false. It also has to carry the new risk:
userCount is load-bearing for the user read the way recordCount already
was for attendance, and FREE_SIZES_OFFSET is still unverified, so a wrong
offset turns a working read into a refusal.

The v0.5.0 handoff still said the tag was pending. It is applied at
155fcbc and published.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Version bump and release verification

**Files:**
- Modify: `package.json` — `version`
- Modify: `src/index.ts:24` — `VERSION`

**Interfaces:**
- Consumes: Tasks 1-5 all landed.
- Produces: a tree ready for the `v0.6.0` tag. **This task does not tag or publish.**

- [ ] **Step 1: Bump both version strings together**

`package.json`'s `"version": "0.5.0"` and `src/index.ts:24`'s `export const VERSION = '0.5.0'` both
become `0.6.0`. `test/smoke.spec.ts` asserts they agree, so a half-done bump fails the suite.

Minor, not patch: no exported signature moves, but a read that used to succeed now throws, and a
consumer can observe that.

- [ ] **Step 2: Build, then test, in that order**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS. The ordering is load-bearing — `test/smoke.spec.ts` reads `dist/index.js`, so with
no `dist/` it fails with ENOENT and with a stale one it passes against a bundle that no longer
matches `src/`.

- [ ] **Step 3: Run the packed-tarball drill**

Run: `pnpm release:drill`
Expected: all fourteen checks pass. On failure it exits 1 and names a temp directory — read the
report there rather than guessing.

This is the check the test suite structurally cannot do: it installs the packed tarball into a
clean directory and drives the **installed** CLI against the emulator. A broken CJS build once
dropped `dist/index.cjs` with no test failing.

- [ ] **Step 4: Commit**

```bash
git add package.json src/index.ts
git commit -m "$(cat <<'EOF'
chore: 0.6.0

A user read that used to succeed on a body of 504 bytes now throws, so
this is a minor bump even though no exported signature moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Stop, and hand back**

Do **not** tag, push the tag, or publish. Per `CLAUDE.md`: the package is published, releases go
through the tag, and the `npm-publish` environment must be approved by a human. Report that the
tree is ready and that the remaining steps are, in order:

1. Push `main`; CI runs the drill on Linux and Windows.
2. `git push origin v0.6.0` after tagging.
3. Approve the `npm-publish` environment.
4. Delete the stale `origin/chore/post-merge-cleanups` branch — all three of its changes are
   already on `main`.

`docs/RELEASING.md` is the procedure, and its §5 lists what the pipeline does not prove.
