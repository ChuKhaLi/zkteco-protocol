# Oracle capture

With no physical device available, correctness rests on comparing the bytes this
library emits against bytes emitted by two independent implementations that have
run against real hardware.

Both are driven as **black boxes** against the emulator in `test/emulator/`. The
bytes they put on the socket are recorded and committed as fixtures under
`test/fixtures/oracle/`. CI reads only those JSON files — it needs neither
Python nor either oracle installed.

Three subdirectories hold fixtures kept out of the top-level directory for the
same reason: `test/oracle/fixtures.spec.ts` scans every `*.json` directly
under `test/fixtures/oracle/` for the reply-id checksum adjudication and
asserts an exact count of discriminating packets across that corpus, so any
fixture that is not part of that adjudication goes in a subdirectory instead
of silently changing the count.

- `test/fixtures/oracle/commkey/` — `pyzk`-only captures against
  `(commKey, sessionId)` pairs chosen to isolate the comm-key mixing's
  low-byte-discard invariance (§A.4 in the design spec) specifically.
- `test/fixtures/oracle/realtime/` — both oracles' captures for the realtime
  acknowledgment adjudication (design spec v0.2, PROVENANCE.md §3).
- `test/fixtures/oracle/params/` — both oracles' captures for the
  `CMD_OPTIONS_RRQ` request-shape adjudication (design spec §8,
  PROVENANCE.md §4).

`tools/oracle/capture.ts` documents both of the newer subdirectories inline;
this is the file someone reads first, so it says so here too.

## Licensing

`pyzk` is GPL-2.0. It is executed, never read. No file under `site-packages/zk/`
is opened, and none of its code, structure, or naming appears in this
repository. Running a program and observing what it puts on a wire is outside
the scope of its license; protocol bytes are dictated by the device
manufacturer, not by any implementation. See `PROVENANCE.md`.

## Regenerating fixtures

```bash
python -m venv tools/oracle/.venv
tools/oracle/.venv/Scripts/pip install -r tools/oracle/requirements.txt   # Windows
# tools/oracle/.venv/bin/pip install -r tools/oracle/requirements.txt     # POSIX

pnpm oracle:capture
```

Review the diff before committing. A change in these fixtures means a change in
what the library believes devices expect, and deserves a paragraph in the commit
message explaining what moved and why.

## Experiments

```bash
pnpm oracle:experiments
```

Runs the four black-box experiments (E1-E4, design spec v0.5 §12) that put
`pyzk` against emulator configurations this project's own code cannot decide
between on documentation alone — echo-dependence, the `PREPARE_BUFFER` size
offset, the `READ_BUFFER` chunk shape, and the UDP user-record width. Fixtures
land in `test/fixtures/oracle/bulk/`, their own directory for the same reason
as `commkey/`, `realtime/`, and `params/` above. A `pyzk` run that could not be
spawned, or that exited non-zero, is recorded as `completed: false` with the
exit code — never folded into a result. See PROVENANCE.md for what each
experiment showed.
