# zkteco-protocol v0.3 — Terminal Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three read-only commands — `getIdentity()`, `getParameters()` and `getTime()` — so a device can report what model, firmware and clock it has.

**Architecture:** A pure codec module (`src/codec/params.ts`) encodes a keyword request and decodes a `keyword=value` reply, including a guard that the reply echoes what was asked. A command module (`src/commands/device.ts`) orchestrates the sequential round trips. `Session` gains an internal `tryExecute` so an `ACK_ERROR` can be read as an answer instead of caught by class. Nothing in the transport layer changes.

**Tech Stack:** TypeScript 5.7 (ESM, `.js` import specifiers), Node ≥20.19, vitest 2.1, tsup. Zero runtime dependencies. Package manager is `pnpm`.

**Spec:** `docs/superpowers/specs/2026-08-29-zkteco-terminal-read-design.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` keeps `"dependencies": {}` literally empty. Only `node:net` and `node:dgram` at runtime. Never a native module.
- **No write path, without exception.** `CMD_OPTIONS_WRQ`, `CMD_SET_TIME`, restart, power off, sleep, door open, user create/delete/modify are all out of scope. Not deferred for effort — deferred for risk.
- **`pyzk` is GPL-2.0: execute it, never read it.** Its source is never opened, searched, or paraphrased. `zkteco-js` is MIT and may be read freely.
- **The library never returns a `Date`.** Times are `ZkNaiveTime`, with `local` as a plain string field.
- **Never fabricate an identity.** A `null` beats a plausible wrong value.
- **Fail loud, parse nothing.** No partial results, no salvage.
- **Every test runs over both transports** unless genuinely transport-specific — then skip explicitly with a stated reason in the code, naming what still covers the other side.
- **English everywhere,** including commit messages and code comments.
- **`pnpm test` and `pnpm typecheck` clean before every commit.**
- **The countermeasure is mandatory.** For every regression test: break the code it guards, confirm it goes red *on the intended assertion*, and say in the commit that you did.
- Final target: `VERSION === '0.3.0'`, runtime export list exactly **twelve** names.

---

### Task 1: `readNulTerminated` decodes latin1

Spec §5.3. Do this first: every later task decodes device strings through this function, and settling it now avoids two decoders with different behaviour.

**Files:**
- Modify: `src/codec/records/shared.ts`
- Test: `test/codec/records/user.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readNulTerminated(buf: Buffer, start: number, length: number): string` — unchanged signature, now latin1. Tasks 2 and 6 depend on its byte-preserving behaviour.

- [ ] **Step 1: Write the failing test**

Append to `test/codec/records/user.spec.ts`:

```ts
describe('non-ASCII names', () => {
  it('preserves bytes above 0x7f instead of stripping the high bit', () => {
    // A 72-byte user record whose name field (bytes 11..34) holds bytes that
    // are not valid ASCII. Node's 'ascii' decoder masks them to & 0x7f, which
    // silently returns a different, plausible-looking name with no way back
    // to what the device actually sent.
    const rec = Buffer.alloc(USER_RECORD_SIZE)
    rec.writeUInt16LE(7, 0)
    const nameBytes = Buffer.from([0xc3, 0x94, 0xc3, 0xa9, 0xd0, 0x96])
    nameBytes.copy(rec, 11)
    rec.write('1001', 48, 'latin1')

    const body = Buffer.alloc(4 + USER_RECORD_SIZE)
    body.writeUInt32LE(USER_RECORD_SIZE, 0)
    rec.copy(body, 4)

    const [user] = parseUserData(body)
    expect(user).toBeDefined()
    expect(Buffer.from(user!.name, 'latin1')).toEqual(nameBytes)
  })
})
```

Add `USER_RECORD_SIZE` to the existing import from `../../../src/codec/records/user.js` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/codec/records/user.spec.ts -t "preserves bytes"`
Expected: FAIL. The received buffer is `<43 14 43 29 50 16>` — every byte masked with `& 0x7f` — not the `<c3 94 c3 a9 d0 96>` that was written.

- [ ] **Step 3: Change the decoder**

In `src/codec/records/shared.ts`, replace the whole file:

```ts
/**
 * Reads a fixed-width field and truncates at the first NUL byte.
 * Never reads past the field's own bounds.
 *
 * Decodes latin1, NOT ascii. Node's 'ascii' is latin1 with the high bit
 * stripped, so a device sending a name outside ASCII returns a well-typed,
 * plausible-looking, WRONG string with no way to recover the original bytes
 * and nothing anywhere reporting an error. latin1 is byte-preserving: a
 * consumer that needs the real characters gets them back with
 * `Buffer.from(value, 'latin1')` and the device's actual encoding.
 *
 * Which encoding devices really use is unknown and is item 20 on the
 * first-hardware checklist. latin1 is the decoding that keeps that question
 * answerable.
 */
export function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1')
}
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, one test heavier than the 335 the suite had before. Every existing assertion uses ASCII-only fixtures, so latin1 produces byte-identical output for all of them. If any existing test fails, that test was asserting the masking behaviour — read it before changing it.

- [ ] **Step 5: Verify the countermeasure**

Revert `shared.ts` to `.toString('ascii')`, re-run the new test, confirm it fails on the buffer comparison. Restore latin1.

- [ ] **Step 6: Commit**

```bash
git add src/codec/records/shared.ts test/codec/records/user.spec.ts
git commit -m "fix(codec): decode device strings as latin1, not ascii

Node's 'ascii' is latin1 with the high bit stripped. A device name or an
employee name outside ASCII decoded to a well-typed, plausible-looking,
wrong string, with no way to recover the original bytes and nothing
reporting an error — the defect shape this project has been catching
since v0.1.

latin1 is byte-preserving, so Buffer.from(name, 'latin1') gets the real
bytes back. This is a behaviour change on the published surface for
ZkUser.name and ZkUser.userId; on a pure-ASCII device the output is
byte-for-byte identical to before.

Countermeasure: reverted to 'ascii' and confirmed the new test fails on
the buffer comparison, not collaterally."
```

---

### Task 2: The params codec, pure

Spec §3.1, §4.3, §5.1, §5.2.

**Files:**
- Modify: `src/codec/commands.ts`
- Create: `src/codec/params.ts`
- Test: `test/codec/params.spec.ts`

**Interfaces:**
- Consumes: `readNulTerminated` from Task 1.
- Produces:
  - `DEVICE_PARAM` — a frozen `as const` object of keyword literals.
  - `encodeParamRequest(keyword: string): Buffer`
  - `decodeParamReply(keyword: string, body: Buffer): string`
  - `CMD.OPTIONS_RRQ = 11`, `CMD.GET_TIME = 201`, `CMD.GET_VERSION = 1100`

- [ ] **Step 1: Write the failing test**

