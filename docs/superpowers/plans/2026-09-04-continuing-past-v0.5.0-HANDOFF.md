# Handoff — continuing `zkteco-protocol` past v0.5.0

**Date:** 2026-09-04
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** the v0.5 work — 46 test files, 724 tests passed, 3 skipped, zero runtime dependencies.
`package.json` and `src/index.ts` both read `0.5.0`; that is a bump, not a release.
**Tag:** `v0.5.0` is **not applied yet**. It goes on `main` once both sub-projects below have landed
there, and pushing it is what starts the publish pipeline. When this was written the
diagnostics-evidence branch was still unmerged and `git tag -l 'v0.5*'` was empty, so nothing has
been published: read §1's remaining steps as the work, not as history.

This continues `2026-09-01-continuing-past-v0.4.3-HANDOFF.md`, which continues five before it.
Everything in them remains accurate. Read `CLAUDE.md` first, then `docs/RELEASING.md` if you intend
to release anything.

---

## 1. What v0.5 was

One multi-agent code review of the v0.4.3 tree produced two sub-projects, run one after the other:

- **Library correctness** — merged to `main` on 2026-09-02 as commit `30a06d6`
  (`docs(provenance): the control rows say only what the fixtures show`). It fixed defects the
  review found in the codec, session and command layers.
- **Diagnostics evidence** — this branch, eighteen tasks making the bring-up kit's checklist rows,
  the release drill, and the oracle fixtures claim only what the wire actually showed. It built on
  top of the library-correctness merge rather than beside it.

`v0.5.0` is the tag to apply once both are on `main`. Sub-project A is there; sub-project B was not
when this was written, so the merge, the push and `git push origin v0.5.0` are the steps that
remain, in that order and by `docs/RELEASING.md`.

## 2. What the kit now claims, and what it still cannot

Three of the twenty-three first-hardware checklist items carry the state `'not testable by this
tool'` — distinct from `'answered'` and `'not answered'`, and distinct again from `'not requested'`
(an item the operator never asked the probe to attempt). All three share one cause: this library has
no code path that could produce evidence either way, on any device, in any run.

- **Item 8** — does the device require an acknowledgment for each realtime event? This library never
  sends one. `ackEvent` (`src/codec/events.ts`) is implemented and tested but called from nowhere, by
  the v0.2 design's ruling, so no run of the realtime probe can distinguish a device that requires an
  acknowledgment from one that does not. The row used to read `'answered'` on a completed window —
  that was the window's evidence borrowed for a question it cannot address. The symptom worth
  recording by hand is named in the row itself: if a terminal delivers one event and then goes
  silent, that is what a device waiting for an acknowledgment looks like from here.
- **Item 12** — is there a way to cancel a subscription without dropping the connection? This library
  ships no unsubscribe or cancel primitive: `Transport.listen` is documented one-way, once per
  socket, and `Session` has nothing that reverses it. No branch of the realtime probe, success or
  failure, ever attempts one.
- **Item 22** — does a terminal ever answer after this library's per-request deadline has already
  expired? A late reply racing the next request is not deterministically provokable by this tool.
  **This question is still open.** Nothing in v0.5 closed it; it can only be answered by observing a
  real device, by hand, if it happens.

Beyond those three: **no physical ZKTeco device has ever been tested against this library.** Every
byte layout in `src/codec/` remains a hypothesis, cross-checked against two independent
implementations run as black boxes, never against hardware.

## 3. What the drill proves, and what it does not

`pnpm release:drill` runs **fourteen checks** against an installed, packed tarball — not the CLI run
from source. On this tree, foreground, all fourteen passed. What it establishes and what it stops
short of, from `docs/RELEASING.md` §5:

- It runs **on both operating systems, on every push to `main` and on every pull request**
  (`.github/workflows/ci.yml`), not only on a tag — a packaging regression is caught on the commit
  that introduces it, not by burning a version number on a release. A push to a feature branch with
  no open pull request runs nothing; `ci.yml`'s triggers are `push: branches: [main]` and
  `pull_request`.
- The consumer's CommonJS TypeScript check runs on **one TypeScript version** — this repository's
  own, under `module: node16`, on both CI operating systems as of 2026-09-04. Other TypeScript
  versions, `nodenext`, and bundler resolution are untested.
- **The publish job rebuilds** rather than publishing the exact bytes the drill installed. It builds
  the same commit with the same frozen lockfile, which is not the same as publishing what was
  drilled. One data point narrows the gap without closing it: 0.4.2's published tarball shasum is
  reproduced exactly by a fresh local `npm pack` of the same commit — one sample, one machine, not a
  determinism guarantee.
- The release job itself runs one OS and one Node version (ubuntu-latest, Node 24); the fuller
  platform matrix is CI's job on `main`, not the release workflow's.
