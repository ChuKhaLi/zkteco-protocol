# Handoff — continuing `zkteco-protocol` past v0.6.1

**Date:** 2026-09-05
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** 46 test files, 784 tests passed, 3 skipped, zero runtime dependencies, with
`package.json` and `src/index.ts` both reading `0.6.1`. 61 oracle fixtures under
`test/fixtures/oracle/bulk/`. Experiments E7 and E8 landed after the tag and added fifteen tests
between them; they changed two docblocks in `src/` and no behaviour at all, so npm's `0.6.1` still
describes the published behaviour exactly.
**Tag:** `v0.6.1` is applied, and `0.6.1` is published to npm as `latest` **with a provenance
attestation and zero dependencies**; the GitHub Release exists. `v0.6.0` remains at `b04cfde`. CI
was green on all eight jobs for every merge in this cycle, `drill` on Linux and Windows included.
Nothing about the release remains to be done.

This continues `2026-09-05-continuing-past-v0.6.0-HANDOFF.md`, which continues seven before it.
Everything in them remains accurate about the trees they describe. Read `CLAUDE.md` first, then
`docs/RELEASING.md` if you intend to release anything.

This was a small cycle: three experiments that produced evidence and changed no shipped behaviour,
and one three-line fix that closed the last item on v0.6's backlog a consumer could observe. The
third experiment failed to settle its question, which is recorded as its result rather than tidied
away.

---

## 1. Experiment E6 — `recordCount`'s offset, corroborated by a second method

**What it settles.** `FREE_SIZES_OFFSET` (`src/commands/info.ts`) is documentation-derived. E5 had
given `userCount` two independent methods; `recordCount` had one, `zkteco-js`'s source. E6 supplies
the second, and it matters because `recordCount` fails *quietly*: `detectRecordSize` divides the
attendance body by it, and 8, 16 and 40 are multiples of one another, so a count wrong by a divisor
of the true size **misframes the log rather than refusing it**.

**The technique, unchanged from E5.** Serve the 80-byte `CMD_GET_FREE_SIZES` reply with **exactly
one nonzero 4-byte word**, the rest zero, once per word, across all twenty. A run that goes on to
read must have read *that* word. E6 serves three users **and** three 40-byte attendance rows, so
both candidate counts are 3 — a run is explained by the offset it read at, never by the value it
found there — and asks `pyzk` for the attendance log.

**The result.** Offset 32 alone proceeds: `PREPARE_BUFFER` carrying command 13 (`ATTLOG_RRQ`), then
`READ_BUFFER`, `FREE_DATA`, and all three rows printed back. The other nineteen stop after
`CMD_CONNECT`, `CMD_GET_FREE_SIZES`, `CMD_EXIT`, sending no `PREPARE_BUFFER` at all. Re-run over UDP
as a pair (32 positive, 36 negative), because a positive alone would show only that UDP reads *some*
count, not the *same word*.

**The part that was not predicted, and is the strongest half.** **Offset 16 is one of E6's
negatives.** Serving only the user-count word produces no attendance read whatsoever — so the two
counters gate two different reads from two different words, and E6's positive is not `pyzk` merely
reacting to a nonzero number somewhere in the reply. The converse holds in E5's fixtures: with only
word 32 nonzero, the *user* read does not happen. Both directions are asserted in
`test/oracle/bulk.spec.ts`, because either alone would leave "the words are different" resting on
one.

**What E6 cannot conclude, written before it ran.** It pins which word `pyzk`'s parser reads. It
says nothing about where a device puts the field. Commit `f0fbc38` carries the sweep and that
limitation **with no fixtures at all**, including the outcome where E6 concludes nothing — had
`pyzk` not gated the attendance read on this reply, all twenty runs would have come back positive
and `recordCount` would still rest on `zkteco-js` alone. The evidence landed in the next commit, so
git shows the framing predates the answer rather than being fitted to it.

**`recordCapacity` (offset 64) still has one method only.** No sweep can locate it: nothing `pyzk`
can be asked to do gates on a capacity. Do not describe all three offsets as doubly corroborated —
`PROVENANCE.md` says which is which.