Create `test/codec/params.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEVICE_PARAM, decodeParamReply, encodeParamRequest } from '../../src/codec/params.js'
import { ZkProtocolError } from '../../src/errors.js'

const body = (s: string): Buffer => Buffer.from(s, 'latin1')

describe('encodeParamRequest', () => {
  it('sends the keyword bare: no NUL terminator, no length prefix', () => {
    const out = encodeParamRequest('~SerialNumber')
    expect(out).toEqual(Buffer.from('~SerialNumber', 'latin1'))
    expect(out.length).toBe(13)
    expect(out.includes(0)).toBe(false)
  })

  it('refuses an empty keyword', () => {
    expect(() => encodeParamRequest('')).toThrow(RangeError)
  })

  it("refuses a keyword containing '=' or NUL, which would make the echo check ambiguous", () => {
    expect(() => encodeParamRequest('~OS=x')).toThrow(RangeError)
    expect(() => encodeParamRequest('~OS\0')).toThrow(RangeError)
  })
})

describe('decodeParamReply', () => {
  it('returns the value after the separator', () => {
    expect(decodeParamReply('~SerialNumber', body('~SerialNumber=ABC123'))).toBe('ABC123')
  })

  it('truncates NUL padding', () => {
    expect(decodeParamReply('~OS', body('~OS=Linux\0\0\0\0'))).toBe('Linux')
  })

  it('splits on the FIRST separator, so a value may contain one', () => {
    expect(decodeParamReply('~SSR', body('~SSR=a=b=c'))).toBe('a=b=c')
  })

  it('returns an empty string for an empty value, which is an answer not a refusal', () => {
    expect(decodeParamReply('~OS', body('~OS='))).toBe('')
  })

  it('throws when the reply echoes a different keyword than was requested', () => {
    // zkteco-js returns the whole body here, so a ~Platform reply to a
    // ~DeviceName request becomes the device name. That is fabricating an
    // identity, which v0.1 §2.5 forbids.
    expect(() => decodeParamReply('~DeviceName', body('~Platform=ZMM220'))).toThrow(ZkProtocolError)
    expect(() => decodeParamReply('~DeviceName', body('~Platform=ZMM220'))).toThrow(/~DeviceName/)
  })

  it('throws on a body with no separator at all', () => {
    expect(() => decodeParamReply('~OS', body('Linux'))).toThrow(ZkProtocolError)
  })

  it('round-trips bytes above 0x7f without loss', () => {
    const raw = Buffer.concat([body('~DeviceName='), Buffer.from([0xc3, 0x94, 0xd0, 0x96])])
    const value = decodeParamReply('~DeviceName', raw)
    expect(Buffer.from(value, 'latin1')).toEqual(Buffer.from([0xc3, 0x94, 0xd0, 0x96]))
  })
})

describe('DEVICE_PARAM', () => {
  it('carries the observed keywords as literal types', () => {
    expect(DEVICE_PARAM.SERIAL_NUMBER).toBe('~SerialNumber')
    expect(DEVICE_PARAM.DEVICE_NAME).toBe('~DeviceName')
    expect(DEVICE_PARAM.PLATFORM).toBe('~Platform')
    expect(DEVICE_PARAM.OS).toBe('~OS')
    expect(DEVICE_PARAM.MAC).toBe('MAC')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/codec/params.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/params.js`.

- [ ] **Step 3: Add the three command numbers**

In `src/codec/commands.ts`, add to the `CMD` object, keeping the existing entries untouched:

```ts
  OPTIONS_RRQ: 11,
  GET_TIME: 201,
  GET_VERSION: 1100,
```

- [ ] **Step 4: Write the codec**

Create `src/codec/params.ts`:

```ts
import { ZkProtocolError } from '../errors.js'
import { readNulTerminated } from './records/shared.js'

/**
 * Well-known device parameter keywords.
 *
 * An OBSERVED list, NOT a contract. The keyword set is model- and
 * firmware-dependent: membership here is not a promise that any given device
 * exposes the keyword, and a device that does not will answer ACK_ERROR.
 * `getParameters` accepts any string, not only these.
 *
 * Note that some keywords carry a '~' prefix and some do not. The prefix is
 * part of the keyword; this library neither strips nor adds it.
 */
export const DEVICE_PARAM = {
  SERIAL_NUMBER: '~SerialNumber',
  DEVICE_NAME: '~DeviceName',
  PLATFORM: '~Platform',
  OS: '~OS',
  FP_VERSION: '~ZKFPVersion',
  VENDOR: '~OEMVendor',
  PRODUCT_TIME: '~ProductTime',
  PIN_WIDTH: '~PIN2Width',
  SSR: '~SSR',
  MAC: 'MAC',
  WORK_CODE: 'WorkCode',
  FACE_ON: 'FaceFunOn',
} as const

/**
 * Encodes a CMD_OPTIONS_RRQ request body: the keyword, bare.
 *
 * No NUL terminator and no length prefix — that is what both oracles put on
 * the wire. Whether a real device also accepts a NUL-terminated form is item
 * 18 on the first-hardware checklist.
 *
 * RangeError rather than a Zk* class: a malformed keyword is a bad argument
 * from the caller, not anything the device did, and the published error
 * taxonomy stays as v0.1 shipped it.
 */
export function encodeParamRequest(keyword: string): Buffer {
  if (keyword.length === 0) {
    throw new RangeError('parameter keyword must not be empty')
  }
  if (keyword.includes('=') || keyword.includes('\0')) {
    // A keyword containing '=' would make the echo check in decodeParamReply
    // ambiguous: there would be no way to tell the requested keyword's own
    // separator from the reply's.
    throw new RangeError(
      `parameter keyword must not contain '=' or NUL, got ${JSON.stringify(keyword)}`,
    )
  }
  return Buffer.from(keyword, 'latin1')
}

/**
 * Decodes a CMD_OPTIONS_RRQ reply body of the form `keyword=value`.
 *
 * Verifies that the reply echoes the keyword that was requested, and throws
 * when it does not. The MIT reference implementation instead replaces the
 * `keyword=` prefix with an empty string, which returns the ENTIRE body when
 * the prefix is absent — so a ~Platform reply to a ~DeviceName request would
 * surface the platform as the device name, under a field that says otherwise,
 * with no error anywhere. v0.1 §2.5: an identity is never fabricated.
 *
 * Whether real devices echo at all is item 15 on the first-hardware
 * checklist. If one does not, this throws rather than guesses.
 *
 * An empty value is returned as '' and is a legitimate answer, distinct from
 * the ACK_ERROR refusal that `getParameters` turns into an absent key.
 */
export function decodeParamReply(keyword: string, body: Buffer): string {
  const text = readNulTerminated(body, 0, body.length)
  const sep = text.indexOf('=')
  if (sep === -1) {
    throw new ZkProtocolError(
      `CMD_OPTIONS_RRQ reply for ${keyword} carries no '=' separator`,
      body,
    )
  }
  const echoed = text.slice(0, sep)
  if (echoed !== keyword) {
    throw new ZkProtocolError(
      `CMD_OPTIONS_RRQ reply echoes ${echoed} but ${keyword} was requested`,
      body,
    )
  }
  return text.slice(sep + 1)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/codec/params.spec.ts && pnpm typecheck`
Expected: PASS, 11 tests.

- [ ] **Step 6: Verify the countermeasure**

Delete the `echoed !== keyword` block, re-run, confirm the echo test fails on the `toThrow` assertion. Restore it.

- [ ] **Step 7: Commit**

```bash
git add src/codec/commands.ts src/codec/params.ts test/codec/params.spec.ts
git commit -m "feat(codec): encode and decode device parameter exchanges

CMD_OPTIONS_RRQ carries the keyword bare and answers keyword=value,
NUL-padded. The decoder verifies the reply echoes what was requested and
throws otherwise: the reference implementation returns the whole body on
a mismatch, which would surface one field's value under another field's
name — fabricating an identity.

An empty value is '' and is an answer, kept distinct from the refusal
that becomes an absent key. Splitting on the first '=' lets a value carry
its own.

DEVICE_PARAM is an observed list and its JSDoc says so; membership is not
a promise any device exposes the keyword.

Countermeasure: deleted the echo guard and confirmed the echo test fails
on its toThrow assertion."
```

---

### Task 3: `Session.tryExecute`

Spec §3.2.

**Files:**
- Modify: `src/session/Session.ts:83-90`
- Test: `test/session/session.spec.ts`

**Interfaces:**
- Consumes: `CMD.OPTIONS_RRQ` from Task 2.
- Produces: `Session.tryExecute(command: number, data?: Buffer): Promise<DecodedPacket>` — returns the reply including `ACK_ERROR`. Tasks 5 and 6 depend on it.

- [ ] **Step 1: Write the failing test**

Append to `test/session/session.spec.ts`, matching that file's existing emulator setup style:

```ts
describe('tryExecute', () => {
  it('returns an ACK_ERROR reply instead of throwing, while execute still throws', async () => {
    running = await startEmulator({
      transport: 'tcp',
      handlers: {
        [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_ERROR)],
      },
    })
    session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()

    const res = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1'))
    expect(res.command).toBe(CMD.ACK_ERROR)

    await expect(
      session.execute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1')),
    ).rejects.toBeInstanceOf(ZkProtocolError)
  })

  it('still surfaces a timeout as a timeout, not as a readable reply', async () => {
    // The whole point of tryExecute is that ONLY ACK_ERROR becomes readable.
    // Everything else must keep propagating.
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 150,
    })
    await expect(session.open()).rejects.toBeInstanceOf(ZkTimeoutError)
  })
})
```

