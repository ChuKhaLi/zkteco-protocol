# User record width — design (v0.6)

**Date:** 2026-09-04
**Status:** approved in brainstorming; implementation plan to follow
**Predecessors:** `2026-09-02-zkteco-library-correctness-design.md` (v0.5 sub-project A) and
`2026-09-03-zkteco-diagnostics-evidence-design.md` (sub-project B). Both are merged; `v0.5.0` is
tagged at `155fcbc` and published. This document continues them rather than superseding anything.

---

## 1. Purpose

### 1.1 The problem

`parseUserData` assumes every user record is 72 bytes and refuses a body that is not a whole
multiple of 72. That refusal is the library's protection against misparsing the 28-byte user
record dialect the reference implementation decodes over UDP — and it has a hole.

28 and 72 share a factor of 4. Their least common multiple is 504, so a device sending eighteen
28-byte records sends 504 bytes, which is also seven whole 72-byte records. The guard passes and
the caller receives **seven users who were never enrolled**, each with a fabricated uid, name, card
number and printed user id, drawn from the middle of other people's records.

This is the one open item in the v0.5 handoff (§4.3) that is a live correctness hazard rather than
missing evidence, and it sits directly against two of this project's standing rules: *never
fabricate an identity*, and *refuse rather than guess*. `src/codec/records/user.ts` documents the
hazard in its own doc comment and leaves it open.

### 1.2 Why it was left open, and what changed

The handoff's reason was specific and still correct: *"telling the two widths apart **from the
bytes alone** is a new wire hypothesis, and the first hardware run is where the question is
settled."* No byte-level discriminator is proposed here either.

What changed is noticing that the bytes are not the only source. `parseAttendanceData` has faced
the same multi-width problem since v0.3 and solves it by **division against a device-supplied
count** — `detectRecordSize(bodyLength, recordCount)`, `src/codec/records/attendance.ts:61`. That
technique reads no record bytes at all. The user payload is the only bulk parser in this library
that does not take a count, and `CMD_GET_FREE_SIZES` already reports `userCount` beside the
`recordCount` that attendance depends on.

So the fix is not a new hypothesis. It is the technique already shipped one file over, applied to
the parser that was skipped.

### 1.3 The rule this document obeys

**A refusal must name what it could not decide.** On first hardware, the error message is the
entire evidentiary output of this change: no report row is added, no checklist item moves, and the
only human-visible artifact is the text of a `ZkFramingError`. A message that says "framing error"
and stops would make this cycle worthless on the one run it exists for. Every refusal defined below
names the body length, the count or its absence, and both candidate readings.

---

## 2. Scope

### 2.1 In scope

- `src/codec/records/user.ts` — width detection and the refusals.
- `src/commands/users.ts`, `src/commands/attendance.ts`, `src/ZkDevice.ts` — supplying the count.
- `src/diagnostics/probe.ts` — supplying the count it already reads.
- `src/cli.ts` — the `--out=` follow-up (§7.1).
- `tools/oracle/capture.ts` and `tools/oracle/run-oracle.ts` — the skip-path follow-up (§7.2).
- `test/codec/records/user.spec.ts`, `test/commands/users.spec.ts`, `test/diagnostics/cli.spec.ts`,
  `test/oracle/run-oracle.spec.ts`.
- `PROVENANCE.md`, `CLAUDE.md` where affected, and the v0.5.0 handoff's stale sections.
- The v0.6.0 release (§8).

### 2.2 Explicitly out of scope

- **A 28-byte decoder.** Rejected in brainstorming. `PROVENANCE.md` records "no second decoder
  exists; adding one would be a new hypothesis," and that sentence stays true. A device on the
  28-byte dialect is refused, loudly and precisely; it is not decoded on a guess.
- **Any byte-level discriminator** between the widths. Unchanged from the handoff's ruling.
- **New first-hardware checklist items.** The twenty-three are the backlog. Item 20 already
  degrades correctly (§6).
- **Verifying `FREE_SIZES_OFFSET`.** It remains unverified; §9 records what this change does to
  the consequences of it being wrong.
- **Write paths**, in any form.

---

## 3. Decisions taken in brainstorming

Recorded so they are not re-litigated from memory.

1. **A derived width of 28 is refused, not decoded.** Chosen over adding a 28-byte decoder from
   `zkteco-js` (MIT, readable). Rationale: shipping a second byte layout no device has confirmed,
   in the cycle whose purpose is to stop overstating, would trade one unverified claim for two.
   The refusal is itself the first hard evidence that a 28-byte device exists.