**Incidental and bounded.** `pyzk` printed the served user ids and timestamps back exactly, which
corroborates the 40-byte record's printed-user-id field at byte 2 and its packed timestamp at byte
27. It says **nothing** about `status` (byte 26) or `punch` (byte 31): both were served as zero, so
`0|0` is what a parser reading the right byte and one reading any other zero byte would equally
print. The status/punch mapping remains the hypothesis `mapStatusAndVerify` documents.

## 1b. Experiment E7 — the status/punch mapping, half settled

**The promise that had never been kept.** `mapStatusAndVerify`
(`src/codec/records/attendance.ts`) has declared itself a HYPOTHESIS since v0.1,
and its docblock promised precisely one thing: "the oracle task decodes
identical record bytes with two independent implementations and adopts their
mapping only if they agree". No such task had ever run. `PROVENANCE.md` did not
record the hypothesis at all — a gap in the file whose job is saying what rests
on what.

**Why E6 could not answer it.** E6 served both model-dependent bytes as **zero**,
so `0|0` is what a parser reading the right byte and one reading any other zero
byte would equally print. E7 serves six values that are pairwise distinct and
occur **nowhere else in their own row**; a test pins that property, because
without it every other assertion in the block would pass vacuously.

**The result, half one — offsets, settled.** What `pyzk` prints as `status` is
the byte this library reads as `status`, and likewise for `punch`, in all three
dialects — 40-byte: 26 and 31; 16-byte: 8 and 9; 8-byte: 2 and 7. Confirmed
over UDP for the 40-byte form. `zkteco-js`'s `decodeRecordData40`
(`helper/utils.js:152`, MIT, read rather than probed) reads **the same two
bytes**.

**The result, half two — names, not settled, and the second oracle points the
other way.** `pyzk` calls byte 26 `status` and byte 31 `punch`, matching this
library. `zkteco-js` calls byte 26 **`type`** and byte 31 **`state`**. The two
vocabularies do not overlap, so the names cannot be aligned without an
assumption — and the obvious one, matching `state` to `status`, puts its
"status" at byte 31, the opposite of where this library puts it.

Per the docblock's own rule, **nothing is adopted and the divergence is
recorded**. `mapStatusAndVerify` is unchanged; only its comment moved, to say
what ran and what it found. Do not "resolve" this by picking the side that
looks tidier.

**Where the second oracle is silent.** `zkteco-js`'s `decodeRecordData16` reads
neither byte, and it has no 8-byte decoder at all. The 16- and 8-byte rows rest
on `pyzk` alone. That is absence of evidence from the second oracle, not
disagreement — the framing written before the run set that case aside
deliberately, and it must not be written up as a conflict.

**Two field-width divergences noticed while reading that source**, recorded in
`PROVENANCE.md` and acted on nowhere: `zkteco-js` takes the 40-byte printed
user id as nine bytes where this library reads up to twenty-four (both stop at
the first NUL, so they differ only past eight characters), and reads the
16-byte user id as **two** bytes where this library reads four. E7's rows carry
100001, which needs three; `pyzk` printed it back in full, so it agrees with
this library as far as that value can show, while `zkteco-js`'s source would
have truncated it to 34465.

**Eight mutation checks**, all confirming the intended test reddens: the two
fields swapped in each of the three dialects, a status read from some other
byte, the served bytes losing their discriminating property in two different
ways, a dialect parsing nothing, and UDP disagreeing with TCP.

## 1c. Experiment E8 — the junk prefix, and an experiment that concluded nothing

**The question.** `src/codec/records/attendance.ts` skips a nine-byte prefix at the head of some
40-byte payloads and takes the declared `totalSize` to **include** those bytes. The file has always
said the relationship is unverified. Nothing in this repository's own suite had ever served the
other model, because `attendanceBody` declares `prefixed.length` — every junk-prefix test to date
exercised exactly the assumption it was testing.

**Three arms, one control.** Prefix with size 129 (this library's model), prefix with size 120 (the
alternative), and no prefix with size 120. The control exists so a failure is attributable: without
it, both arms failing is equally consistent with "pyzk rejects both models" and "pyzk cannot read
these rows at all".

