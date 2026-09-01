# Handoff — continuing `zkteco-protocol` past v0.4.1

**Date:** 2026-09-01
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** v0.4.1, 570 tests, 1 skipped, zero runtime dependencies. CI green.
**Not published to npm.** Re-checked 2026-09-01: the name is still unclaimed.

This is short on purpose. `2026-08-31-continuing-past-v0.4-HANDOFF.md` is still the substantive
document and everything in it remains accurate — read it, and the three it continues. This one
records only what changed after it and what that leaves you facing.

**Read `CLAUDE.md` first.** It did not exist when the previous handoff was written.

---

## 1. What changed since the last handoff

**v0.4.1 cleared the §5 backlog.** Five fixes, one ruling that an item was never a defect. That
handoff's §5 has the details and its §4.3 has the lesson, which is about how backlogs get written
rather than about any of the five.

**CI was red for the whole of v0.4 and is now green.** `.github/workflows/ci.yml` built *after*
testing, so `test/smoke.spec.ts` — which reads `dist/index.js` — failed with ENOENT on every run
from 2026-08-30T16:52 onward. Four consecutive red runs, v0.4.0's own among them, with nobody
looking. Fixed by reordering. **The previous handoff's §3.1 is the one section to read before
trusting any green tick in this repository's history**, because for two days there were none.

**The repository is now set up for Claude Code.** That is the only genuinely new material here, and
§2 covers it.

Nothing else moved. The first-hardware checklist still stands at 23 items, no oracle capture was
added, no new source was read, and no physical device has still ever been connected.

---

## 2. The tooling, and what it is actually for

Four things live in the repository now. Each exists because something specific went wrong before.

**`CLAUDE.md`** — the rules that override normal judgment and cannot be inferred by reading the
code: no runtime dependencies, never a `Date`, never a fabricated identity, refuse rather than
guess, no write paths, the `pyzk` GPL boundary. Also the build-before-test ordering and the defect
shape this project keeps catching, written as checks to apply rather than as a slogan.

**`.claude/skills/release-drill/`** — scripts the packed-tarball verification that §3 of the
previous handoff describes. `node .claude/skills/release-drill/scripts/drill.mjs` builds, packs,
installs into a directory sharing nothing with this repo, and drives the **installed** cli against
the emulator. Eleven checks; exit 1 and a named temp directory on failure. It covers the
`--raw-capture` half that, before this, had only ever been run by hand.

Two things about it worth keeping:

- Its expected values (`SN-PACKTEST-001`, `MB360`) are duplicated from `tools/emulator-serve.ts`.
  **Change both together.** If they drift, the redaction checks search for a string the device never
  sends and pass forever — a check that cannot fail, which is worse than no check.
- It was verified in both directions before being committed. Pointing `SERIAL` at a value the report
  legitimately contains turns the three redaction checks red and exits 1. If you change the drill,
  do that again.

**`.claude/agents/evidence-review.md`** — a reviewer for this project's signature defect, built from
the instances actually found across v0.1–v0.4. Its operating question is *if this claim were false,
what here would go red?* Ordinary code review does not look for this and will not find it.

**`.claude/settings.json`** — denies reads of `tools/oracle/.venv/`, where `pyzk`'s GPL-2.0 source
sits one call away from anyone working here, and moves `npm publish` to `ask`.

**Be clear-eyed about what that deny rule does.** It binds the `Read` and `Grep` tools. It does not
bind `cat` in a shell, and it does not apply at all in a session that started before the file
existed. It removes the most likely accident; it is not a wall. The rule in `CONTRIBUTING.md` and
`PROVENANCE.md` is still the thing that governs, and running `pyzk` as a black box remains fine.

---

## 3. What you are actually choosing between

The previous handoff ranked three options. There are two, and the third is gone deliberately: the
§5 backlog was the last written-down work that could be done without a device, and clearing it took
one session.

**First: get a device and run the kit.** Unchanged from the last three handoffs, and the reason to
prefer it is unchanged — the checklist's 23 items are 23 questions no amount of further reading can
answer. It is one command and two files now:

```
npx zkteco-protocol <host> --raw-capture trace.jsonl
```

**Second: publish, so someone else can.** The argument is that the README's own first instruction is
`npx zkteco-protocol <host>`, and that command works for nobody today — a tool built for a stranger
with a terminal is reachable only by someone who clones the repository.

If you take it, know what it commits you to: claiming the name is effectively irreversible. npm
restricts unpublishing to a short window after the initial publish and does not simply hand the name
back afterwards — check npm's current unpublish policy before relying on any specific figure, rather
than on this sentence. Run the release drill first, and know that
`package.json`'s `version` and `src/index.ts`'s `VERSION` must move together — `test/smoke.spec.ts`
now asserts they agree, which it did not before v0.4.1.

**This is the owner's decision, not a task to be picked up.** `npm publish` is set to `ask` for that
reason.

---

## 4. What not to do

Unchanged, and none of it has softened:

- **No write paths.** Not access control, not clock-setting, not user writes. The probe enforces
  this with a command allowlist naming `ENABLEDEVICE`/`DISABLEDEVICE` as forbidden.
- **Do not add checklist items.** The twenty-three are the backlog.
- **Do not build the reachable-but-unbuilt read commands** — workcodes, SMS, access-control config.
  Each is built from documentation nobody has checked against a device, so each grows the published
  surface *and* the checklist while confidence stays flat.
- **Do not read `pyzk` source.** Execute it; never read it.

---

## 5. Sources

Unchanged from the previous handoff's §8. No oracle capture was added and no new source was read in
v0.4.1 or since. `PROVENANCE.md` was re-checked against v0.4.1's stricter `classifyChecksum` and
needs no change.

The binding authority is `docs/superpowers/specs/`. Read §12 of the v0.1 spec — all twenty-three
items — before trusting any reading from a real device.