Ensure `CMD`, `reply`, `ZkProtocolError` and `ZkTimeoutError` are imported in that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/session/session.spec.ts -t "tryExecute"`
Expected: FAIL — `session.tryExecute is not a function`.

- [ ] **Step 3: Split `execute`**

In `src/session/Session.ts`, replace the existing `execute` method with:

```ts
  /**
   * Sends one command and returns the reply, ACK_ERROR included.
   *
   * For call sites where a device refusing the command is a normal answer
   * rather than a failure — reading a parameter keyword a firmware does not
   * expose, for instance. The alternative, catching ZkProtocolError around
   * execute(), would also swallow a genuine protocol error raised anywhere
   * below and turn it into a "the device said no". That is the defect shape
   * this project has caught nine times in v0.1 and again in v0.2: code that
   * reports success while proving less than it appears to.
   *
   * Only ACK_ERROR becomes readable here. A timeout, a dropped connection and
   * a malformed packet all still propagate.
   */
  async tryExecute(command: number, data?: Buffer): Promise<DecodedPacket> {
    return this.send(command, data)
  }

  /** Sends one command and returns the reply. Throws only on ACK_ERROR. */
  async execute(command: number, data?: Buffer): Promise<DecodedPacket> {
    const res = await this.tryExecute(command, data)
    if (res.command === CMD.ACK_ERROR) {
      throw new ZkProtocolError(`device rejected command ${command}`)
    }
    return res
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/Session.ts test/session/session.spec.ts
git commit -m "feat(session): tryExecute, so ACK_ERROR can be read not caught

A device refusing a parameter keyword is a normal answer in the terminal
read scope — which keywords a firmware exposes is unknown and is
checklist item 17. Wrapping execute() in a catch on ZkProtocolError would
also swallow genuine protocol errors from any layer below and convert
them into 'the device said no'.

tryExecute returns the reply, ACK_ERROR included, and execute is now a
thin wrapper that throws. The decision about what an ACK_ERROR means
lives at the call site, where the semantics are known, and nothing is
caught by class. Internal: Session is not exported, so this costs nothing
on the public surface.

The second test pins the boundary — a timeout is still a timeout."
```

---

### Task 4: Emulator support

Spec §7.1.

**Files:**
- Modify: `test/emulator/index.ts`
- Test: `test/emulator/emulator.spec.ts`

**Interfaces:**
- Consumes: `CMD.OPTIONS_RRQ`, `CMD.GET_TIME`, `CMD.GET_VERSION` from Task 2.
- Produces: `EmulatorOptions` gains `params`, `firmware`, `deviceTimeRaw`, `paramEchoOverride`. Tasks 5, 6, 7 and 8 all construct emulators with these.

- [ ] **Step 1: Write the failing test**

Append to `test/emulator/emulator.spec.ts`:

```ts
describe('terminal read handlers', () => {
  it('answers a configured keyword and refuses an unconfigured one', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~OS': 'Linux' },
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const ok = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~OS', 'latin1'))
      expect(ok.command).toBe(CMD.ACK_OK)
      expect(ok.data.toString('latin1').replace(/\0+$/, '')).toBe('~OS=Linux')

      const refused = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SSR', 'latin1'))
      expect(refused.command).toBe(CMD.ACK_ERROR)
    } finally {
      await session.close()
    }
  })

  it('echoes a different keyword when paramEchoOverride is set', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~DeviceName': 'Gate' },
      paramEchoOverride: '~Platform',
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const res = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~DeviceName', 'latin1'))
      expect(res.data.toString('latin1').replace(/\0+$/, '')).toBe('~Platform=Gate')
    } finally {
      await session.close()
    }
  })

  it('serves firmware and the clock, and refuses both when unconfigured', async () => {
    running = await startEmulator({
      transport: 'tcp',
      firmware: 'Ver 6.60 Jun 10 2019',
      deviceTimeRaw: 0x2b1f_c4d0,
    })
    const session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), {
      timeoutMs: 2000,
    })
    await session.open()
    try {
      const fw = await session.tryExecute(CMD.GET_VERSION)
      expect(fw.data.toString('latin1')).toBe('Ver 6.60 Jun 10 2019')

      const clock = await session.tryExecute(CMD.GET_TIME)
      expect(clock.data.readUInt32LE(0)).toBe(0x2b1f_c4d0)
    } finally {
      await session.close()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/emulator/emulator.spec.ts -t "terminal read"`
Expected: FAIL — `params` is not a known property of `EmulatorOptions`, and the handlers answer `ACK_ERROR` because no handler is registered for command 11.

- [ ] **Step 3: Add the options**

In `test/emulator/index.ts`, add to `EmulatorOptions` (after `handlers`):

```ts
  /**
   * Device parameters, keyed by keyword. A keyword NOT present here is
   * answered with ACK_ERROR — which is how a firmware that does not expose a
   * parameter is modelled. Whether real devices refuse or answer with an
   * empty value is checklist item 16; configure `'~OS': ''` to model the
   * other branch.
   */
  params?: Record<string, string>
  /** Firmware string for CMD_GET_VERSION. Absent or null answers ACK_ERROR. */
  firmware?: string | null
  /**
   * The packed uint32 CMD_GET_TIME answers with, supplied directly.
   *
   * Deliberately raw: this library has no time ENCODER and does not need one,
   * so a test pins a fixed packed value against fixed decoded fields rather
   * than round-tripping through code under test. Absent answers ACK_ERROR.
   */
  deviceTimeRaw?: number
  /**
   * Makes a CMD_OPTIONS_RRQ reply echo THIS keyword instead of the one that
   * was requested — a device answering the wrong question. Exists so the
   * echo guard in src/codec/params.ts has something to catch.
   */
  paramEchoOverride?: string
```

- [ ] **Step 4: Add the handlers**

In `test/emulator/index.ts`, add above `const baseHandlers`:

```ts
/**
 * Terminal read commands.
 *
 * NOTE: these format their replies using THIS LIBRARY'S OWN convention for
 * `keyword=value` — a NUL-terminated latin1 string. So a test that only
 * round-trips through the emulator proves the request/response plumbing, NOT
 * that a real device formats its replies this way. What makes the request
 * shape evidence is an independent implementation sending the same bytes; see
 * test/oracle/params.spec.ts. The reply layout has no such backing at all,
 * because zkteco-js's parser cannot discriminate it (design spec §8.2).
 */
const terminalHandlers: HandlerTable = {
  [CMD.OPTIONS_RRQ]: (req, state) => {
    const keyword = req.data.toString('latin1')
    const params = state.opts.params ?? {}
    if (!Object.hasOwn(params, keyword)) return [reply(state, req, CMD.ACK_ERROR)]
    const echoed = state.opts.paramEchoOverride ?? keyword
    const body = Buffer.from(`${echoed}=${params[keyword]}\0`, 'latin1')
    return [reply(state, req, CMD.ACK_OK, body)]
  },
  [CMD.GET_VERSION]: (req, state) => {
    const firmware = state.opts.firmware
    if (firmware === undefined || firmware === null) {
      return [reply(state, req, CMD.ACK_ERROR)]
    }
    return [reply(state, req, CMD.ACK_OK, Buffer.from(firmware, 'latin1'))]
  },
  [CMD.GET_TIME]: (req, state) => {
    const raw = state.opts.deviceTimeRaw
    if (raw === undefined) return [reply(state, req, CMD.ACK_ERROR)]
    const body = Buffer.alloc(4)
    body.writeUInt32LE(raw >>> 0, 0)
    return [reply(state, req, CMD.ACK_OK, body)]
  },
}
```

Then add `...terminalHandlers,` to the `baseHandlers` spread, immediately after `...bufferedHandlers,`.

`Object.hasOwn` is used rather than `in` so a keyword named `toString` or `constructor` is refused rather than answered from the prototype chain.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/emulator/index.ts test/emulator/emulator.spec.ts
git commit -m "test(emulator): serve parameters, firmware and the clock

Three handlers and four options: params (a keyword absent from the table
answers ACK_ERROR, modelling a firmware that does not expose it),
firmware, deviceTimeRaw, and paramEchoOverride so the echo guard has
something to catch.

deviceTimeRaw takes the packed uint32 directly because this library has
no time encoder and needs none — a test pins a fixed value against fixed
decoded fields instead of round-tripping through code under test.

The handler comment says plainly that these format replies with the
library's own convention, so a round trip proves plumbing and not layout,
following the encodeFreeSizes and eventPacket precedent."
```

---

### Task 5: `getParameters`

Spec §4.2, §4.3, §9. Scenarios 11, 13, 14, 15.

**Files:**
- Create: `src/commands/device.ts`
- Test: `test/commands/device.spec.ts`

**Interfaces:**
- Consumes: `encodeParamRequest`, `decodeParamReply`, `DEVICE_PARAM` (Task 2); `Session.tryExecute` (Task 3); emulator `params`, `paramEchoOverride` (Task 4).
- Produces: `getParameters(session: Session, keys: readonly string[]): Promise<Record<string, string>>`. Task 6 builds `getIdentity` on it; Task 7 exposes it on `ZkDevice`.

- [ ] **Step 1: Write the failing test**

Create `test/commands/device.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { getParameters } from '../../src/commands/device.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const PARAMS = {
  '~SerialNumber': 'OAJ7194600263',
  '~DeviceName': 'MB360',
  '~Platform': 'ZMM220_TFT',
  '~OS': '',
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const connect = async (port: number, timeoutMs = 2000): Promise<Session> => {
    const transport =
      transportKind === 'tcp'
        ? new TcpTransport({ host: '127.0.0.1', port })
        : new UdpTransport({ host: '127.0.0.1', port })
    const s = new Session(transport, { timeoutMs })
    await s.open()
    return s
  }

  describe(`getParameters over ${transportKind}`, () => {
    it('returns the keys the device answered', async () => {
      running = await startEmulator({ transport: transportKind, params: PARAMS })
      session = await connect(running.port)
      expect(await getParameters(session, ['~SerialNumber', '~DeviceName'])).toEqual({
        '~SerialNumber': 'OAJ7194600263',
        '~DeviceName': 'MB360',
      })
    })

    it('omits a refused key entirely, so `in` answers whether the device replied', async () => {
      running = await startEmulator({ transport: transportKind, params: PARAMS })
      session = await connect(running.port)
      const out = await getParameters(session, ['~SerialNumber', '~SSR'])
      expect('~SSR' in out).toBe(false)
      expect(out['~SerialNumber']).toBe('OAJ7194600263')
    })

    it("keeps an empty value as '', distinct from a refusal", async () => {
      running = await startEmulator({ transport: transportKind, params: PARAMS })
      session = await connect(running.port)
      const out = await getParameters(session, ['~OS', '~SSR'])
      expect('~OS' in out).toBe(true)
      expect(out['~OS']).toBe('')
      expect('~SSR' in out).toBe(false)
    })

    it('sends nothing and returns an empty object for an empty key list', async () => {
      running = await startEmulator({ transport: transportKind, params: PARAMS })
      session = await connect(running.port)
      const before = running.received.length
      expect(await getParameters(session, [])).toEqual({})
      expect(running.received.length).toBe(before)
    })

    it('throws when the device echoes a keyword that was not requested', async () => {
      running = await startEmulator({
        transport: transportKind,
        params: PARAMS,
        paramEchoOverride: '~Platform',
      })
      session = await connect(running.port)
      await expect(getParameters(session, ['~DeviceName'])).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('propagates a timeout instead of omitting the key', async () => {
      // The defect this guards: a getParameters that treated every failure as
      // "the device does not have this" would return {} here, and {} is also
      // what a device refusing everything returns. The two must not look alike.
      //
      // The emulator's `silent` behavior cannot be used, because it refuses
      // the handshake too and the session would never open. Registering a
      // handler that returns no packets leaves the handshake working and
      // strands only the parameter read, which is the layer under test.
      running = await startEmulator({
        transport: transportKind,
        params: PARAMS,
        handlers: { [CMD.OPTIONS_RRQ]: () => [] },
      })
      session = await connect(running.port, 150)
      await expect(getParameters(session, ['~SerialNumber'])).rejects.toBeInstanceOf(ZkTimeoutError)
    })
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/commands/device.spec.ts`
Expected: FAIL — cannot resolve `../../src/commands/device.js`.

- [ ] **Step 3: Write `getParameters`**

Create `src/commands/device.ts`:

```ts
import { CMD } from '../codec/commands.js'
import { decodeParamReply, encodeParamRequest } from '../codec/params.js'
import type { Session } from '../session/Session.js'

/**
 * Reads named device parameters.
 *
 * A key the device REFUSED (ACK_ERROR) is omitted from the result rather than
 * set to undefined, so `key in result` answers exactly "did the device answer
 * this" and no default is invented for a key that was never supplied. A key
 * the device answered with an EMPTY value is present with '' — the two are
 * kept apart because which of them a firmware uses for an unsupported
 * parameter is unknown, and is checklist item 16.
 *
 * Every other failure — timeout, dropped connection, malformed reply, an echo
 * that does not match — propagates out of this loop untouched, abandoning the
 * remaining reads. There is no partial result and no salvage: a function that
 * turned five failures into five absences would be indistinguishable from a
 * device that exposes nothing.
 *
 * Strictly sequential. The transport rejects a second receive() while one is
 * already in flight.
 */
export async function getParameters(
  session: Session,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const res = await session.tryExecute(CMD.OPTIONS_RRQ, encodeParamRequest(key))
    if (res.command === CMD.ACK_ERROR) continue
    out[key] = decodeParamReply(key, res.data)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/commands/device.spec.ts && pnpm typecheck`
Expected: PASS, 12 tests (6 scenarios × 2 transports).

- [ ] **Step 5: Verify the countermeasure — this is the important one**

Temporarily replace the body of the loop with a broad catch:

```ts
    try {
      const res = await session.execute(CMD.OPTIONS_RRQ, encodeParamRequest(key))
      out[key] = decodeParamReply(key, res.data)
    } catch { /* treat every failure as absent */ }
```

Re-run. Confirm **two** tests go red: the timeout test (it now resolves to `{}` instead of rejecting) and the echo test (it now resolves instead of throwing). Confirm the failure is on the `rejects` assertion, not a teardown hang. Restore the real implementation.

- [ ] **Step 6: Commit**

```bash
git add src/commands/device.ts test/commands/device.spec.ts
git commit -m "feat(commands): read named device parameters

A refused key is omitted so 'key in result' answers whether the device
replied; an empty value stays as '' so the two remain distinguishable —
which of them a firmware uses for an unsupported parameter is checklist
item 16, and collapsing them would destroy the only signal that can
answer it.

Every other failure propagates. No partial result.

Countermeasure: replaced the loop body with a broad try/catch and
confirmed BOTH the timeout test and the echo test go red on their
rejects assertions — a getParameters that swallowed failures returns {},
which is also what a device refusing everything returns."
```

---

### Task 6: `getIdentity` and `getTime`

Spec §4.1, §4.4, §5.5. Scenarios 9, 10, 12, 16, 17.

**Files:**
- Modify: `src/commands/device.ts`
- Modify: `src/types.ts`
- Test: `test/commands/device.spec.ts`

**Interfaces:**
- Consumes: `getParameters` (Task 5), `DEVICE_PARAM` (Task 2), `decodeZkTime` from `src/codec/time.js`, `readNulTerminated` (Task 1).
- Produces:
  - `ZkDeviceIdentity` in `src/types.ts`
  - `getIdentity(session: Session): Promise<ZkDeviceIdentity>`
  - `getTime(session: Session): Promise<ZkNaiveTime>`

- [ ] **Step 1: Write the failing test**

Append inside the existing `for (const transportKind ...)` loop in `test/commands/device.spec.ts`:

```ts
  describe(`getIdentity over ${transportKind}`, () => {
    const FULL = {
      transport: transportKind,
      params: {
        '~SerialNumber': 'OAJ7194600263',
        '~DeviceName': 'MB360',
        '~Platform': 'ZMM220_TFT',
        '~OS': 'Linux',
      },
      firmware: 'Ver 6.60 Jun 10 2019',
    } as const

    it('returns all five fields when the device answers everything', async () => {
      running = await startEmulator(FULL)
      session = await connect(running.port)
      expect(await getIdentity(session)).toEqual({
        serialNumber: 'OAJ7194600263',
        deviceName: 'MB360',
        platform: 'ZMM220_TFT',
        os: 'Linux',
        firmwareVersion: 'Ver 6.60 Jun 10 2019',
      })
    })

    it('nulls only the refused field and leaves the other four intact', async () => {
      running = await startEmulator({
        transport: transportKind,
        params: {
          '~SerialNumber': 'OAJ7194600263',
          '~DeviceName': 'MB360',
          '~Platform': 'ZMM220_TFT',
        },
        firmware: 'Ver 6.60 Jun 10 2019',
      })
      session = await connect(running.port)
      const id = await getIdentity(session)
      expect(id.os).toBeNull()
      expect(id.serialNumber).toBe('OAJ7194600263')
      expect(id.firmwareVersion).toBe('Ver 6.60 Jun 10 2019')
    })

    it("keeps an empty value as '' rather than collapsing it to null", async () => {
      running = await startEmulator({
        transport: transportKind,
        params: { ...FULL.params, '~OS': '' },
        firmware: 'Ver 6.60 Jun 10 2019',
      })
      session = await connect(running.port)
      expect((await getIdentity(session)).os).toBe('')
    })

    it('nulls firmware when the device refuses CMD_GET_VERSION', async () => {
      running = await startEmulator({ transport: transportKind, params: FULL.params })
      session = await connect(running.port)
      expect((await getIdentity(session)).firmwareVersion).toBeNull()
    })

    it('returns five nulls on a device that exposes nothing', async () => {
      // Exists so the timeout test below cannot pass by accident: five nulls
      // is a REAL, reachable answer, so "it returned nulls" proves nothing on
      // its own about which failure produced them.
      running = await startEmulator({ transport: transportKind })
      session = await connect(running.port)
      expect(await getIdentity(session)).toEqual({
        serialNumber: null,
        deviceName: null,
        platform: null,
        os: null,
        firmwareVersion: null,
      })
    })

    it('THROWS on a timeout and does not return nulls', async () => {
      running = await startEmulator({
        transport: transportKind,
        params: FULL.params,
        handlers: { [CMD.OPTIONS_RRQ]: () => [] },
      })
      session = await connect(running.port, 150)
      await expect(getIdentity(session)).rejects.toBeInstanceOf(ZkTimeoutError)
    })
  })

  describe(`getTime over ${transportKind}`, () => {
    it('decodes a known packed value to known fields', async () => {
      // 2026-08-27T08:01:00 in the device's 31-day pseudo-calendar.
      const packed =
        ((26 * 12 + (8 - 1)) * 31 + (27 - 1)) * 86_400 + 8 * 3600 + 1 * 60 + 0
      running = await startEmulator({ transport: transportKind, deviceTimeRaw: packed })
      session = await connect(running.port)
      expect(await getTime(session)).toEqual({
        year: 2026, month: 8, day: 27, hour: 8, minute: 1, second: 0,
        local: '2026-08-27T08:01:00',
      })
    })

    it('throws when the reply is too short to hold a packed timestamp', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.GET_TIME]: (req, state) => [reply(state, req, CMD.ACK_OK, Buffer.alloc(2))],
        },
      })
      session = await connect(running.port)
      await expect(getTime(session)).rejects.toBeInstanceOf(ZkProtocolError)
    })
  })
```

Add `getIdentity`, `getTime` to the import from `../../src/commands/device.js`, and `reply` to the import from `../emulator/index.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/commands/device.spec.ts -t "getIdentity"`
Expected: FAIL — `getIdentity is not a function`.

- [ ] **Step 3: Add the type**

Append to `src/types.ts`:

```ts
/**
 * What a device reports about itself.
 *
 * Every field is `string | null`, and `null` means exactly one thing: THE
 * DEVICE ANSWERED AND SAID NO — it refused that keyword with ACK_ERROR. It
 * never means the read was not attempted, and it never means the connection
 * failed; a timeout, a dropped socket or a malformed reply all throw out of
 * getIdentity() instead.
 *
 * An empty string is a different answer from null: the device supplied the
 * key with no value. Which of the two a firmware uses for a parameter it does
 * not support is unknown — see the first-hardware checklist.
 *
 * No `raw` field, unlike ZkUser: strings here are decoded latin1, which is
 * byte-preserving, so `Buffer.from(value, 'latin1')` already recovers exactly
 * what the device sent.
 */
export interface ZkDeviceIdentity {
  serialNumber: string | null
  deviceName: string | null
  platform: string | null
  os: string | null
  /** Read with CMD_GET_VERSION, not as a parameter — it has no keyword echo. */
  firmwareVersion: string | null
}
```

- [ ] **Step 4: Write the two commands**

Append to `src/commands/device.ts`, and extend its imports to include `DEVICE_PARAM` from `../codec/params.js`, `decodeZkTime` from `../codec/time.js`, `readNulTerminated` from `../codec/records/shared.js`, `ZkProtocolError` from `../errors.js`, and the two types from `../types.js`:

```ts
/** The parameter keyword behind each ZkDeviceIdentity field. */
const IDENTITY_KEYS = {
  serialNumber: DEVICE_PARAM.SERIAL_NUMBER,
  deviceName: DEVICE_PARAM.DEVICE_NAME,
  platform: DEVICE_PARAM.PLATFORM,
  os: DEVICE_PARAM.OS,
} as const

/**
 * Reads the firmware version.
 *
 * CMD_GET_VERSION is NOT a parameter read: it takes an empty payload and
 * answers with the firmware string as the whole body — no keyword, no '=',
 * and so nothing to check the echo of. Do not fold this into the parameter
 * path; the echo guard would have nothing to verify and would reject a
 * perfectly good reply.
 */
async function readFirmware(session: Session): Promise<string | null> {
  const res = await session.tryExecute(CMD.GET_VERSION)
  if (res.command === CMD.ACK_ERROR) return null
  return readNulTerminated(res.data, 0, res.data.length)
}

/**
 * Reads what the device says about itself: five fields, five round trips,
 * strictly sequential because the transport rejects overlapping receives.
 *
 * A consumer that needs only one field should call getParameters with just
 * that keyword and pay for one round trip. This is the convenience, not the
 * primitive.
 */
export async function getIdentity(session: Session): Promise<ZkDeviceIdentity> {
  const params = await getParameters(session, Object.values(IDENTITY_KEYS))
  const firmwareVersion = await readFirmware(session)
  // `?? null` fills in only for a key getParameters OMITTED, which is exactly
  // the ACK_ERROR refusal. An empty-string value is neither null nor
  // undefined, so it survives this intact and stays distinguishable from a
  // refusal — see the ZkDeviceIdentity docblock.
  return {
    serialNumber: params[IDENTITY_KEYS.serialNumber] ?? null,
    deviceName: params[IDENTITY_KEYS.deviceName] ?? null,
    platform: params[IDENTITY_KEYS.platform] ?? null,
    os: params[IDENTITY_KEYS.os] ?? null,
    firmwareVersion,
  }
}

/**
 * Reads the device's own clock.
 *
 * Returns ZkNaiveTime, never a Date: the device records naive local time with
 * no offset, and a Date would bind it to the decoding process's timezone —
 * right by accident near the device, hours wrong in CI, silent either way.
 *
 * Uses execute(), not tryExecute(): unlike a parameter keyword, a device with
 * no clock command is a protocol failure rather than an answer, and the
 * return type is not nullable.
 *
 * The 31-day pseudo-calendar can legitimately decode to a date like
 * 2026-02-31. That is returned verbatim — see decodeZkTime.
 */
export async function getTime(session: Session): Promise<ZkNaiveTime> {
  const res = await session.execute(CMD.GET_TIME)
  if (res.data.length < 4) {
    throw new ZkProtocolError(
      `CMD_GET_TIME reply is ${res.data.length} bytes, need at least 4`,
      res.data,
    )
  }
  return decodeZkTime(res.data.readUInt32LE(0))
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the countermeasure**

Change `readFirmware` to `catch` around `session.execute` and return `null`, and change `getParameters`'s loop to swallow. Re-run: confirm the `THROWS on a timeout` test goes red on its `rejects` assertion while `returns five nulls on a device that exposes nothing` stays green — that pairing is the proof the timeout test is not satisfiable by the null path. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/commands/device.ts src/types.ts test/commands/device.spec.ts
git commit -m "feat(commands): getIdentity and getTime

Five sequential round trips: four CMD_OPTIONS_RRQ and one
CMD_GET_VERSION, which is deliberately a separate path because it answers
with a bare string and has no keyword echo to verify.

null means the device answered and said no. It never means the read
failed — a timeout, a dropped socket or a malformed reply all throw. An
empty value survives as '' because `?? null` fills in only for an omitted
key.

getTime returns ZkNaiveTime, never a Date, per v0.1 §2.3.

Countermeasure: made both reads swallow failures and confirmed the
timeout test goes red on its rejects assertion while the
device-exposes-nothing test stays green — the pairing is what proves the
timeout test cannot be satisfied by the legitimate all-null answer."
```

---

### Task 7: The facade and the export surface

Spec §4, §7.2 scenarios 18–19.

**Files:**
- Modify: `src/ZkDevice.ts`
- Modify: `src/index.ts`
- Modify: `package.json` (version)
- Test: `test/ZkDevice.spec.ts`, `test/smoke.spec.ts`

**Interfaces:**
- Consumes: `getIdentity`, `getParameters`, `getTime` (Tasks 5–6); `DEVICE_PARAM` (Task 2); `ZkDeviceIdentity` (Task 6).
- Produces: the final public surface — twelve runtime exports, `VERSION === '0.3.0'`.

- [ ] **Step 1: Write the failing tests**

In `test/smoke.spec.ts`, update both assertions:

```ts
    expect(VERSION).toBe('0.3.0')
```

```ts
    expect(Object.keys(api).sort()).toEqual([
      'DEVICE_PARAM',
      'EVENT_FLAG',
      'VERSION',
      'ZkAuthError',
      'ZkConnectionError',
      'ZkDevice',
      'ZkError',
      'ZkFramingError',
      'ZkProtocolError',
      'ZkTimeoutError',
      'decodeZkTime',
      'decodeZkTime6',
    ])
```

Also update the test name from `v0.2 promises` to `v0.3 promises`.

Append to `test/ZkDevice.spec.ts`, following the file's existing emulator setup:

```ts
describe('read commands while subscribed', () => {
  // The guard must be identified by ITS OWN message. Asserting only
  // ZkConnectionError would pass with the guard deleted, because the
  // transport throws the same class one layer down once it is listening.
  const SUBSCRIBED = /subscribed to realtime events/

  it('refuses getIdentity, getParameters and getTime with the guard\'s own message', async () => {
    running = await startEmulator({ transport: 'tcp', params: { '~OS': 'Linux' } })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, timeoutMs: 2000 })
    await device.connect()
    const stream = await device.subscribe()
    try {
      await expect(device.getIdentity()).rejects.toThrow(SUBSCRIBED)
      await expect(device.getParameters(['~OS'])).rejects.toThrow(SUBSCRIBED)
      await expect(device.getTime()).rejects.toThrow(SUBSCRIBED)
    } finally {
      await stream.close()
    }
  })

  it('answers all three once the stream is closed and the device reconnects', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'OAJ7194600263' },
      firmware: 'Ver 6.60',
      deviceTimeRaw: 0x2b1f_c4d0,
    })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, timeoutMs: 2000 })
    await device.connect()
    const stream = await device.subscribe()
    await stream.close()
    await device.connect()
    expect((await device.getIdentity()).serialNumber).toBe('OAJ7194600263')
    expect(await device.getParameters(['~SerialNumber'])).toHaveProperty('~SerialNumber')
    expect((await device.getTime()).year).toBeTypeOf('number')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/smoke.spec.ts test/ZkDevice.spec.ts`
Expected: FAIL — `VERSION` is `'0.2.0'`, `DEVICE_PARAM` is missing from the export list, and `device.getIdentity is not a function`.

- [ ] **Step 3: Add the three methods**

In `src/ZkDevice.ts`, extend the imports:

```ts
import { getIdentity, getParameters, getTime } from './commands/device.js'
```

and add `ZkDeviceIdentity` and `ZkNaiveTime` to the existing `import type { ... } from './types.js'`.

Add these methods immediately after `getInfo()`:

```ts
  /**
   * Reads what the device says about itself: serial number, name, platform,
   * OS and firmware version.
   *
   * Five sequential round trips. A field is `null` when the device REFUSED
   * that keyword — never when the read failed, which throws instead. Which
   * keywords a given firmware exposes is model-dependent and unverified.
   *
   * Named getIdentity rather than getDeviceInfo because ZkDeviceInfo already
   * means the storage counters that getInfo() returns.
   */
  async getIdentity(): Promise<ZkDeviceIdentity> {
    return getIdentity(this.requireIdleSession())
  }

  /**
   * Reads named device parameters.
   *
   * A key the device refused is absent from the result; a key it answered
   * with no value is present as ''. Use DEVICE_PARAM for the keywords that
   * have been observed, or pass any string.
   */
  async getParameters(keys: readonly string[]): Promise<Record<string, string>> {
    return getParameters(this.requireIdleSession(), keys)
  }

  /**
   * Reads the device's own clock, as naive local time with no offset.
   *
   * Useful mainly for detecting drift: a device whose clock has slipped
   * produces attendance timestamps that look wrong for no visible reason.
   * Setting the clock is a write path and is deliberately not implemented.
   */
  async getTime(): Promise<ZkNaiveTime> {
    return getTime(this.requireIdleSession())
  }
```

- [ ] **Step 4: Update the export surface and version**

In `src/index.ts`:

```ts
export { DEVICE_PARAM } from './codec/params.js'
```

Add `ZkDeviceIdentity` to the existing `export type { ... } from './types.js'` list, and change the last line to:

```ts
export const VERSION = '0.3.0'
```

In `package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS. `pnpm build` must succeed — `dist/index.d.ts` should now declare `DEVICE_PARAM` and `ZkDeviceIdentity`, and must NOT declare `Session`, `Transport`, `encodeParamRequest`, `decodeParamReply` or `tryExecute`.

- [ ] **Step 6: Verify the countermeasure**

Delete the `if (session.subscribed)` block from `requireIdleSession`. Re-run the guard test and confirm it goes red on the `SUBSCRIBED` regex — not on a generic connection error. Restore it.

- [ ] **Step 7: Commit**

```bash
git add src/ZkDevice.ts src/index.ts package.json test/ZkDevice.spec.ts test/smoke.spec.ts
git commit -m "feat: ZkDevice.getIdentity, getParameters and getTime

The runtime export list grows by exactly one name, DEVICE_PARAM, from
eleven to twelve; the three methods hang off ZkDevice and ZkDeviceIdentity
is a type, so neither costs a runtime export. VERSION is 0.3.0.

All three go through requireIdleSession, so a subscribed device refuses
them like every other read.

Countermeasure: deleted the subscribed check from requireIdleSession and
confirmed the guard test goes red on the message regex, not on the
transport's own ZkConnectionError one layer down — the exact way a guard
test passed with its guard deleted in v0.2."
```

---

### Task 8: Oracle capture and adjudication

Spec §8.1, §8.2, §7.3.

**Files:**
- Create: `tools/oracle/capture_pyzk_params.py`
- Create: `tools/oracle/capture_zkjs_params.ts`
- Modify: `tools/oracle/capture.ts`
- Create: `test/oracle/params.spec.ts`
- Create: fixtures under `test/fixtures/oracle/params/`

**Interfaces:**
- Consumes: the emulator options from Task 4.
- Produces: fixtures named `params-<transport>-<source>.json` under `test/fixtures/oracle/params/`.

**Critical:** fixtures go in `test/fixtures/oracle/params/`, NOT the root. `test/oracle/fixtures.spec.ts` scans every `*.json` **directly under** `test/fixtures/oracle/` and asserts an exact count of fourteen discriminating packets. A file in the root would silently change a number that test pins on purpose.

- [ ] **Step 1: Write the pyzk driver**

Create `tools/oracle/capture_pyzk_params.py`:

```python
"""Drives pyzk's device-information reads against the local emulator.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.

Method names are probed with getattr and an absence is REPORTED, never
assumed away: if pyzk has no such public method, that is recorded as
producing no evidence rather than as agreement.
"""
import sys

from zk import ZK

METHODS = (
    "get_serialnumber",
    "get_device_name",
    "get_platform",
    "get_fp_version",
    "get_firmware_version",
    "get_time",
)


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp)
    try:
        conn.connect()
        for name in METHODS:
            method = getattr(conn, name, None)
            if method is None:
                print(f"pyzk exposes no public {name}", file=sys.stderr)
                continue
            try:
                print(f"{name} -> {method()!r}", file=sys.stderr)
            except Exception as exc:
                print(f"{name} raised {exc!r}", file=sys.stderr)
    except Exception as exc:
        print(f"pyzk stopped: {exc}", file=sys.stderr)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Write the zkteco-js driver**