2. **The count is supplied by the caller, never fetched inside `getUsers`.** Chosen over `getUsers`
   fetching it. Rationale: `getUsers` runs inside the attendance poll loop, and
   `getAttendanceLogs` already holds a fresh count. Fetching internally would add a
   `CMD_GET_FREE_SIZES` round-trip per poll that the caller cannot see, against the library's own
   warning that a short poll interval keeps the terminal busy for the people badging at it.
3. **No count is a supported state, not a failure.** Without a count, the 72-byte read continues
   for every unambiguous body length and only a non-zero multiple of 504 is refused. Chosen over
   refusing outright. Rationale: a device whose `CMD_GET_FREE_SIZES` reply is broken keeps a
   working user read and the kit keeps its encoding verdict, while the hazard is still closed
   unconditionally — the count rescues legitimate devices, it does not close the hole.
4. **Detection lives in the codec**, beside `parseUserData`, mirroring `detectRecordSize`. Every
   framing refusal in this library lives in `src/codec/`; putting one in `src/commands/` would hide
   it where a reader would not look.

---

## 4. Detection

### 4.1 Shape

```ts
export const USER_RECORD_SIZE = 72

/**
 * The other width the reference decodes. This library has no decoder for it;
 * the constant exists so the refusal can name it.
 */
export const ALTERNATE_USER_RECORD_SIZE = 28

/** lcm(72, 28). A body length divisible by both widths is undecidable. */
export const AMBIGUOUS_USER_BODY_MODULUS = 504

export function detectUserRecordSize(
  bodyLength: number,
  userCount: number | null,
): typeof USER_RECORD_SIZE

export function parseUserData(data: Buffer, userCount: number | null): ZkUser[]
```

`userCount` on `parseUserData` is a **required** parameter with no default, matching
`parseAttendanceData(data, recordCount)`. A caller with no count writes `null` at the call site,
which is self-documenting; a default would let a call site silently lose its count during a future
edit.

`detectUserRecordSize` returns `72` or throws — there is no other width this library decodes, and
the return type says so rather than promising a generality the codebase does not have. It is a
separate exported function from `parseUserData` only so the rules in §4.2 and §4.3 can be tested
directly, without constructing a payload for each row, the way `detectRecordSize` is.

`ALTERNATE_USER_RECORD_SIZE` and `AMBIGUOUS_USER_BODY_MODULUS` are exported for the tests and for
the refusal messages. They are not added to `src/index.ts`; the published surface is unchanged
(§6.3).

### 4.2 With a count

Division, exactly `detectRecordSize`'s technique:

| Condition | Result |
|---|---|
| `userCount` is not a non-negative integer | refuse — invalid count |
| `userCount === 0` and `bodyLength > 0` | refuse — the count contradicts the body (§4.4) |
| `bodyLength % userCount !== 0` | refuse — the count does not divide the body |
| `bodyLength / userCount === 72` | decode |
| `bodyLength / userCount === 28` | refuse, naming the 28-byte dialect and that no decoder exists |
| any other quotient | refuse — derived size is not 72 |

### 4.3 Without a count (`null`)

| Condition | Result |
|---|---|
| `bodyLength % 72 !== 0` | refuse — today's message, unchanged |
| `bodyLength % 504 !== 0` | decode as 72 — **byte-for-byte identical to today** |
| `bodyLength` is a non-zero multiple of 504 | refuse — undecidable |

Because 504 is `lcm(72, 28)`, the third row is exactly and only the exposure described in §1.1.
Every body that decodes correctly today still decodes. The change is not over-broad, and §5's
576-byte test is what holds that property in place.

### 4.4 Two edge cases

**A zero-length body yields `[]`, but the check lives inside detection, not before it.** Zero is a
multiple of 504 and would otherwise trip the ambiguity rule, yet zero records is zero users under
either width — arithmetically ambiguous, semantically not. So `detectUserRecordSize` returns 72 for
an empty body when the count is `null` or `0`, and the decode loop yields `[]` naturally.

It must **not** be short-circuited ahead of detection, which an earlier draft of this section said.
An empty body against a count of 5 is a contradiction, and an early return would answer it with
`[]` — the same fabricated absence this edge case exists to prevent, arrived at from the other
direction. Detection refuses it instead.

