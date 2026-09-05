# Handoff — continuing `zkteco-protocol` past v0.6.0

**Date:** 2026-09-05
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** 46 test files, 757 tests passed, 3 skipped, zero runtime dependencies.
`package.json` and `src/index.ts` both read `0.6.0`.
**Tag:** `v0.6.0` is applied, at `b04cfde` on `main`, and `0.6.0` is published to npm as `latest`
with provenance. CI was green on all eight jobs for that commit — including
`drill (ubuntu-latest)`, which is the first time this cycle's code ran the packed-tarball drill on
Linux. Nothing about the release remains to be done.

This continues `2026-09-04-continuing-past-v0.5.0-HANDOFF.md`, which continues six before it.
Everything in them remains accurate about the trees they describe. Read `CLAUDE.md` first, then
`docs/RELEASING.md` if you intend to release anything.

---

## 1. What v0.6 was

One defect, closed as far as it can be closed without hardware, plus two follow-ups the v0.5
whole-branch review had recorded.

**The defect.** `parseUserData` assumed every user record is 72 bytes. The reference implementation
decodes a 28-byte dialect over UDP. 28 and 72 share a factor of 4, so a body of 504 bytes — eighteen
28-byte records, and also seven 72-byte ones — passed the `% 72` framing guard, and the caller
received **seven users who were never enrolled**, each assembled from slices of other people's
records.

**The fix.** The width is derived by dividing the body length by the device's own `userCount`, the
technique `detectRecordSize` (`src/codec/records/attendance.ts`) has used for attendance since v0.3.
It reads **no record bytes**, so it adds no wire hypothesis — which is what the v0.5 handoff's §4
had ruled out. A derived width of 28 is **refused, not decoded**: no second decoder was added, and
`PROVENANCE.md`'s "adding one would be a new hypothesis" is still true. Without a count, only a
non-zero multiple of 504 is refused.

Design: `docs/superpowers/specs/2026-09-04-zkteco-user-record-width-design.md`.
Plan: `docs/superpowers/plans/2026-09-04-zkteco-user-record-width.md`.
Both carry "Corrected" blocks where implementation disproved them; see §4.

## 2. What v0.6 did NOT close, and why it cannot be closed here

**A wrong count still fabricates users.** `detectUserRecordSize` divides and trusts. A 28-byte
device with eighteen users sends 504 bytes; if `FREE_SIZES_OFFSET.userCount` is read from the wrong
offset and the value there happens to be 7, then `504 / 7 = 72` passes every guard and seven
fabricated users come back — this cycle's own defect, reached through the offset this project has
always admitted is unverified.

**It is structurally unfixable at that layer, not merely unfixed.** `detectUserRecordSize` sees
exactly two numbers, `(bodyLength, userCount)`. A misread 28-byte device presents `(504, 7)`. A
legitimate seven-user 72-byte device presents `(504, 7)`. No function of identical inputs separates
them. The three escapes all leave this project's standing constraints: reading record bytes (a wire
hypothesis, refused since v0.5), adopting the reference's transport-decides-width hypothesis, or
re-reading a count that a wrong offset returns wrongly twice.

**What the cycle actually bought,** stated the way `PROVENANCE.md` states it: before v0.6 a 504-byte
body fabricated users *unconditionally*, with no count involved at all. After it, that outcome needs
a wrong offset whose garbage value coincides with `bodyLength / 72`. A large reduction, not an
elimination. Do not let a future summary round that up to "closed".

**A second unverified premise, newly recorded.** The code also requires `userCount` to equal the
number of records in the `USERTEMP_RRQ` body — a distinct claim no oracle or device has confirmed.
An enrolment landing between the count read and the list read makes `bodyLength % userCount !== 0`
and hard-refuses. `getAttendanceLogs` guards its analogous race by reading the count on both sides
of its transfer; the user path does not, deliberately, because that round-trip was ruled out for the
poll loop. v0.6's reordering (§3) *widens* this window rather than removing it.

## 3. A regression v0.6 introduced, and the trade that fixed it

Worth reading before touching `ZkDevice.getUsers`, because the obvious "tidy-up" reintroduces it.

`ZkDevice.getUsers` first fetched the count *before* the read. `Session.exchange`
(`src/session/Session.ts`) abandons the session on `ZkTimeoutError`, `ZkFramingError` or
`ZkConnectionError`, so a device that simply never answered `CMD_GET_FREE_SIZES` had a **dead
session** by the time the `catch` set the count to `null` — and the read that followed threw
`ZkConnectionError`. Eight users (576 bytes, an unambiguous length needing no count at all) were
lost where v0.5 returned them. Three documents promised the opposite.

The fix is ordering, not error handling: the transfer runs first, `getInfo` second, so bytes in hand
cannot be lost to a count that never arrives.

**The trade this introduces, and it is a trade.** A session-killing `getInfo` failure now happens
*after* the bytes are in hand, so `ZkDevice.getUsers` can **return a complete user list and leave
the session dead** — the caller's next call fails with "this session is not open", and `connect()`
is the recovery. Under the old ordering nothing was masked, because the dead session announced
itself by destroying the read. Masking is a cost v0.6 introduced. A list plus a stale session beats
no list, but do not describe it as a repair.

Only `ZkAuthError` and `ZkProtocolError` — the replies where the device *answered* — leave a usable
session and reach that `catch` meaningfully.