Create `tools/oracle/capture_zkjs_params.ts`:

```ts
/**
 * Drives zkteco-js's device-information reads (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 *
 * The parameter reads and the firmware read are wired for TCP only —
 * zkteco-js wraps them with a TCP callback and no UDP callback, so on UDP it
 * throws before touching the socket. getTime is the exception and has a real
 * UDP implementation, so the UDP run still yields evidence for CMD_GET_TIME.
 * That asymmetry is the point of running both transports here; it is recorded
 * in PROVENANCE.md rather than smoothed over.
 */
import ZKLib from 'zkteco-js'

const port = Number(process.argv[2])
const transport = process.argv[3]

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'getError' in err && typeof err.getError === 'function') {
    return JSON.stringify(err.getError())
  }
  return String(err)
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    process.stderr.write(`${label} -> ${String(await fn())}\n`)
  } catch (err) {
    process.stderr.write(`${label} failed: ${describeError(err)}\n`)
  }
}

async function main(): Promise<void> {
  const device = new ZKLib('127.0.0.1', port, 5000, 5000)
  try {
    if (transport === 'udp') {
      // Same workaround as capture_zkjs.ts: zkteco-js's TCP-to-UDP fallback
      // checks err.code on a wrapper that never carries one, so its UDP
      // branch is unreachable. Drive its ZUDP instance directly, so the wire
      // bytes are still entirely zkteco-js's construction.
      await device.zudp.createSocket()
      await device.zudp.connect()
      device.connectionType = 'udp'
      await run('udp getTime', () => device.zudp.getTime())
    } else {
      await device.createSocket()
      await run('tcp getSerialNumber', () => device.ztcp.getSerialNumber())
      await run('tcp getDeviceName', () => device.ztcp.getDeviceName())
      await run('tcp getPlatform', () => device.ztcp.getPlatform())
      await run('tcp getOS', () => device.ztcp.getOS())
      await run('tcp getFirmware', () => device.ztcp.getFirmware())
      await run('tcp getTime', () => device.ztcp.getTime())
    }
  } catch (err) {
    process.stderr.write(`zkteco-js stopped: ${describeError(err)}\n`)
  } finally {
    try {
      await device.disconnect()
    } catch {
      // the emulator may close first
    }
  }
}

void main()
```