**The result: E8 cannot settle it, and the framing said so before the run.** The control reads all
three rows back. Both prefix arms print **identical** output, so the declared size carries no
information about which model `pyzk` uses — and that output is not the served rows. `pyzk` has no
junk-prefix handling at all.

**It fails silently, which is the part worth carrying forward.** `pyzk` did not refuse: it
completed, exited 0, printed the right *number* of records, and invented an identity for the first
one — `55`, exactly the two ASCII `5` bytes of the prefix read at the user-id offset of a window
shifted by nine. The test derives that from the prefix and the served row rather than hardcoding it,
so what is pinned is the mechanism. **Counting printed lines would have called both arms a
success**, which is this repository's signature defect observed in somebody else's implementation.

**The second oracle has no position either**, and was read before the run rather than after:
`zkteco-js`'s `ztcp.js:533` skips the four-byte header and consumes forty bytes at a time while any
remain. It never reads the declared size and never looks for a prefix.

**So the prefix stripping is corroborated by nothing** — the only decoding behaviour in this library
of which that is true. Not because the oracles disagree, but because neither has the concept. Do not
write it up as agreement in either direction.

**What this library does under the untested model, now pinned.** It reads nine bytes too few, the
remainder stops dividing by the record count, and `getAttendanceLogs` throws `ZkFramingError` — it
refuses where `pyzk` fabricates. `test/commands/attendance.spec.ts` covers that over both
transports, and two mutations confirm the test: removing the known-size guard and removing the
prefix strip each redden it. That refusal is the right failure to have, but it is still a failure —
on such a device this library returns no attendance at all.

## 2. The pyzk driver grew a second mode, and the GPL boundary held

`tools/oracle/capture_pyzk.py`'s `argv[4]` was a boolean recognising only `read-users`. It is now a
mode string with `read-attendance` beside it, calling the public `get_attendance()`.

The discipline `capture_pyzk_params.py` established is now the file's rule: the method is resolved
through `getattr` and **its absence exits 3**, so a `pyzk` that dropped it is recorded as producing
no evidence rather than as agreement; the record fields are probed the same way and an absent one
prints as `<absent:name>`, so a line with four resolved fields cannot be confused with a line that
merely has four separators. Only the public constructor, lifecycle and documented instance methods
are called. No file of its source was opened.

**E7 needed no driver change at all**, which is the payoff for having built the mode this way: it
already printed all four fields, so the experiment was four emulator variants and nothing else.

**The method that made the change checkable, worth reusing.** The driver landed in its own commit
with `experiments.ts` untouched. Regenerating then produced **all thirty-two existing fixtures
byte-identical** — which is the evidence that the `read-users` path did not move, and which a
combined commit could not have produced. Every fixture now carries a `mode` field; that was a
deliberate one-line churn across all thirty-two, done separately and reviewably.

## 3. What 0.6.1 changed

`ZkDevice.getUsers`'s `catch` swallowed any thrown value, so a `TypeError` or `RangeError` raised
inside `getInfo` — a bug in this library, not a device declining to answer — became "no count" and
the caller received a user list nobody knew had been assembled under a broken read. It is now
`if (!(err instanceof ZkError)) throw err`.

**Nothing device-facing moved, and this is the point.** Every failure `Session.exchange` can produce
is a `ZkError`, so both degradation paths behave exactly as before and the dead-session trade the
v0.6.0 handoff's §3 documents stands untouched. The ordering — transfer first, count second — is
also untouched, and is still load-bearing rather than a tidy-up waiting to happen.

**Both directions are tested, and all three mutations were run:**

| mutation | reddens |
|---|---|
| bare `catch` again | the propagation test alone |
| swallow nothing | the two degradation tests alone |
| widen the guard to `Error` | the propagation test — which is what shows it discriminates `ZkError` rather than "some error class" |

The propagation test reaches `ZkDevice`'s private session to make only `CMD_GET_FREE_SIZES` throw,
delegating every other command to the real `Session.execute`. **No device reply can produce a
non-`ZkError`** — that is the whole point of the change — so there is no seam through the emulator,
and widening the published `ZkDeviceOptions` with a test-only injection point would be the worse
trade. It asserts the same object comes back out *by identity*, and that the emulator had already
served the user transfer, so it cannot pass by throwing somewhere earlier.

