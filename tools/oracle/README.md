# Oracle capture

With no physical device available, correctness rests on comparing the bytes this
library emits against bytes emitted by two independent implementations that have
run against real hardware.

Both are driven as **black boxes** against the emulator in `test/emulator/`. The
bytes they put on the socket are recorded and committed as fixtures under
`test/fixtures/oracle/`. CI reads only those JSON files — it needs neither
Python nor either oracle installed.

`test/fixtures/oracle/commkey/` holds a further set of `pyzk`-only captures
against `(commKey, sessionId)` pairs chosen to isolate the comm-key mixing's
low-byte-discard invariance (§A.4 in the design spec) specifically — kept out
of the top-level directory because `test/oracle/fixtures.spec.ts` scans every
`*.json` directly under it for the reply-id checksum adjudication and asserts
an exact count of discriminating packets across that corpus.

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