- [ ] **Step 3: Wire it into the capture harness**

In `tools/oracle/capture.ts`, add near the other directory constants:

```ts
// Parameter captures live in their own directory, NOT in OUT_DIR, for the
// same reason as COMMKEY_DIR and REALTIME_DIR: test/oracle/fixtures.spec.ts
// scans every *.json directly under OUT_DIR and asserts an exact count of
// discriminating packets for the reply-id adjudication. These fixtures answer
// a different question and would silently change a number that test pins on
// purpose.
const PARAMS_DIR = path.join(OUT_DIR, 'params')
```

and add this function beside `captureRealtime`:

```ts
/**
 * Records what an oracle puts on the wire for the terminal read commands.
 *
 * The emulator is configured to answer every keyword either driver asks for,
 * so a driver that reaches the command produces a request packet regardless
 * of whether it can make sense of the reply. What is being captured is the
 * REQUEST shape — zkteco-js's reply parser cannot discriminate the reply
 * layout at all (design spec §8.2).
 */
async function captureParams(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
): Promise<void> {
  const emulator = await startEmulator({
    transport,
    sessionId: EMULATOR_SESSION_ID,
    params: {
      '~SerialNumber': 'ORACLE0000001',
      '~DeviceName': 'ORACLE-MB360',
      '~Platform': 'ZMM220_TFT',
      '~OS': 'Linux',
      '~ZKFPVersion': '10',
      'MAC': '00:17:61:01:02:03',
    },
    firmware: 'Ver 6.60 Jun 10 2019',
    deviceTimeRaw: 0x2b1f_c4d0,
  })
  try {
    await runOracleScript(
      source,
      'tools/oracle/capture_pyzk_params.py',
      'tools/oracle/capture_zkjs_params.ts',
      [String(emulator.port), transport],
    )
    await writeFixture(
      emulator,
      PARAMS_DIR,
      `params-${transport}-${source}.json`,
      { source, transport, emulatorSessionId: EMULATOR_SESSION_ID },
      true,
    )
  } finally {
    await emulator.close()
  }
}
```