## 4. What the release taught that no automated check covers

Both are written up in `docs/RELEASING.md` §5, and both were found by running things after 0.6.1
published rather than by reasoning about them.

**A pipeline-published tarball does not match a local `npm pack`, and that is not a broken build.**
0.6.1's registry shasum is `a79fa30c…`; a local pack of the tagged commit gives `df73b2c4…`. Both
archives were unpacked and compared file by file: **all twelve files are byte-identical, `dist/`
included.** The archives differ because ubuntu-latest on Node 24 and Windows gzip the same bytes
differently. §5 previously offered 0.4.2's shasum *matching* as evidence that "the publish job
rebuilds" is a narrow gap, without noting that 0.4.2 was published **by hand, from the same
machine** — so a reader comparing shasums for any pipeline-published version would have concluded
the opposite of the truth. Corrected to name content equality as the check.

**The registry artifact had never been driven.** The drill packs its *own* tarball, so installing
what a consumer downloads is a genuinely different check. After 0.6.1 published:
`npm install zkteco-protocol@0.6.1` into an empty directory (1 package, 0 transitive), then the
**installed** `npx zkteco-protocol` against `tools/emulator-serve.ts` — exit 0, the emulator's
serial absent from both the Markdown report and the JSON sidecar, `MB360` present twice so the
absence is meaningful, item 1 naming `--raw-capture`. First time in this project's history. It is
manual, was done once, and only on Windows.

## 5. What the checks establish now

- `pnpm test` — 784 passed, 3 skipped, 46 files. `pnpm typecheck` clean. Run `pnpm build` first; the
  smoke test reads `dist/`.
- `pnpm release:drill` — 14/14 locally (Windows) and on `ubuntu-latest` and `windows-latest` in CI.
- **The oracle fixtures regenerate byte-identically.** `pnpm oracle:experiments` on an unchanged
  tree leaves all **sixty-one** untouched. Any churn is a signal; investigate it rather than
  committing it.
- CI runs the drill on both operating systems for every push to `main` and every pull request. A
  push to a feature branch with no open pull request runs nothing.

**On mutation checks, because this cycle's near-miss was in the checking rather than the code.** The
first harness scraped the terminal reporter, mishandled the ANSI escape before the `×`, and returned
an empty failure list for runs that had genuinely failed — printing `NOTHING WENT RED` for three
correct, working mutations, i.e. arguing against a correct change. **Drive mutation checks from
`vitest run <spec> --reporter=json --outputFile=<path>`** and read
`testResults[].assertionResults[]`; `fullName` joins describe and test with a **space**, not `>`.
Run the whole spec rather than `-t`, so a mutation that reddens the *wrong* test is visible. All
fourteen checks in this cycle were re-run under the JSON reporter before anything was claimed.

## 6. The backlog

None of it blocks anything, and **none of it is observable by a consumer** — v0.6's one such item
was 0.6.1.

1. **`ZkDevice.getUsers` open-codes `readUserStream` + `parseUserData`**, duplicating what
   `commands/users.ts`'s `getUsers` does, so a future change there will not reach the facade.
   Inherent to needing the count *between* the two halves; worth a comment if not a refactor.
2. **The `getUsers` timeout test is TCP-only**, matching its `ACK_UNAUTH` sibling. The behaviour
   sits above the transport split, so a UDP twin would re-prove the same path. The new propagation
   test is TCP-only for the same reason.
3. **Three deadlines in the suite are tight enough to be worth knowing about.**
   `test/ZkDevice.spec.ts:177` and `test/scenarios.spec.ts:203` use `timeoutMs: 200`;
   `test/session/dataRead.legacy.spec.ts:134` and `test/session/session.spec.ts:335` use **150**,
   which is tighter. All stable across every run so far; if one ever flakes, raise that deadline
   rather than loosen the assertion.

   The v0.6.0 handoff called the 200ms one "the tightest deadline in the suite" and this handoff
   repeated it. It was never true — the two 150s predate both. A backlog entry is a claim like any
   other, and this one had been carried forward unchecked.
