# Handoff — continuing `zkteco-protocol` past v0.4.3

**Date:** 2026-09-01
**For:** a session picking this repository up cold
**Repository:** https://github.com/ChuKhaLi/zkteco-protocol — public, MIT, `main`
**State:** v0.4.3, 571 tests, 1 skipped, zero runtime dependencies. CI green.
**Published.** `zkteco-protocol` is on npm: 0.4.2 by hand, 0.4.3 by pipeline.

This continues `2026-09-01-continuing-past-v0.4.1-HANDOFF.md`, which continues four before it.
Everything in them remains accurate except the two things §1 corrects. Read `CLAUDE.md` first, then
`docs/RELEASING.md` if you intend to release anything.

---

## 1. The two sentences in the last handoff that were wrong

**"The §5 backlog was the last written-down work that could be done without a device."** It was the
last *written-down* work. It was not the last work: a defect that made the published CLI do nothing
on Linux and macOS had been sitting in `src/cli.ts` since v0.4.0, and no amount of reading the
backlog would have found it, because nothing in this repository had ever executed the packed
artifact anywhere but Windows.

**"Publish, so someone else can"** was ranked second, framed as a decision with no engineering in
it. Taking it turned out to require a bug fix, and the bug it surfaced was the most serious one this
project has had. Publishing was not a decision *instead of* work; it was the only remaining way to
find that particular work.

Neither sentence was careless. Both were true about everything their authors could see, which is
what makes them worth recording.

## 2. What changed

**The library is published, and `npx zkteco-protocol <host>` works for a stranger with a terminal.**
That instruction has been the README's first line since v0.4 and worked for nobody until today.

**There is a release pipeline** — `.github/workflows/release.yml`, tag `v*` → gates → an
environment approval → OIDC publish → GitHub Release. `docs/RELEASING.md` is the procedure and its
§5 is the list of what the pipeline does *not* prove. Two operational facts that will not be
obvious from the YAML:

- **The trusted publisher is bound to the workflow's filename.** Renaming `release.yml` breaks
  publishing until the trust relationship on npm is updated. There is no token in this repository
  and there should never be one.
- **The `npm-publish` environment gates the publish job, not a step.** That is why verification and
  publication are two jobs; in one job the approval would be requested before any test had run.

**The packed-tarball drill runs in CI**, which is how any of this was found. It had existed since
v0.4 and had only ever been run by hand, on Windows.

**0.4.2 and 0.4.3 differ in one way worth knowing.** 0.4.2 was published from a laptop and carries
no provenance attestation; 0.4.3 was published by the pipeline and carries a verified SLSA v1
attestation (`npm audit signatures` confirms both the registry signature and the attestation from a
clean install). A version published by hand can never gain one retroactively.

## 3. The defect, because it is the most instructive one yet

`src/cli.ts` decided whether to run `main()` by comparing `import.meta.url` against
`pathToFileURL(process.argv[1])`. Node resolves symlinks in the entry before `import.meta.url` and
leaves `argv[1]` as the path the shell was handed, so those two are the same expression only while
nothing links to the file. **npm links a bin as a symlink on POSIX and writes a `.cmd` shim naming
the real path on Windows.** So the guard held on the one platform this project is developed on, and
was false for every consumer who installed the package: `main()` was never called, and the process
exited 0 having written no report, printed nothing to either stream, and reported no failure.

Fixed in `cdd4c51` by resolving `argv[1]` before the comparison, accepting either form because
`--preserve-symlinks-main` inverts which one matches. The regression test drives the built
`dist/cli.js` through a directory junction, so the bug reproduces on Windows, which never had it.

**Three things about the shape of this, in descending order of usefulness:**

1. **A check that has only ever run in one environment has established something about that
   environment and nothing else.** Not "test on Linux" — the general form. Every green tick this
   project had collected about the packed artifact was a fact about Windows, and nobody had written
   down that that was all it was.
2. **This is the project's signature defect, in the shipped product.** Exit 0 reporting success
   while doing nothing whatsoever. It had also colonised the drill, whose `default run exits 0`
   check went green immediately above the abort — exit 0 was not evidence the CLI had run.
3. **The failure reported less than it knew.** The drill said "no Markdown report was written" while
   `spawnSync` had captured the fact that the CLI exited 0 with both streams empty — the one datum
   that identifies the bug. Recovering it took reproducing the run by hand in a container. Fixed in
   `bff8984`; both artifact aborts now print the exit code and both streams.

## 4. What you are choosing between

**There is one option now, and it is the one every handoff since v0.1 has recommended: get a device
and run the kit.** The second option is spent — the package is published, the pipeline works, and
the argument for publishing ("a tool built for a stranger is reachable only by someone who clones
the repository") no longer describes anything.

```
npx zkteco-protocol <host>
npx zkteco-protocol <host> --raw-capture trace.jsonl
```

**The checklist still stands at twenty-three items**, unchanged since v0.4. They are twenty-three
questions no further reading can answer, and the tool that answers them is now one command for
anybody, on any platform, with no clone.

## 5. What not to do

Unchanged, and none of it has softened:

- **No write paths.** Not access control, not clock-setting, not user writes.
- **Do not add checklist items.** The twenty-three are the backlog.
- **Do not build the reachable-but-unbuilt read commands** — workcodes, SMS, access-control config.
  Each is built from documentation nobody has checked against a device.
- **Do not read `pyzk` source.** Execute it; never read it.

One addition, from §2: **do not publish by hand again.** 0.4.2 is the only version that will ever
lack provenance, and the only reason it does is that npm cannot configure a trusted publisher for a
package that does not yet exist. Every release from here goes through the tag.

## 6. Sources

Unchanged from the previous handoff's §5. No oracle capture was added and no new source was read in
v0.4.2 or v0.4.3. `PROVENANCE.md` needs no change: nothing in either release touched a protocol
claim.

The binding authority is `docs/superpowers/specs/`. Read §12 of the v0.1 spec — all twenty-three
items — before trusting any reading from a real device.

**No physical ZKTeco device has ever been connected to this library.** Publishing did not change
that, and it is still the only fact that should shape what you pick up next.