Then append at the end of the file, after the realtime loop:

```ts
for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await captureParams(source, transport)
  }
}
```

- [ ] **Step 4: Run the capture**

```bash
python -m venv tools/oracle/.venv
tools/oracle/.venv/Scripts/pip install -r tools/oracle/requirements.txt   # Windows
pnpm oracle:capture
```

Read the stderr output carefully and write down, for each of the four runs, how many `CMD_OPTIONS_RRQ` (11), `CMD_GET_VERSION` (1100) and `CMD_GET_TIME` (201) packets landed. **Expect zkteco-js's UDP run to produce no command-11 packets at all** — that is the predicted asymmetry, not a broken capture. If it produces some, that contradicts §8.2 and must be investigated before the adjudication is written.

- [ ] **Step 5: Write the adjudication test**

Create `test/oracle/params.spec.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodeParamRequest } from '../../src/codec/params.js'

interface Packet {
  hex: string
  command: number
  checksum: number
  sessionId: number
  replyId: number
  data: string
}
interface Fixture {
  source: string
  transport: string
  packets: Packet[]
}

const DIR = path.join('test', 'fixtures', 'oracle', 'params')
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Fixture)

describe('CMD_OPTIONS_RRQ request shape', () => {
  it('has fixtures for all four source/transport combinations', () => {
    expect(fixtures).toHaveLength(4)
  })

  it('sends the keyword bare — no NUL terminator, no length prefix', () => {
    const requests = fixtures.flatMap((f) => f.packets.filter((p) => p.command === CMD.OPTIONS_RRQ))
    // An absence of evidence on one transport is recorded, not asserted away:
    // see the count assertions below and PROVENANCE.md.
    expect(requests.length).toBeGreaterThan(0)
    for (const p of requests) {
      const data = Buffer.from(p.data, 'hex')
      expect(data.includes(0)).toBe(false)
      expect(data.toString('latin1')).toMatch(/^[~A-Za-z0-9]+$/)
      expect(encodeParamRequest(data.toString('latin1'))).toEqual(data)
    }
  })

  it('records that zkteco-js reaches the parameter commands on TCP only', () => {
    const zkjsUdp = fixtures.find((f) => f.source === 'zkteco-js' && f.transport === 'udp')
    const zkjsTcp = fixtures.find((f) => f.source === 'zkteco-js' && f.transport === 'tcp')
    expect(zkjsTcp!.packets.filter((p) => p.command === CMD.OPTIONS_RRQ).length).toBeGreaterThan(0)
    // Not an agreement with anything — an absence. zkteco-js wires these
    // methods for TCP only and throws before touching a UDP socket.
    expect(zkjsUdp!.packets.filter((p) => p.command === CMD.OPTIONS_RRQ)).toHaveLength(0)
  })

  it('pins the odd-length checksum branch against an external implementation', () => {
    // ~SerialNumber is 13 bytes, so the payload is 21 — odd. Every fixture
    // captured before this scope was 8 or 12 bytes, so the trailing-odd-byte
    // branch of checksum16 had no external evidence, despite already carrying
    // CMD_PREPARE_BUFFER on the bulk-read path since v0.1.
    const odd = fixtures
      .flatMap((f) => f.packets)
      .filter((p) => Buffer.from(p.hex, 'hex').length % 2 === 1)
    expect(odd.length).toBeGreaterThan(0)
  })
})
```