4. **The two `--out=` / `--raw-capture=` empty-string guards in `src/cli.ts` are near-identical.**
   Left alone on purpose: their comments record genuinely different stakes (an unredacted file
   versus a late failure), and a shared helper would erase that distinction.
5. **E7's 16- and 8-byte variants are TCP-only.** Only the 40-byte dialect got a UDP twin, which
   showed record decoding does not differ by transport; extending that to the other two would
   re-prove the same path. Listed rather than left silent, because "a check that has only run in one
   environment has established something about that environment and nothing else" is this
   repository's own rule and applies to its experiments too.
6. **The registry round trip (§4) is manual and Windows-only.** Automating it would mean a workflow
   that installs from npm after a publish. Weigh it against the fact that it has found nothing yet
   — unlike the Linux drill, which found a shipped defect the first time it ran.

**A defect this cycle found in a document rather than in code.** `PROVENANCE.md`'s pyzk-boundary
table said `capture_pyzk.py` called "none — nine lines, connect and disconnect only". That went
stale at v0.5 when the script gained `get_users()`, and stayed wrong through v0.6 — sitting directly
under a paragraph asserting all three drivers had been audited. **The passage had already been
rewritten once for going stale, and the rewrite went stale the same way.** Corrected, with the
recurrence recorded in place. The lesson is now in the file: the table row is the claim, not the
audit sentence beneath it.

## 7. What not to do

Unchanged, and none of it has softened:

- **No write paths.** Not access control, not clock-setting, not user writes.
- **Do not add checklist items.** The twenty-three are the backlog.
- **Do not add a 28-byte user decoder**, and do not add a byte-level discriminator between the
  widths. Both were refused in v0.6's brainstorming and remain out of scope until hardware settles
  the question.
- **Do not "fix" `ZkDevice.getUsers`'s ordering back to count-first.** It is load-bearing; the
  v0.6.0 handoff's §3 has the full account.
- **Do not read `pyzk` source.** Execute it; never read it.
- **Do not publish by hand.** Every release goes through the tag; the `npm-publish` environment
  gates the publish job.
- **Do not run the test suite while an implementer subagent is verifying its own work.** Mutation
  checks make the shared tree deliberately and transiently red; a controller run landing inside one
  of those windows once produced a confident diagnosis of a defect that did not exist.

## 8. What you are choosing between

Unchanged since v0.1, and this cycle sharpened it again: **there is one option that matters, and it
is to get a device and run the kit.**

```
npx zkteco-protocol <host>
npx zkteco-protocol <host> --raw-capture trace.jsonl
```

E5 and E6 have now narrowed the `FREE_SIZES_OFFSET` premise as far as this method can. Two
implementations sharing no code agree on `userCount` at 16 and `recordCount` at 32, each by a
different method, and the residual paths — fabricated users on the one hand, a misframed attendance
log on the other — now require **both** implementations to have inherited the same error rather than
one undocumented table being wrong alone. Less likely. Not zero, and not verification: if every
implementation inherited the same wrong offset from the same documentation, all of them would agree
and all of them would be wrong.

Checklist item 4 retires that, and it needs a device.

E8 (§1c) is the sharpest version of the argument this cycle produced, because it is the experiment
that **failed**. The junk prefix is real enough to be in the documentation and in this library's
decoder, and neither independent implementation has heard of it. No amount of oracle work closes
that: you cannot ask two parsers about a case neither parses. One device sending one attendance
payload with that prefix settles in a second what three experiments could not touch.

E7 (§1b) shows the same shape from the other end. It settled which two bytes carry the
model-dependent fields — three implementations' worth of agreement — and then ran straight into a
question no emulator can touch: `pyzk` and `zkteco-js` read those bytes under **conflicting
names**, and what the fields MEAN is semantics. An oracle can say which byte a parser reads. It
cannot say whether byte 26 is the one that means in-versus-out. Only a device badging a known
punch, in a known direction, settles that.

Three of the twenty-three rows (items 8, 12, 22) will never move without one no matter how this
codebase is refactored, and the other twenty are waiting on the same thing.

**No physical ZKTeco device has ever been connected to this library.** Nothing in 0.6.1 changed
that, and it remains the only fact that should shape what you pick up next.