**`getUsers` does not early-return on a zero count, and a zero count with a non-empty body is
refused.** This deliberately breaks symmetry with `getAttendanceLogs`, which does
`if (recordCount === 0) return []` and skips the read entirely. The reason is `FREE_SIZES_OFFSET`
being unverified: if the `userCount` offset is wrong, the field reads a spurious `0`, and an early
return would hand back "nobody is enrolled" — a fabricated absence, which then silently disables
user-id resolution for every attendance record that depends on the lookup. Reading anyway costs one
round-trip on genuinely fresh devices only, and converts a wrong offset table into a loud refusal
instead of an empty list.

This divergence must carry a comment saying why, or a later reader will "fix" the inconsistency
with `getAttendanceLogs` and restore the fabricated absence.

### 4.5 Message content

Each refusal names the body length, the count or its absence, and both candidate readings. The
ambiguous case is the one that matters most:

> user body of 504 bytes is undecidable without a user count: 7 record(s) of 72 bytes, or 18 of 28.
> This library decodes only 72-byte user records. `CMD_GET_FREE_SIZES` did not supply a count.

and the 28-byte case:

> user body of 504 bytes over a count of 18 implies 28-byte user records. This library decodes only
> 72-byte records and will not guess at the 28-byte dialect.

Exact wording is the implementer's; the three required facts are not.

---

## 5. Testing

Both directions for every rule, per the project's standing requirement that a fix needs a test in
both directions. Codec-level tests are pure; the command-level scenario runs over TCP and UDP as
the suites do.

| Body | Count | Expected | What it holds |
|---|---|---|---|
| 504 bytes | `null` | refuses | **The defect.** Today this returns 7 fabricated users. |
| 504 bytes | `7` | decodes 7 users | The count rescues a legitimate 72-byte device. |
| 504 bytes | `18` | refuses, names 28 | The dialect is reported, not decoded. |
| 576 bytes (8×72) | `null` | decodes 8 | The change is not over-broad. |
| 0 bytes | `null` and `0` | `[]` | §4.4's semantic case. |
| 0 bytes | `5` | refuses | An empty body against a count that claims users. |
| 504 bytes | `0` | refuses | The wrong-offset-table signal. |
| 500 bytes | `7` | refuses | The count does not divide the body. |
| 360 bytes (5×72) | `7` | refuses | Count and body disagree; not silently re-derived. |

Every one gets the project's mutation check: confirm the test fails **for the reason intended**,
not merely that it fails. The 504/`null` and 504/`7` pair is what proves the count does work rather
than being decorative — if both refuse, the count is inert and the change is a regression with
extra steps.

One command-level test asserts that `ZkDevice.getUsers()` still resolves when `getInfo` fails
(§6.2), and that the resulting error, when the read then fails on its own, still reads sensibly
rather than blaming the count.

---

## 6. Supplying the count

### 6.1 Call sites

`getUsers(session, transport, userCount: number | null)` — required, no default.

| Call site | Supplies | Why |
|---|---|---|
| `getAttendanceLogs` | `userCount` from its own second `getInfo` | Already fetched and bracketing the read. The poll loop pays **zero** extra round-trips. |
| `ZkDevice.getUsers()` | `getInfo` result, degrading to `null` on failure | The public entry point owns the acquisition policy and the single `try`/`catch`. |
| `src/diagnostics/probe.ts` | `findings.freeSizes?.userCount ?? null` | Its free-sizes step already reads this at `probe.ts:513`. A failed step yields `null`, which §4.3 handles. |

Because the count is never fetched inside `getUsers`, no call path has an invisible cost.

### 6.2 The degradation in `ZkDevice.getUsers()`

A swallowed error, which is normally a smell. It is justified only because "no count" is a defined
behaviour rather than a guess, and the `catch` carries a comment saying so. It must not mask a dead
session: under v0.5 §5.2 a timeout closes the session, so a `getInfo` timeout is followed by a bulk
read that fails on its own with its own message. §5's last test holds that the resulting error is
still legible.

### 6.3 Public surface

`parseUserData` and `getUsers` are not exported from `src/index.ts`, which exports `ZkDevice` and
types only. `ZkDevice.getUsers(): Promise<ZkUser[]>` is unchanged. Both signature changes are
internal; `test/smoke.spec.ts` pins the surface and should stay green untouched.

The only consumer-visible change is behavioural, and it is the point of the cycle: a 504-multiple
body that returned fabricated users now throws `ZkFramingError`.

---

## 7. The two swept-in follow-ups

Independent of the above, both recorded by the v0.5 whole-branch review and both bounded.

### 7.1 `--out=` is rejected during parsing