> **If the capture contradicts a prediction:** do not adjust the test to match a wrong belief. Follow §8.1 of the spec — record both figures in `PROVENANCE.md`, scope the claim to what the data supports, and add a §12 item. Say in the commit which way it went.

- [ ] **Step 6: Run and check the fixture split held**

Run: `pnpm test`
Expected: PASS, including the pre-existing `test/oracle/fixtures.spec.ts` count of fourteen — **if that number moved, a fixture landed in the wrong directory.**

- [ ] **Step 7: Commit**

```bash
git add tools/oracle/capture_pyzk_params.py tools/oracle/capture_zkjs_params.ts tools/oracle/capture.ts test/oracle/params.spec.ts test/fixtures/oracle/params/
git commit -m "test(oracle): capture the terminal read exchange

Both oracles driven against the emulator for the three new commands, with
the decision rule fixed before the capture (design spec §8.1).

Fixtures land in test/fixtures/oracle/params/, not the root, because
fixtures.spec.ts scans the root wholesale and asserts an exact count of
fourteen discriminating packets for the reply-id adjudication.

zkteco-js reaches the parameter commands on TCP only — it wires them with
no UDP callback and throws before touching the socket. That is recorded
as producing NO evidence, not as agreement. getTime is the exception and
has a real UDP path, so the clock read is covered on both transports.

These are also the project's first captured odd-length payloads, which
pins a branch of checksum16 that has carried CMD_PREPARE_BUFFER since
v0.1 with no external confirmation."
```