- A dry run cannot exercise OIDC; the first tagged release is the first evidence that half works at
  all.

## 4. The open questions this cycle did not close

Four things this v0.5 sub-project surfaced or left standing, none settled without a device:

1. **Whether a device ever answers after this library's deadline has expired** — checklist item 22,
   §2 above. Not deterministically provokable by this tool.
2. **Whether the device needs each realtime event acknowledged** — item 8's symptom. This library has
   no way to find out because it never sends `ackEvent`; the tell to watch for by hand is one event
   followed by silence.
3. **The 28-byte user record dialect over UDP.** The reference implementation this project reads
   decodes 28-byte user records over UDP and 72-byte records over TCP; this library reads 72 on both
   transports and refuses a body that is not a whole multiple of 72 bytes — except when the body
   length happens to divide both widths (28 and 72 share a factor of 4, so a multiple of eighteen
   28-byte records is also a whole number of 72-byte records: `18 × 28 = 504 = 7 × 72`). That case
   passes the guard and hands the caller seven fabricated users. Experiment E4
   (`test/fixtures/oracle/bulk/E4-*.json`) showed `pyzk` decodes both 72-byte and 28-byte bodies over
   UDP without fixing the width by transport, so neither oracle says what a real device sends. No
   heuristic is proposed; telling the two widths apart from the bytes alone is a new wire hypothesis
   for the first hardware run to settle.
4. **The `FREE_SIZES_OFFSET` table is unverified, and experiment E0b's control does not corroborate
   it.** E0b (`test/fixtures/oracle/bulk/E0b-free-sizes-80-count-zero-tcp.json`) held the reply
   length fixed at the 80 bytes E1–E4 serve and zeroed only the count at byte offset 16; `pyzk`
   stopped short of any read, exactly as it does when the length itself is short (E0). That shows
   zeroing those four bytes is enough to stop `pyzk`'s read — a fact about `pyzk`'s parser. It is
   **not** corroboration that offset 16, or an 80-byte reply, is where or how a real device encodes
   `userCount`: intermediate lengths were never tried, no other offset was, and neither oracle
   exercises `CMD_GET_FREE_SIZES` in a way that pins the table `src/commands/info.ts` uses today.
   `PROVENANCE.md`'s "Unverified field offsets" section is unchanged by E0b.

## 5. Where the evidence lives

- **`test/fixtures/oracle/`** — captured bytes from two independent implementations (`pyzk`,
  `zkteco-js`) driven as black boxes against the local emulator, over both TCP and UDP. This is the
  only evidence this project has that isn't derived from documentation alone, and it is still not
  hardware.
- **`PROVENANCE.md`** — which claims rest on byte-level evidence, which on source reading, and which
  on nothing yet. Update it whenever that answer changes for any claim.
- **The two v0.5 specs** — `docs/superpowers/specs/2026-09-02-zkteco-library-correctness-design.md`
  (sub-project A) and `docs/superpowers/specs/2026-09-03-zkteco-diagnostics-evidence-design.md`
  (sub-project B, this branch).

## 6. What not to do

Unchanged, and none of it has softened:

- **No write paths.** Not access control, not clock-setting, not user writes. The diagnostic probe's
  command allowlist enforces this mechanically.
- **Do not add checklist items.** The twenty-three are the backlog.
- **Do not add a `--realtime-ack` probe.** Rejected for this cycle (design spec §3.1): it would put a
  packet on the wire that neither reference implementation sends.
- **Do not read `pyzk` source.** Execute it; never read it.
- **Do not publish by hand.** Every release goes through the tag; the `npm-publish` environment gates
  the publish job.
- **If the realtime drop test flakes, raise the drop, do not lower the bound.**
  `test/diagnostics/probe.realtime.spec.ts` asserts `endedAfterMs >= 20` against
  `dropAfterRegisterMs: 30`, and the emulator arms that timer in the same tick it writes the
  REG_EVENT acknowledgment while the probe starts its clock after `subscribe()` resolves — roughly
  ten milliseconds of headroom, measured on Windows only. Raising `dropAfterRegisterMs` keeps the
  assertion meaningful; lowering the floor towards zero would restore the defect the bound exists to
  catch, which is that `endedAfterMs` was printed to the operator while no test measured it.

## 7. What you are choosing between

Unchanged from the last three handoffs: **there is one option, and it is the one every handoff since
v0.1 has recommended — get a device and run the kit.**

```
npx zkteco-protocol <host>
npx zkteco-protocol <host> --raw-capture trace.jsonl
```

Three of the twenty-three checklist rows will never move without one, no matter how this codebase is
refactored: items 8, 12 and 22. The other twenty are waiting on the same thing.

**No physical ZKTeco device has ever been connected to this library.** Nothing in v0.5 changed that,
and it remains the only fact that should shape what you pick up next.