`--out=` with no value parses to `''` and fails late, when a write is attempted. `--raw-capture=`
was fixed to be rejected during parsing (`src/cli.ts:101`); `--out` was left asymmetric. Reject it
in `parseCliArgs` with a message of the same shape, and test it beside the existing
`--raw-capture=` test at `test/diagnostics/cli.spec.ts:63` — including the positive control that
`--out=report.md` still parses.

This is lower stakes than the `--raw-capture=` case it mirrors: `--out` writes redacted output, so
an empty value costs a confusing late failure, not an unredacted file at a surprising path.

### 7.2 `tools/oracle/capture.ts`'s skip-and-exit-1 path gets a test

The path at `capture.ts:260` — accumulate failures, skip writing a fixture, exit 1 — was verified
once by an induced-failure run (seven fixtures skipped, committed evidence untouched, exit 1) and
by no test.

`capture.ts` is a top-level script with top-level `await`, so it is not directly testable. Follow
the refactor the repo already made for exactly this: `tools/oracle/run-oracle.ts` exports `run`,
`succeeded` and `describeFailure`, and `test/oracle/run-oracle.spec.ts` tests them against stub
subprocesses with no `.venv` required. Extract the failure-accumulation and exit decision into a
small exported function alongside them, have `capture.ts` call it, and test it the same way.

The test must hold **both** directions: failures present → exit code 1 and every failure named on
stderr; no failures → exit code untouched. A test that only covers the failure branch would leave
the branch that matters on every green run unproven.

---

## 8. Release shape

**v0.6.0** — minor, not patch. No exported signature moves, but a read that used to succeed now
throws, which is a behaviour change a consumer can observe.

1. `package.json` `version` and `src/index.ts` `VERSION` bumped together; `test/smoke.spec.ts`
   asserts they agree.
2. `pnpm build` then `pnpm test`, in that order.
3. `pnpm release:drill` — all fourteen checks, against the packed tarball.
4. Push to `main`; CI runs the drill on Linux and Windows.
5. Tag `v0.6.0`, approve the `npm-publish` environment. Never publish by hand.
   `docs/RELEASING.md` is the procedure.

Housekeeping, unrelated to the code: delete `origin/chore/post-merge-cleanups`. All three of its
changes (`actions/checkout@v5`, `actions/setup-node@v5`, the `PROVENANCE.md` acknowledgment
wording) are already on `main`; the branch is a stale Aug-29 duplicate.

---

## 9. Documentation, and the risk that must be recorded

### 9.1 What must change or the cycle overstates itself

- **`PROVENANCE.md` §*User record width and size*** states the hazard as open and says "nothing here
  proposes a heuristic that would" close it. Rewrite: closed by division against a device-supplied
  count, not by reading bytes. Record that the 28-byte dialect is now *refused* rather than
  misparsed, that no second decoder was added, and §9.2 below.
- **`src/codec/records/user.ts`'s doc comment** describes the fabrication as unaddressed. It is the
  file being changed; its comment must not survive the change.
- **The v0.5.0 handoff** — §1's "tag is not applied yet" is now history, §4.3 is closed by this
  cycle, and two of the four follow-ups it carried were already closed before it was written
  (`test/commands/info.spec.ts:60` covers the full-length `ACK_UNAUTH` free-sizes body;
  `src/diagnostics/report.ts:139` explains item 13's `registered` conjunct as deliberate defence).

### 9.2 The risk this change introduces

`getUsers` now behaves differently depending on `FREE_SIZES_OFFSET.userCount`, a field no device
has ever confirmed. **If that offset is wrong, a device that reads users fine today starts
refusing.** That is correct behaviour under *refuse rather than guess*, and §4.3's no-count path
limits the blast radius to callers that do supply a count — but it is a real way this change could
make first contact with hardware worse rather than better.

It belongs in `PROVENANCE.md` and in the v0.6.0 release notes. It is not a reason to skip the
change: the alternative is continuing to hand callers seven strangers.

---

## 10. First-hardware checklist impact

**None.** No item is added, removed, or restated.

Item 20 (string encoding) is the only row that depends on the user read, and its `null` branch
already reads *"the user list was not read, so no names were available to inspect"* — which stays
true under a refusal. `encodingVerdict` receives no names, `findings.encoding` is `null`, and the
row reports *not answered*, which is the honest state: no evidence either way, not evidence of
absence.

The ambiguity reaches the operator through the `users` step's error text in the report, which is
why §1.3 and §4.5 treat that message as the deliverable.