---

### Task 9: Documentation and the checklist

Spec §8.3, §11, §12.

**Files:**
- Modify: `README.md`
- Modify: `PROVENANCE.md`
- Modify: `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md` (§12)
- Modify: `.github/ISSUE_TEMPLATE/device-report.yml`

- [ ] **Step 1: Extend the first-hardware checklist**

In the v0.1 design spec, append items 15–21 to §12, copied verbatim from §12 of `2026-08-29-zkteco-terminal-read-design.md`. Keep the existing note at the top of §12 accurate by extending it to say that items 15 onward come from the terminal read design spec.

- [ ] **Step 2: Narrow the reply-id provenance**

In `PROVENANCE.md`, find the reply-id adjudication entry and add the §8.3 finding. Keep the conclusion and narrow the wording — do not overstate this as a reversal:

```markdown
**Refinement (2026-08-29).** The claim above rests on the wire bytes and is
unchanged. Its description of two *independent* implementations overstates
the independence for the zkteco-js half.

zkteco-js does implement the reply-id quirk — it checksums over `replyId`,
then overwrites the field with `replyId + 1` — and its checksum formula
subtracts one more than the standard one's complement does. Incrementing
`replyId` raises the word sum by one and so lowers a standard checksum by one,
so the two errors cancel exactly, for any payload. Measured on the committed
fixtures:

    transmitted: replyId=1, checksum=64534
      zkteco-js's own formula over replyId-1 ....... 64534
      standard one's complement over replyId ....... 64534

Both readings collapse to the same predicate on the wire, which is what a
device sees and what this library emits, so `Session.send` and the disposition
of `applyReplyIdQuirk` are unchanged. But zkteco-js agrees on the **bytes**, by
a different internal route, not on the **rule** — so it is corroboration of the
transmitted form, not a second independent derivation of it.
```

Then add a new entry for the parameter evidence, recording exactly what the capture produced and what it does not support — in particular that zkteco-js's reply parser cannot discriminate the reply layout, so its success is evidence about the request shape only.

- [ ] **Step 3: Document the three methods**

In `README.md`, add a section after the existing usage examples:

````markdown
### Reading what the device is

```ts
const id = await device.getIdentity()
// { serialNumber: 'OAJ7194600263', deviceName: 'MB360',
//   platform: 'ZMM220_TFT', os: 'Linux', firmwareVersion: 'Ver 6.60 Jun 10 2019' }
```

A `null` field means the device **answered and refused that keyword** — not that
the read failed. A timeout or a dropped connection throws instead. An empty
string is a third, distinct answer: the device supplied the key with no value.

For anything else the device exposes:

```ts
import { DEVICE_PARAM } from 'zkteco-protocol'

const params = await device.getParameters([DEVICE_PARAM.MAC, 'WorkCode'])
if ('WorkCode' in params) { /* the device answered */ }
```

Keys the device refused are **absent** from the result rather than undefined,
so `in` answers exactly whether it replied. `DEVICE_PARAM` lists the keywords
that have been observed; it is not a promise that any given model exposes them.

```ts
const clock = await device.getTime()   // ZkNaiveTime, never a Date
```

Useful mainly for spotting drift: a device whose clock has slipped produces
attendance timestamps that look wrong for no visible reason. Setting the clock
is a write path and is deliberately not implemented.
````

Also add a note near the existing type documentation:

```markdown
**Strings are decoded as latin1, not ASCII.** Node's `'ascii'` strips the high
bit, which silently corrupts any name outside ASCII with no way to recover it.
latin1 is byte-preserving: if a device sends text in another encoding, the
original bytes are `Buffer.from(value, 'latin1')` away. Which encoding devices
actually use is an open question — see the first-hardware checklist.
```

Leave the compatibility table empty. It is still accurate.

- [ ] **Step 4: Extend the device report template**

In `.github/ISSUE_TEMPLATE/device-report.yml`, add after the `firmware` input:

```yaml
  - type: input
    id: serial_prefix
    attributes:
      label: Serial number prefix
      description: >
        The first four characters of `getIdentity().serialNumber`. Just the
        prefix — it identifies the production batch without identifying your
        specific unit.
  - type: input
    id: platform
    attributes:
      label: Platform and OS
      description: The `platform` and `os` fields from `getIdentity()`.
  - type: dropdown
    id: identity_refusals
    attributes:
      label: Did any identity field come back null?
      description: >
        A null means the device refused that keyword. Knowing which keywords a
        firmware exposes is checklist item 17 and cannot be answered without
        reports.
      options:
        ["did not test", "all five fields answered", "some came back null", "getIdentity() threw"]
  - type: dropdown
    id: clock_drift
    attributes:
      label: How far off was `getTime()` from the collecting machine's clock?
      options:
        ["did not test", "within a minute", "minutes off", "hours off", "wildly wrong or threw"]
```

- [ ] **Step 5: Verify everything is consistent**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS. Then re-read the definition of done in §11 of the design spec and confirm each line.

- [ ] **Step 6: Commit**

```bash
git add README.md PROVENANCE.md docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md .github/ISSUE_TEMPLATE/device-report.yml
git commit -m "docs: the terminal read half, and a narrowed reply-id claim

README documents the three methods and the meaning of null, which is the
part most likely to be misread: it means the device answered and said no,
never that the read failed.

PROVENANCE narrows the reply-id entry. The conclusion stands and no code
changes — both readings collapse to the same wire predicate — but
zkteco-js reaches the transmitted form through a quirk and a checksum
formula that cancel, so it corroborates the bytes rather than
independently deriving the rule.

First-hardware checklist gains items 15-21. The device report template
now asks for the fields that make the compatibility table fillable."
```

---

## Notes for the executor

**If a step's expected failure does not appear**, stop. A test that passes before its implementation exists is not testing what its name says. That is the single defect shape this project has caught most often — nine times in v0.1, four more in v0.2, never once by the suite itself.

**A green local run proves one platform.** CI runs Windows and Linux because kernel write coalescing differs: on Windows the emulator's writes can arrive as one TCP segment and on Linux as several. Nothing in this plan pushes unsolicited data, so the risk is low — but if a test in this scope is green locally and red in CI, suspect segmentation before suspecting the transport.

**Do not add a write path.** Not `CMD_OPTIONS_WRQ`, not `setTime`, not while you are already in the file. The reason is in the spec's §2.2 and it has not changed.