## 4. Where the documents were wrong, and what that says about the method

Five claims in this cycle's own design documents were disproved during implementation, each by an
implementer or reviewer declining to transcribe a sentence it could not verify. They are recorded
inline as "Corrected" blocks rather than silently rewritten, because the pattern is the point:

- The plan predicted a RED test state that could not occur, since the earlier task had already
  closed the defect at the parser.
- The spec claimed "every body that decodes correctly today still decodes". False: a legitimate
  72-byte device with a multiple of seven users decoded before and is refused now under the no-count
  path. That refusal is the deliberate price of the ambiguity.
- The spec claimed the no-count path "limits the blast radius". It engages only when
  `CMD_GET_FREE_SIZES` *fails*; a call that succeeds from a wrong offset returns a confident wrong
  number and nothing falls back.
- The spec named two follow-ups as belonging to the v0.5 handoff's §4 that belong to a different
  list entirely.
- Two records said masking a dead session was false "under both orderings", which exonerated the
  change (§3).

**The project's signature defect appeared inside its own remedies twice this cycle**: a test added
to close a finding about non-discriminating tests was itself titled for something its fixture could
not distinguish, and a correction block written to fix an overstatement contained one pointing the
other way. Neither reached `main`. Both were caught by asking "what makes this sentence true" rather
than "does this look right".

## 5. What the checks establish now

- `pnpm test` — 757 passed, 3 skipped, 46 files. `pnpm typecheck` clean.
- `pnpm release:drill` — 14/14, run on the merged tree locally (Windows) **and** on
  `ubuntu-latest` and `windows-latest` in CI for `b04cfde`.
- CI runs the drill on both operating systems for every push to `main` and every pull request. A
  push to a feature branch with no open pull request runs nothing.
- The count-forwarding tests are built on the one body length (504) where a dropped, hardcoded or
  wrong count cannot decode at all, so all four call sites are pinned rather than merely
  type-checked. Three were only type-checked when first written; that gap was found by review.

## 6. The small backlog v0.6 left

None of it blocks anything. All of it was seen, judged, and deliberately deferred.

1. **`ZkDevice.getUsers`'s `catch` is unscoped** — it catches any thrown value, not just protocol
   errors, so a genuine programmer error inside `getInfo` degrades to "no count" instead of
   surfacing. The final review judged that narrowing it to `ZkError` would be strictly better and
   does **not** contradict the spec's §6.2, which mandates a comment rather than a bare `catch`.
   The cheapest real improvement on this list.
2. **`ZkDevice.getUsers` open-codes `readUserStream` + `parseUserData`**, duplicating what
   `getUsers` does, so a future change to `getUsers` will not reach the facade. Inherent to needing
   the count *between* the two halves; worth a comment if not a refactor.
3. **The new timeout test is TCP-only**, matching its `ACK_UNAUTH` sibling. The behaviour sits above
   the transport split, so a UDP twin would re-prove the same path.
4. **`test/ZkDevice.spec.ts`'s `timeoutMs: 200`** is the tightest deadline in the suite. Stable
   across every run so far; if it ever flakes, raise the deadline rather than loosen the assertion.
5. **The two `--out=` / `--raw-capture=` empty-string guards in `src/cli.ts` are near-identical.**
   Left alone on purpose: their comments record genuinely different stakes (an unredacted file
   versus a late failure), and a shared helper would erase that distinction.

## 7. What not to do

Unchanged, and none of it has softened:

- **No write paths.** Not access control, not clock-setting, not user writes.
- **Do not add checklist items.** The twenty-three are the backlog.
- **Do not add a 28-byte decoder**, and do not add a byte-level discriminator between the widths.
  Both were refused in v0.6's brainstorming and remain out of scope until hardware settles the
  question.
- **Do not "fix" `ZkDevice.getUsers`'s ordering back to count-first.** It is load-bearing (§3).
- **Do not read `pyzk` source.** Execute it; never read it.
- **Do not publish by hand.** Every release goes through the tag; the `npm-publish` environment
  gates the publish job.
- **Do not run the test suite while an implementer subagent is verifying its own work.** This
  project's discipline requires mutation checks — edit the source so a test *should* go red, confirm
  it does, restore — which make the shared tree deliberately and transiently broken. A controller
  suite run landing inside one of those windows in this cycle produced a confident diagnosis of an
  "order-dependent test" that did not exist.

## 8. What you are choosing between

Unchanged from every handoff since v0.1, and v0.6 sharpened rather than softened it: **there is one
option that matters, and it is to get a device and run the kit.**

```
npx zkteco-protocol <host>
npx zkteco-protocol <host> --raw-capture trace.jsonl
```

v0.6 made the case stronger, not weaker. It converted one silent fabrication into a loud refusal,
and in doing so discovered a second fabrication path it could not close — one that now turns on
whether `FREE_SIZES_OFFSET` is right, which no evidence in this repository can settle. The kit's
refusal messages were written to be the entire evidentiary output of that first run: each names the
body length, the count or its absence, and both candidate readings.

Three of the twenty-three checklist rows (items 8, 12, 22) will never move without hardware no
matter how this codebase is refactored. The other twenty are waiting on the same thing.

**No physical ZKTeco device has ever been connected to this library.** Nothing in v0.6 changed that,
and it remains the only fact that should shape what you pick up next.
