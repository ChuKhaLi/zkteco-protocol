# Contributing

## The most valuable contribution

A **device report**. The compatibility table in the README starts empty because
nobody has confirmed any model against real hardware. If you have a ZKTeco
device, [open a device report](../../issues/new?template=device-report.yml).
That is what moves this project from documentation-derived to verified.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Tests run the whole library through real localhost sockets against the emulator
in `test/emulator/` — no internal mocking. Every scenario runs over both TCP and
UDP.

## Ground rules

- **No runtime dependencies.** `node:net` and `node:dgram` only. Never a native
  module.
- **Never return a `Date`.** See the README for why.
- **Never fabricate an identity.** If a user id cannot be resolved, it is
  `null`.
- **Refuse rather than guess.** Data that fails a framing check throws; it is
  never parsed into plausible-looking garbage.
- **Do not read `pyzk` source.** See [PROVENANCE.md](PROVENANCE.md). Running it
  as a black box is fine; reading it is not.

## Regenerating oracle fixtures

See [tools/oracle/README.md](tools/oracle/README.md). A change to those fixtures
is a change in what the library believes devices expect — explain it in the
commit message.
