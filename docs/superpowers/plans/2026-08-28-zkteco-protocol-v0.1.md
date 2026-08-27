# zkteco-protocol v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free TypeScript library that reads attendance logs from ZKTeco devices over LAN port 4370, published open source under MIT.

**Architecture:** A pure-function `codec/` leaf (checksum, packet framing, comm-key mixing, time and record decoding) with a thin I/O shell above it (`transport/` → `session/` → `commands/` → `ZkDevice`). Every test runs against a scriptable socket-level device emulator over real localhost sockets — no internal mocking. Byte-level correctness is pinned by fixtures captured from two independent implementations.

**Tech Stack:** TypeScript 5.x, Node ≥ 20.19, vitest, tsup (dual ESM+CJS), pnpm. Runtime dependencies: none — only `node:net` and `node:dgram`.

**Spec:** `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`

## Global Constraints

- **Runtime:** Node `>=20.19`. `package.json` `engines.node` must say exactly `">=20.19"`.
- **Zero runtime dependencies.** `package.json` must contain `"dependencies": {}` literally. Only `node:net` and `node:dgram` may be imported at runtime. No native modules, ever.
- **License:** MIT. `LICENSE` file present at the repo root.
- **Language:** every file in the repository is written in English — README, JSDoc, code comments, commit messages, issue templates.
- **No `any` on the public surface.** `tsc --noEmit` must pass clean.
- **The library never returns `Date`.** Attendance timestamps are always `ZkNaiveTime` (spec §4.1).
- **Misaligned record data throws `ZkFramingError` and is never parsed** (spec §5.3).
- **`pyzk` source is never read, translated, or distributed.** It is executed as a black box only (spec §8).
- **Package name:** `zkteco-protocol`. **Version:** `0.1.0`.
- **Do not run `npm publish`.** Publication is a separate decision outside this plan (spec §9.4).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/errors.ts` | The `ZkError` hierarchy. No logic. |
| `src/types.ts` | Public types: `ZkNaiveTime`, `ZkUser`, `ZkAttendanceLog`, `ZkDeviceInfo`, option types. |
| `src/codec/checksum.ts` | Carry-folding one's-complement checksum. |
| `src/codec/commands.ts` | Command number constants. |
| `src/codec/packet.ts` | Payload encode/decode + `applyReplyIdQuirk`. |
| `src/codec/framing.ts` | TCP start marker + length prefix; UDP passthrough. |
| `src/codec/commkey.ts` | Comm-key mixing. |
| `src/codec/time.ts` | uint32 → `ZkNaiveTime`; the 6-byte variant. |
| `src/codec/records/attendance.ts` | Record-size detection, guards, 8/16/40-byte decoding. |
| `src/codec/records/user.ts` | User record decoding. |
| `src/transport/Transport.ts` | The transport interface. |
| `src/transport/tcp.ts` | `node:net` transport with an accumulating receive buffer. |
| `src/transport/udp.ts` | `node:dgram` transport. |
| `src/session/Session.ts` | Session id, reply-id sequencing, send-await-timeout. |
| `src/session/dataRead.ts` | Bulk reads: legacy and buffered paths. |
| `src/commands/info.ts` | `CMD_GET_FREE_SIZES`. |
| `src/commands/users.ts` | User list read. |
| `src/commands/attendance.ts` | Attendance log read and identity resolution. |
| `src/ZkDevice.ts` | Public facade. |
| `src/index.ts` | Public exports. |
| `test/emulator/index.ts` | Scriptable device emulator, TCP and UDP. |
| `test/fixtures/oracle/*.json` | Committed byte fixtures. |
| `tools/oracle/` | Capture drivers. Excluded from the published package. |

---

## Task 1: Repository scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.gitattributes`, `LICENSE`, `src/index.ts`, `test/smoke.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm test` and `pnpm typecheck`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "zkteco-protocol",
  "version": "0.1.0",
  "description": "Dependency-free TypeScript client for the ZKTeco binary protocol on port 4370",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE", "PROVENANCE.md"],
  "engines": { "node": ">=20.19" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test", "tools"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Sockets bind real ports; keep suites from racing each other on them.
    pool: 'forks',
    testTimeout: 15_000,
  },
})
```

- [ ] **Step 4: Create `.gitignore` and `.gitattributes`**

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
tools/oracle/.venv/
tools/oracle/__pycache__/
```

`.gitattributes` — this repo compares byte fixtures, so line-ending translation must never touch them:
```
* text=auto eol=lf
*.json -text
test/fixtures/** -text
```

- [ ] **Step 5: Create `LICENSE`**

Standard MIT license text, `Copyright (c) 2026 Chung Nguyen`.

- [ ] **Step 6: Create `src/index.ts` and `test/smoke.spec.ts`**

`src/index.ts`:
```ts
export const VERSION = '0.1.0'
```

`test/smoke.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('toolchain', () => {
  it('runs tests and resolves source imports', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
```

- [ ] **Step 7: Install and verify**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: one passing test, no type errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold package, TypeScript, vitest"
```

---

## Task 2: Checksum

**Files:**
- Create: `src/codec/checksum.ts`
- Test: `test/codec/checksum.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checksum16(payload: Buffer): number` — treats bytes 2–3 (the checksum field) as zero.

- [ ] **Step 1: Write the failing test**

`test/codec/checksum.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { checksum16 } from '../../src/codec/checksum.js'

describe('checksum16', () => {
  it('ignores the checksum field already present in the buffer', () => {
    const a = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const b = Buffer.from([0xe8, 0x03, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00])
    expect(checksum16(a)).toBe(checksum16(b))
  })

  it('returns a value that makes the whole payload sum to 0xffff', () => {
    const p = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const c = checksum16(p)
    const withChecksum = Buffer.from(p)
    withChecksum.writeUInt16LE(c, 2)
    let sum = 0
    for (let i = 0; i < withChecksum.length; i += 2) sum += withChecksum.readUInt16LE(i)
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16)
    expect(sum).toBe(0xffff)
  })

  it('pads a trailing odd byte with zero', () => {
    const odd = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f])
    const padded = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x00])
    expect(checksum16(odd)).toBe(checksum16(padded))
  })

  it('stays within 16 bits', () => {
    const big = Buffer.alloc(64, 0xff)
    big.writeUInt16LE(0, 2)
    expect(checksum16(big)).toBeGreaterThanOrEqual(0)
    expect(checksum16(big)).toBeLessThanOrEqual(0xffff)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/checksum.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/checksum.js`.

- [ ] **Step 3: Write the implementation**

`src/codec/checksum.ts`:
```ts
/**
 * ZKTeco packet checksum: a one's-complement sum over the payload read as
 * 16-bit little-endian words, with the checksum field itself treated as zero
 * and a trailing odd byte padded with zero.
 *
 * Reference implementations in the wild express this by repeatedly subtracting
 * 65535 (not 65536) and then negating. That agrees with the carry-folding form
 * below, which is the standard one's-complement formulation and reads clearly.
 * The behaviour is pinned by oracle fixtures — see the oracle task.
 */
export function checksum16(payload: Buffer): number {
  let sum = 0
  for (let i = 0; i < payload.length; i += 2) {
    // Bytes 2-3 hold the checksum itself and count as zero.
    if (i === 2) continue
    sum += i + 1 < payload.length ? payload.readUInt16LE(i) : (payload[i] as number)
  }
  // Fold the carry back into the low 16 bits.
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16)
  return ~sum & 0xffff
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/checksum.spec.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/codec/checksum.ts test/codec/checksum.spec.ts
git commit -m "feat(codec): carry-folding one's-complement checksum"
```

---

## Task 3: Command constants, packet encoding, and the reply-id quirk

**Files:**
- Create: `src/codec/commands.ts`, `src/codec/packet.ts`, `src/errors.ts`
- Test: `test/codec/packet.spec.ts`

**Interfaces:**
- Consumes: `checksum16` from Task 2.
- Produces:
  - `CMD` — a frozen record of command numbers.
  - `encodePayload(fields: PacketFields): Buffer`
  - `decodePayload(buf: Buffer): DecodedPacket`
  - `applyReplyIdQuirk(payload: Buffer, wireReplyId: number): Buffer`
  - `interface PacketFields { command: number; sessionId: number; replyId: number; data?: Buffer }`
  - `interface DecodedPacket { command: number; checksum: number; sessionId: number; replyId: number; data: Buffer }`
  - Error classes `ZkError`, `ZkConnectionError`, `ZkTimeoutError`, `ZkAuthError`, `ZkProtocolError`, `ZkFramingError`.

- [ ] **Step 1: Create `src/errors.ts`**

```ts
export class ZkError extends Error {
  /** Hex of the bytes that caused this error, when any exist. */
  readonly raw?: string

  constructor(message: string, raw?: Buffer) {
    super(message)
    this.name = new.target.name
    if (raw) this.raw = raw.toString('hex')
  }
}

/** Socket refused, closed, or unreachable. */
export class ZkConnectionError extends ZkError {}

/** The device stayed silent past the deadline. */
export class ZkTimeoutError extends ZkError {}

/** The comm key was rejected. */
export class ZkAuthError extends ZkError {}

/** The device replied with an error code, or a malformed packet arrived. */
export class ZkProtocolError extends ZkError {}

/**
 * Record framing failed validation. Deliberately its own class rather than a
 * ZkProtocolError subtype: callers must be able to tell "the device reported a
 * failure" apart from "these bytes may be misaligned, trust nothing parsed
 * from them".
 */
export class ZkFramingError extends ZkError {}
```

- [ ] **Step 2: Create `src/codec/commands.ts`**

```ts
export const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLEDEVICE: 1002,
  DISABLEDEVICE: 1003,
  AUTH: 1102,
  GET_FREE_SIZES: 50,
  ATTLOG_RRQ: 13,
  USERTEMP_RRQ: 9,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  PREPARE_BUFFER: 1503,
  READ_BUFFER: 1504,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_UNAUTH: 2005,
} as const

/** Maximum bytes requested per chunk, per transport. */
export const MAX_CHUNK = { tcp: 0xffc0, udp: 16 * 1024 } as const
```

- [ ] **Step 3: Write the failing test**

`test/codec/packet.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { applyReplyIdQuirk, decodePayload, encodePayload } from '../../src/codec/packet.js'
import { checksum16 } from '../../src/codec/checksum.js'
import { ZkProtocolError } from '../../src/errors.js'

describe('encodePayload', () => {
  it('lays out command, checksum, sessionId, replyId, data', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0x1234, replyId: 7 })
    expect(p.length).toBe(8)
    expect(p.readUInt16LE(0)).toBe(1000)
    expect(p.readUInt16LE(4)).toBe(0x1234)
    expect(p.readUInt16LE(6)).toBe(7)
  })

  it('appends data after the 8-byte header', () => {
    const data = Buffer.from([1, 2, 3])
    const p = encodePayload({ command: CMD.AUTH, sessionId: 1, replyId: 1, data })
    expect(p.length).toBe(11)
    expect(p.subarray(8)).toEqual(data)
  })

  it('writes a checksum that validates against the payload', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })
    expect(p.readUInt16LE(2)).toBe(checksum16(p))
  })
})

describe('decodePayload', () => {
  it('round-trips what encodePayload produced', () => {
    const data = Buffer.from([9, 9])
    const p = encodePayload({ command: CMD.ATTLOG_RRQ, sessionId: 42, replyId: 3, data })
    const d = decodePayload(p)
    expect(d).toMatchObject({ command: CMD.ATTLOG_RRQ, sessionId: 42, replyId: 3 })
    expect(d.data).toEqual(data)
  })

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodePayload(Buffer.from([1, 2, 3]))).toThrow(ZkProtocolError)
  })
})

describe('applyReplyIdQuirk', () => {
  it('overwrites the reply id on the wire', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    const wire = applyReplyIdQuirk(p, 5)
    expect(wire.readUInt16LE(6)).toBe(5)
  })

  it('leaves the checksum computed over the OLD reply id — this is deliberate', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    const wire = applyReplyIdQuirk(p, 5)
    expect(wire.readUInt16LE(2)).toBe(p.readUInt16LE(2))
    // The transmitted packet's checksum therefore does NOT match its contents.
    expect(wire.readUInt16LE(2)).not.toBe(checksum16(wire))
  })

  it('does not mutate its input', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 4 })
    applyReplyIdQuirk(p, 5)
    expect(p.readUInt16LE(6)).toBe(4)
  })

  it('wraps the reply id at 16 bits', () => {
    const p = encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0xffff })
    expect(applyReplyIdQuirk(p, 0x10000).readUInt16LE(6)).toBe(0)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/packet.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/packet.js`.

- [ ] **Step 5: Write the implementation**

`src/codec/packet.ts`:
```ts
import { checksum16 } from './checksum.js'
import { ZkProtocolError } from '../errors.js'

const HEADER_SIZE = 8
const EMPTY = Buffer.alloc(0)

export interface PacketFields {
  command: number
  sessionId: number
  replyId: number
  data?: Buffer
}

export interface DecodedPacket {
  command: number
  checksum: number
  sessionId: number
  replyId: number
  data: Buffer
}

/** Builds a payload whose checksum is computed correctly over THIS reply id. */
export function encodePayload({ command, sessionId, replyId, data = EMPTY }: PacketFields): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + data.length)
  buf.writeUInt16LE(command & 0xffff, 0)
  buf.writeUInt16LE(0, 2)
  buf.writeUInt16LE(sessionId & 0xffff, 4)
  buf.writeUInt16LE(replyId & 0xffff, 6)
  data.copy(buf, HEADER_SIZE)
  buf.writeUInt16LE(checksum16(buf), 2)
  return buf
}

export function decodePayload(buf: Buffer): DecodedPacket {
  if (buf.length < HEADER_SIZE) {
    throw new ZkProtocolError(`payload shorter than the ${HEADER_SIZE}-byte header`, buf)
  }
  return {
    command: buf.readUInt16LE(0),
    checksum: buf.readUInt16LE(2),
    sessionId: buf.readUInt16LE(4),
    replyId: buf.readUInt16LE(6),
    data: Buffer.from(buf.subarray(HEADER_SIZE)),
  }
}

/**
 * Overwrites the reply-id field on an already-encoded payload and does NOT
 * recompute the checksum. The transmitted packet therefore carries a checksum
 * that disagrees with its own contents.
 *
 * This looks like a defect and is not treated as one: implementations behaving
 * this way have worked against real hardware for years, so it appears to be
 * what devices expect. This function exists precisely so the behaviour cannot
 * be invisible — do not "fix" it by calling encodePayload again.
 */
export function applyReplyIdQuirk(payload: Buffer, wireReplyId: number): Buffer {
  const out = Buffer.from(payload)
  out.writeUInt16LE(wireReplyId & 0xffff, 6)
  return out
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/packet.spec.ts && pnpm typecheck`
Expected: 9 passing, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/codec/commands.ts src/codec/packet.ts src/errors.ts test/codec/packet.spec.ts
git commit -m "feat(codec): packet encoding, command table, reply-id quirk"
```

---

## Task 4: TCP framing

**Files:**
- Create: `src/codec/framing.ts`
- Test: `test/codec/framing.spec.ts`

**Interfaces:**
- Consumes: `ZkProtocolError` from Task 3.
- Produces:
  - `START_MARKER: Buffer` — the 4 bytes `50 50 82 7d` as they appear on the wire.
  - `frameTcp(payload: Buffer): Buffer`
  - `tryUnframeTcp(buf: Buffer): { payload: Buffer; consumed: number } | null` — returns `null` when more bytes are needed.

- [ ] **Step 1: Write the failing test**

`test/codec/framing.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { START_MARKER, frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import { ZkProtocolError } from '../../src/errors.js'

const payload = Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

describe('frameTcp', () => {
  it('prepends the start marker and a little-endian length', () => {
    const framed = frameTcp(payload)
    expect(framed.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
    expect(framed.readUInt32LE(4)).toBe(payload.length)
    expect(framed.subarray(8)).toEqual(payload)
  })

  it('exports the marker it writes', () => {
    expect(START_MARKER).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
  })
})

describe('tryUnframeTcp', () => {
  it('recovers the payload and reports how many bytes it consumed', () => {
    const r = tryUnframeTcp(frameTcp(payload))
    expect(r?.payload).toEqual(payload)
    expect(r?.consumed).toBe(8 + payload.length)
  })

  it('returns null when the header is incomplete', () => {
    expect(tryUnframeTcp(Buffer.from([0x50, 0x50, 0x82]))).toBeNull()
  })

  it('returns null when the body has not fully arrived', () => {
    const framed = frameTcp(payload)
    expect(tryUnframeTcp(framed.subarray(0, 10))).toBeNull()
  })

  it('leaves trailing bytes of the next packet alone', () => {
    const two = Buffer.concat([frameTcp(payload), frameTcp(payload)])
    const first = tryUnframeTcp(two)
    expect(first?.consumed).toBe(8 + payload.length)
    const second = tryUnframeTcp(two.subarray(first!.consumed))
    expect(second?.payload).toEqual(payload)
  })

  it('throws when the start marker does not match', () => {
    const bad = frameTcp(payload)
    bad.writeUInt8(0x51, 0)
    expect(() => tryUnframeTcp(bad)).toThrow(ZkProtocolError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/framing.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/framing.js`.

- [ ] **Step 3: Write the implementation**

`src/codec/framing.ts`:
```ts
import { ZkProtocolError } from '../errors.js'

/**
 * The 4 bytes that open every TCP packet, in wire order.
 *
 * Some reference implementations carry a source comment naming this 0x7282
 * while their own constant holds 32130 = 0x7D82. Trust the value, not the
 * comment: on the wire the bytes are 50 50 82 7D.
 */
export const START_MARKER = Buffer.from([0x50, 0x50, 0x82, 0x7d])

const TCP_PREFIX_SIZE = 8

/** Wraps a payload for TCP. UDP sends the bare payload and never calls this. */
export function frameTcp(payload: Buffer): Buffer {
  const head = Buffer.alloc(TCP_PREFIX_SIZE)
  START_MARKER.copy(head, 0)
  head.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/**
 * Attempts to read one framed packet from the front of an accumulating buffer.
 * Returns null when more bytes are still needed — TCP splits and coalesces
 * freely, so a caller must be able to wait rather than fail.
 */
export function tryUnframeTcp(buf: Buffer): { payload: Buffer; consumed: number } | null {
  if (buf.length < TCP_PREFIX_SIZE) return null
  if (!buf.subarray(0, 4).equals(START_MARKER)) {
    throw new ZkProtocolError('TCP start marker mismatch', buf.subarray(0, 8))
  }
  const size = buf.readUInt32LE(4)
  if (buf.length < TCP_PREFIX_SIZE + size) return null
  return {
    payload: Buffer.from(buf.subarray(TCP_PREFIX_SIZE, TCP_PREFIX_SIZE + size)),
    consumed: TCP_PREFIX_SIZE + size,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/framing.spec.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/codec/framing.ts test/codec/framing.spec.ts
git commit -m "feat(codec): TCP start marker and length-prefixed framing"
```

---

## Task 5: Comm-key mixing

**Files:**
- Create: `src/codec/commkey.ts`
- Test: `test/codec/commkey.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mixCommKey(commKey: number, sessionId: number, ticks?: number): Buffer` — always 4 bytes.

Implement from the functional description in spec §A.4. Do not transcribe anyone's code.

- [ ] **Step 1: Write the failing test**

`test/codec/commkey.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mixCommKey } from '../../src/codec/commkey.js'

describe('mixCommKey', () => {
  it('always produces 4 bytes', () => {
    expect(mixCommKey(0, 0)).toHaveLength(4)
    expect(mixCommKey(123456, 0xabcd)).toHaveLength(4)
  })

  it('is deterministic', () => {
    expect(mixCommKey(1234, 42)).toEqual(mixCommKey(1234, 42))
  })

  it('depends on the session id', () => {
    expect(mixCommKey(1234, 1)).not.toEqual(mixCommKey(1234, 2))
  })

  it('depends on the key', () => {
    expect(mixCommKey(1234, 7)).not.toEqual(mixCommKey(5678, 7))
  })

  it('assigns byte 2 directly from the tick byte rather than XORing it', () => {
    // Spec §A.4: bytes 0, 1 and 3 are XORed with B; byte 2 is ASSIGNED B.
    // With the default ticks of 50, byte 2 is therefore always 50.
    for (const key of [0, 1, 999, 123456, 0xffffffff]) {
      expect(mixCommKey(key, 3)[2]).toBe(50)
    }
    expect(mixCommKey(1234, 3, 77)[2]).toBe(77)
  })

  it('handles a key with the top bit set without going negative', () => {
    const out = mixCommKey(0xffffffff, 1)
    for (const byte of out) expect(byte).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/commkey.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/commkey.js`.

- [ ] **Step 3: Write the implementation**

`src/codec/commkey.ts`:
```ts
const XOR_TAG = [0x5a, 0x4b, 0x53, 0x4f] as const // 'Z', 'K', 'S', 'O'
const DEFAULT_TICKS = 50

/**
 * Mixes the device comm key with the session id into the 4 bytes CMD_AUTH
 * carries.
 *
 * Steps, per the protocol description:
 *   1. Reverse the 32-bit order of the key.
 *   2. Add the session id.
 *   3. Pack little-endian and XOR the bytes with 'Z', 'K', 'S', 'O'.
 *   4. Swap the two 16-bit halves.
 *   5. XOR bytes 0, 1 and 3 with the low byte of `ticks`; ASSIGN byte 2 that
 *      same value. Byte 2 is not XORed. That reads like a typo and is not one.
 *
 * Written from a prose description of the algorithm, never transcribed from a
 * GPL implementation. Pinned by oracle fixtures.
 */
export function mixCommKey(commKey: number, sessionId: number, ticks = DEFAULT_TICKS): Buffer {
  // 1. Reverse the bit order: input bit 0 becomes output bit 31.
  let k = 0
  for (let i = 0; i < 32; i++) {
    k = ((k << 1) | ((commKey >>> i) & 1)) >>> 0
  }

  // 2. Add the session id.
  k = (k + (sessionId >>> 0)) >>> 0

  // 3. Pack little-endian, then XOR with the tag characters.
  const packed = Buffer.alloc(4)
  packed.writeUInt32LE(k, 0)
  for (let i = 0; i < 4; i++) {
    packed[i] = (packed[i] as number) ^ (XOR_TAG[i] as number)
  }

  // 4. Swap the two 16-bit halves.
  const out = Buffer.from([packed[2] as number, packed[3] as number, packed[0] as number, packed[1] as number])

  // 5. Apply the tick byte. Byte 2 is assigned, not XORed.
  const b = ticks & 0xff
  out[0] = (out[0] as number) ^ b
  out[1] = (out[1] as number) ^ b
  out[2] = b
  out[3] = (out[3] as number) ^ b

  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/commkey.spec.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/codec/commkey.ts test/codec/commkey.spec.ts
git commit -m "feat(codec): comm-key mixing for CMD_AUTH"
```

---

## Task 6: Time decoding

**Files:**
- Create: `src/types.ts`, `src/codec/time.ts`
- Test: `test/codec/time.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ZkNaiveTime { readonly year, month, day, hour, minute, second: number; readonly local: string }`
  - `decodeZkTime(t: number): ZkNaiveTime` — the packed uint32 form.
  - `decodeZkTime6(buf: Buffer, offset?: number): ZkNaiveTime` — the 6-byte form.

- [ ] **Step 1: Create `src/types.ts` with the time type only**

Later tasks extend this file.

```ts
/**
 * A wall-clock reading with NO timezone and NO offset, exactly as the device
 * recorded it.
 *
 * The library never returns a JavaScript `Date`. A `Date` would silently bind
 * this reading to the timezone of whatever process decoded it: correct by
 * accident on a machine in the same zone as the device, hours wrong in CI, and
 * nothing anywhere reports an error. Apply a timezone yourself, deliberately.
 */
export interface ZkNaiveTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** "2026-08-27T08:01:00" — deliberately carries no offset. */
  readonly local: string
}
```

- [ ] **Step 2: Write the failing test**

`test/codec/time.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decodeZkTime, decodeZkTime6 } from '../../src/codec/time.js'

describe('decodeZkTime', () => {
  it('decodes zero as the post-power-loss reset value', () => {
    expect(decodeZkTime(0)).toMatchObject({
      year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0,
      local: '2000-01-01T00:00:00',
    })
  })

  it('unpacks seconds, minutes and hours', () => {
    // 1 hour, 2 minutes, 3 seconds into 2000-01-01.
    expect(decodeZkTime(3600 + 120 + 3)).toMatchObject({
      year: 2000, month: 1, day: 1, hour: 1, minute: 2, second: 3,
    })
  })

  it('treats a month as exactly 31 days', () => {
    const t = 30 * 86_400 // day index 30 -> the 31st
    expect(decodeZkTime(t)).toMatchObject({ month: 1, day: 31 })
    expect(decodeZkTime(t + 86_400)).toMatchObject({ month: 2, day: 1 })
  })

  it('treats a year as exactly 12 pseudo-months', () => {
    const month = 31 * 86_400
    expect(decodeZkTime(11 * month)).toMatchObject({ year: 2000, month: 12, day: 1 })
    expect(decodeZkTime(12 * month)).toMatchObject({ year: 2001, month: 1, day: 1 })
  })

  it('can produce a date that does not exist, and does not correct it', () => {
    // February 31st is representable in the packed pseudo-calendar. The device
    // packs it, so the library returns it. A Date would silently slide it to
    // March 3rd; that is the failure this type exists to prevent.
    const t = 31 * 86_400 + 30 * 86_400 // month index 1, day index 30
    const decoded = decodeZkTime(t)
    expect(decoded).toMatchObject({ month: 2, day: 31 })
    expect(decoded.local).toBe('2000-02-31T00:00:00')
  })

  it('zero-pads every field in `local`', () => {
    expect(decodeZkTime(0).local).toBe('2000-01-01T00:00:00')
    expect(decodeZkTime(9 * 3600 + 5 * 60 + 7).local).toBe('2000-01-01T09:05:07')
  })

  it('handles the full uint32 range without going negative', () => {
    const decoded = decodeZkTime(0xffffffff)
    expect(decoded.year).toBeGreaterThan(2000)
    expect(decoded.month).toBeGreaterThanOrEqual(1)
    expect(decoded.day).toBeGreaterThanOrEqual(1)
  })
})

describe('decodeZkTime6', () => {
  it('reads the year-2000, month, day, hour, minute, second form', () => {
    const buf = Buffer.from([26, 8, 27, 8, 1, 0])
    expect(decodeZkTime6(buf)).toMatchObject({
      year: 2026, month: 8, day: 27, hour: 8, minute: 1, second: 0,
      local: '2026-08-27T08:01:00',
    })
  })

  it('reads from an offset', () => {
    const buf = Buffer.from([0xff, 0xff, 26, 8, 27, 8, 1, 0])
    expect(decodeZkTime6(buf, 2).local).toBe('2026-08-27T08:01:00')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/time.spec.ts`
Expected: FAIL — cannot resolve `../../src/codec/time.js`.

- [ ] **Step 4: Write the implementation**

`src/codec/time.ts`:
```ts
import type { ZkNaiveTime } from '../types.js'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function make(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
): ZkNaiveTime {
  return {
    year, month, day, hour, minute, second,
    local:
      `${pad(year, 4)}-${pad(month)}-${pad(day)}` +
      `T${pad(hour)}:${pad(minute)}:${pad(second)}`,
  }
}

/**
 * Unpacks the 4-byte device timestamp.
 *
 * The device packs time through a pseudo-calendar of 31-day months and
 * 12-month years, not a real one. A consequence worth knowing: this can
 * legitimately yield 2026-02-31. That is not corrected, filtered, or rejected
 * here — the device packed it, so the caller sees it, alongside the raw bytes.
 */
export function decodeZkTime(t: number): ZkNaiveTime {
  let v = t >>> 0
  const second = v % 60; v = Math.floor(v / 60)
  const minute = v % 60; v = Math.floor(v / 60)
  const hour = v % 24; v = Math.floor(v / 24)
  const day = (v % 31) + 1; v = Math.floor(v / 31)
  const month = (v % 12) + 1; v = Math.floor(v / 12)
  return make(v + 2000, month, day, hour, minute, second)
}

/**
 * Unpacks the 6-byte form used elsewhere in the protocol: one byte each for
 * year-2000, month, day, hour, minute, second. Do not confuse it with the
 * packed uint32 form above.
 */
export function decodeZkTime6(buf: Buffer, offset = 0): ZkNaiveTime {
  return make(
    2000 + (buf[offset] as number),
    buf[offset + 1] as number,
    buf[offset + 2] as number,
    buf[offset + 3] as number,
    buf[offset + 4] as number,
    buf[offset + 5] as number,
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/time.spec.ts && pnpm typecheck`
Expected: 9 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/codec/time.ts test/codec/time.spec.ts
git commit -m "feat(codec): naive-time decoding for both device time formats"
```

---

## Task 7: Attendance record decoding and the framing guards

**Files:**
- Create: `src/codec/records/attendance.ts`
- Modify: `src/types.ts` (append `ZkAttendanceLog`)
- Test: `test/codec/records/attendance.spec.ts`

**Interfaces:**
- Consumes: `decodeZkTime` (Task 6), `ZkFramingError` (Task 3).
- Produces:
  - `interface DecodedAttendanceRecord { uid: number | null; userIdFromRecord: string | null; numericUserId: number | null; timestamp: ZkNaiveTime; status: number; verifyMode: number; recordSize: 8 | 16 | 40; raw: string }`
  - `detectRecordSize(bodyLength: number, recordCount: number): 8 | 16 | 40`
  - `parseAttendanceData(data: Buffer, recordCount: number): DecodedAttendanceRecord[]`
  - `mapStatusAndVerify(recordStatus: number, recordPunch: number): { status: number; verifyMode: number }`
  - `interface ZkAttendanceLog` appended to `src/types.ts`.

This task carries the library's most important guard. Read spec §5.3 before starting.

- [ ] **Step 1: Append `ZkAttendanceLog` to `src/types.ts`**

```ts
/** One badge event, exactly as the device reported it. */
export interface ZkAttendanceLog {
  /**
   * The identifier printed on the device. `null` when the device did not send
   * it and no lookup matched. Never fabricated — a null beats a wrong name.
   */
  userId: string | null

  /**
   * Where `userId` came from:
   *   'device' — sent verbatim in the record (40-byte dialect). Trustworthy.
   *   'lookup' — resolved through the user list. MAY BE WRONG: device-internal
   *              uids are recycled after a user is deleted, so a punch by the
   *              previous holder resolves against the current table and is
   *              attributed to the wrong person, with no error anywhere.
   *   null     — could not be determined.
   */
  userIdSource: 'device' | 'lookup' | null

  /** Device-internal key. Recycled after a user is deleted — NOT an identity. */
  uid: number | null

  timestamp: ZkNaiveTime

  /** Raw status code. Meaning VARIES BY MODEL — deliberately not decoded. */
  status: number

  /** Raw verification method. Also model-dependent, also not decoded. */
  verifyMode: number

  /** Which dialect this record was decoded from. */
  recordSize: 8 | 16 | 40

  /** Hex of the original record bytes, for reconciliation. */
  raw: string
}
```

- [ ] **Step 2: Write the failing test**

`test/codec/records/attendance.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  detectRecordSize,
  parseAttendanceData,
} from '../../../src/codec/records/attendance.js'
import { ZkFramingError } from '../../../src/errors.js'

/** Builds one 40-byte record. */
function rec40(uid: number, userId: string, status: number, t: number, punch: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt8(status, 26)
  b.writeUInt32LE(t, 27)
  b.writeUInt8(punch, 31)
  return b
}

function rec16(userId: number, t: number, status: number, punch: number, workcode = 0): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(userId, 0)
  b.writeUInt32LE(t, 4)
  b.writeUInt8(status, 8)
  b.writeUInt8(punch, 9)
  b.writeUInt32LE(workcode, 12)
  return b
}

function rec8(uid: number, status: number, t: number, punch: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  b.writeUInt8(status, 2)
  b.writeUInt32LE(t, 3)
  b.writeUInt8(punch, 7)
  return b
}

/** Wraps records in the 4-byte totalSize header the device sends. */
function withHeader(...records: Buffer[]): Buffer {
  const body = Buffer.concat(records)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

describe('detectRecordSize', () => {
  it('accepts the three known dialects', () => {
    expect(detectRecordSize(80, 10)).toBe(8)
    expect(detectRecordSize(160, 10)).toBe(16)
    expect(detectRecordSize(400, 10)).toBe(40)
  })

  it('throws when the length does not divide evenly', () => {
    expect(() => detectRecordSize(81, 10)).toThrow(ZkFramingError)
  })

  it('throws on a quotient that is not a known record size', () => {
    expect(() => detectRecordSize(240, 10)).toThrow(ZkFramingError)
  })

  it('throws on a non-positive record count', () => {
    expect(() => detectRecordSize(80, 0)).toThrow(ZkFramingError)
    expect(() => detectRecordSize(80, -1)).toThrow(ZkFramingError)
  })
})

describe('parseAttendanceData', () => {
  it('decodes a 40-byte record including the printed user id', () => {
    const data = withHeader(rec40(5, '000123', 1, 0, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: 5,
      userIdFromRecord: '000123',
      numericUserId: null,
      recordSize: 40,
    })
    expect(r!.timestamp.local).toBe('2000-01-01T00:00:00')
  })

  it('preserves leading zeros in the printed user id', () => {
    const data = withHeader(rec40(1, '007', 0, 0, 0))
    expect(parseAttendanceData(data, 1)[0]!.userIdFromRecord).toBe('007')
  })

  it('decodes a 16-byte record with no printed user id', () => {
    const data = withHeader(rec16(123, 0, 1, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: null,
      userIdFromRecord: null,
      numericUserId: 123,
      recordSize: 16,
    })
  })

  it('decodes an 8-byte record carrying only a uid', () => {
    const data = withHeader(rec8(9, 1, 0, 2))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({
      uid: 9,
      userIdFromRecord: null,
      numericUserId: null,
      recordSize: 8,
    })
  })

  it('decodes several records of the same dialect', () => {
    const data = withHeader(rec8(1, 0, 0, 0), rec8(2, 0, 0, 0), rec8(3, 0, 0, 0))
    expect(parseAttendanceData(data, 3).map((r) => r.uid)).toEqual([1, 2, 3])
  })

  it('attaches the raw hex of each record', () => {
    const one = rec8(1, 2, 3, 4)
    const [r] = parseAttendanceData(withHeader(one), 1)
    expect(r!.raw).toBe(one.toString('hex'))
  })

  it('skips a junk prefix on the 40-byte dialect', () => {
    const junk = Buffer.from([0xff, 0x32, 0x35, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00])
    const data = withHeader(junk, rec40(7, 'A1', 0, 0, 0))
    const [r] = parseAttendanceData(data, 1)
    expect(r).toMatchObject({ uid: 7, userIdFromRecord: 'A1', recordSize: 40 })
  })

  it('THROWS rather than parsing when the body does not divide evenly', () => {
    const data = withHeader(rec8(1, 0, 0, 0), rec8(2, 0, 0, 0))
    // The device claimed 3 records; the body holds 2. The quotient would be
    // garbage and a parse loop would happily emit misaligned records.
    expect(() => parseAttendanceData(data, 3)).toThrow(ZkFramingError)
  })

  it('throws when the buffer is shorter than the declared totalSize', () => {
    const data = withHeader(rec8(1, 0, 0, 0))
    expect(() => parseAttendanceData(data.subarray(0, 8), 1)).toThrow(ZkFramingError)
  })

  it('throws when the buffer is too short to hold the header', () => {
    expect(() => parseAttendanceData(Buffer.from([1, 2]), 1)).toThrow(ZkFramingError)
  })

  it('returns an empty array for a zero record count without inspecting the body', () => {
    expect(parseAttendanceData(withHeader(), 0)).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/records/attendance.spec.ts`
Expected: FAIL — cannot resolve `attendance.js`.

- [ ] **Step 4: Write the implementation**

`src/codec/records/attendance.ts`:
```ts
import { ZkFramingError } from '../../errors.js'
import { decodeZkTime } from '../time.js'
import type { ZkNaiveTime } from '../../types.js'

const KNOWN_SIZES = [8, 16, 40] as const
export type RecordSize = (typeof KNOWN_SIZES)[number]

/**
 * A junk prefix observed at the head of some 40-byte payloads. Documented
 * device behaviour, not evidence of corruption, so it is skipped rather than
 * thrown on. Its exact relationship to the declared totalSize is unverified
 * until real hardware is available — the guards below run on the body AFTER
 * this prefix is removed.
 */
const JUNK_PREFIX = Buffer.from([0xff, 0x32, 0x35, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00])

export interface DecodedAttendanceRecord {
  uid: number | null
  userIdFromRecord: string | null
  numericUserId: number | null
  timestamp: ZkNaiveTime
  status: number
  verifyMode: number
  recordSize: RecordSize
  raw: string
}

/**
 * Maps the two model-dependent bytes a record carries onto the two the public
 * API exposes.
 *
 * HYPOTHESIS. The record layouts name their fields `status` and `punch`; the
 * public API exposes `status` (in/out) and `verifyMode` (finger/card/face/
 * password). Which feeds which is not settled by the available documentation,
 * so the name-preserving mapping is assumed here and isolated in this one
 * function. The oracle task decodes identical record bytes with two
 * independent implementations and adopts their mapping only if they agree; if
 * they disagree, the divergence is recorded and left for first-hardware
 * verification. Change this function, and nothing else, when that resolves.
 */
export function mapStatusAndVerify(
  recordStatus: number,
  recordPunch: number,
): { status: number; verifyMode: number } {
  return { status: recordStatus, verifyMode: recordPunch }
}

/**
 * Derives the record size by division, and refuses to guess.
 *
 * If `recordCount` is even slightly stale — somebody badged between the
 * counter read and the buffer read — the quotient is garbage and a parse loop
 * would still run, emitting misaligned records with meaningless identifiers
 * and nonsense timestamps, raising nothing. No data is better than wrong data.
 */
export function detectRecordSize(bodyLength: number, recordCount: number): RecordSize {
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new ZkFramingError(`record count must be a positive integer, got ${recordCount}`)
  }
  if (bodyLength % recordCount !== 0) {
    throw new ZkFramingError(
      `record body of ${bodyLength} bytes does not divide evenly by ${recordCount} records`,
    )
  }
  const size = bodyLength / recordCount
  if (!KNOWN_SIZES.includes(size as RecordSize)) {
    throw new ZkFramingError(
      `derived record size ${size} is not one of ${KNOWN_SIZES.join(', ')}`,
    )
  }
  return size as RecordSize
}

function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('ascii')
}

function decodeOne(rec: Buffer, size: RecordSize): DecodedAttendanceRecord {
  const raw = rec.toString('hex')
  if (size === 40) {
    const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(26), rec.readUInt8(31))
    return {
      uid: rec.readUInt16LE(0),
      userIdFromRecord: readNulTerminated(rec, 2, 24),
      numericUserId: null,
      timestamp: decodeZkTime(rec.readUInt32LE(27)),
      status,
      verifyMode,
      recordSize: 40,
      raw,
    }
  }
  if (size === 16) {
    const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(8), rec.readUInt8(9))
    return {
      uid: null,
      userIdFromRecord: null,
      // Rendering this as a string would strip leading zeros and lose the
      // identity. Resolve it through the user list instead.
      numericUserId: rec.readUInt32LE(0),
      timestamp: decodeZkTime(rec.readUInt32LE(4)),
      status,
      verifyMode,
      recordSize: 16,
      raw,
    }
  }
  const { status, verifyMode } = mapStatusAndVerify(rec.readUInt8(2), rec.readUInt8(7))
  return {
    uid: rec.readUInt16LE(0),
    userIdFromRecord: null,
    numericUserId: null,
    timestamp: decodeZkTime(rec.readUInt32LE(3)),
    status,
    verifyMode,
    recordSize: 8,
    raw,
  }
}

/**
 * Decodes a complete attendance payload: a 4-byte little-endian totalSize
 * followed by fixed-width records.
 */
export function parseAttendanceData(
  data: Buffer,
  recordCount: number,
): DecodedAttendanceRecord[] {
  if (recordCount === 0) return []
  if (data.length < 4) {
    throw new ZkFramingError('attendance payload too short to hold its size header', data)
  }
  const totalSize = data.readUInt32LE(0)
  if (data.length < 4 + totalSize) {
    throw new ZkFramingError(
      `attendance payload declares ${totalSize} bytes but only ${data.length - 4} arrived`,
      data.subarray(0, 16),
    )
  }

  let body = data.subarray(4, 4 + totalSize)
  if (body.subarray(0, JUNK_PREFIX.length).equals(JUNK_PREFIX)) {
    body = body.subarray(JUNK_PREFIX.length)
  }

  const size = detectRecordSize(body.length, recordCount)
  const out: DecodedAttendanceRecord[] = []
  for (let off = 0; off + size <= body.length; off += size) {
    out.push(decodeOne(body.subarray(off, off + size), size))
  }
  return out
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/records/attendance.spec.ts && pnpm typecheck`
Expected: 16 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/codec/records/attendance.ts src/types.ts test/codec/records/attendance.spec.ts
git commit -m "feat(codec): attendance record decoding with fail-loud framing guards"
```

---

## Task 8: User record decoding

**Files:**
- Create: `src/codec/records/user.ts`
- Modify: `src/types.ts` (append `ZkUser`)
- Test: `test/codec/records/user.spec.ts`

**Interfaces:**
- Consumes: `ZkFramingError` (Task 3).
- Produces:
  - `interface ZkUser { uid: number; userId: string; name: string; privilege: number; hasPassword: boolean; cardNumber: number; raw: string }` in `src/types.ts`
  - `parseUserData(data: Buffer): ZkUser[]`
  - `USER_RECORD_SIZE = 72`

The user record is 72 bytes: `uid` u16, `privilege` u8, `password` 8 bytes NUL-terminated, `name` 24 bytes NUL-terminated, `cardNumber` u32, 1 reserved byte, `group` u32, `timezone` u16, `userId` 8 bytes NUL-terminated, remaining bytes padding.

- [ ] **Step 1: Append `ZkUser` to `src/types.ts`**

```ts
/** One enrolled user, as the device stores them. */
export interface ZkUser {
  /** Device-internal key. Recycled after deletion — NOT an identity. */
  uid: number
  /** The identifier printed on the device. A string, so leading zeros survive. */
  userId: string
  name: string
  /** Raw privilege level. Model-dependent, deliberately not decoded. */
  privilege: number
  /** True when a password is set. The password itself is never returned. */
  hasPassword: boolean
  /** Raw card number, 0 when unset. */
  cardNumber: number
  /** Hex of the original record bytes. */
  raw: string
}
```

- [ ] **Step 2: Write the failing test**

`test/codec/records/user.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { USER_RECORD_SIZE, parseUserData } from '../../../src/codec/records/user.js'
import { ZkFramingError } from '../../../src/errors.js'

function userRec(
  uid: number, userId: string, name: string,
  opts: { privilege?: number; password?: string; card?: number } = {},
): Buffer {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.writeUInt8(opts.privilege ?? 0, 2)
  if (opts.password) b.write(opts.password, 3, 8, 'ascii')
  b.write(name, 11, 24, 'ascii')
  b.writeUInt32LE(opts.card ?? 0, 35)
  b.write(userId, 48, 8, 'ascii')
  return b
}

function withHeader(...records: Buffer[]): Buffer {
  const body = Buffer.concat(records)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

describe('parseUserData', () => {
  it('decodes uid, printed id and name', () => {
    const [u] = parseUserData(withHeader(userRec(5, '000123', 'Alice')))
    expect(u).toMatchObject({ uid: 5, userId: '000123', name: 'Alice' })
  })

  it('preserves leading zeros in the printed id', () => {
    expect(parseUserData(withHeader(userRec(1, '007', 'Bob')))[0]!.userId).toBe('007')
  })

  it('reports whether a password is set without returning it', () => {
    const withPw = parseUserData(withHeader(userRec(1, '1', 'A', { password: 'secret' })))[0]!
    const withoutPw = parseUserData(withHeader(userRec(2, '2', 'B')))[0]!
    expect(withPw.hasPassword).toBe(true)
    expect(withoutPw.hasPassword).toBe(false)
    expect(JSON.stringify(withPw)).not.toContain('secret')
  })

  it('decodes privilege and card number as raw numbers', () => {
    const [u] = parseUserData(withHeader(userRec(1, '1', 'A', { privilege: 14, card: 987 })))
    expect(u).toMatchObject({ privilege: 14, cardNumber: 987 })
  })

  it('decodes several users', () => {
    const data = withHeader(userRec(1, '1', 'A'), userRec(2, '2', 'B'), userRec(3, '3', 'C'))
    expect(parseUserData(data).map((u) => u.uid)).toEqual([1, 2, 3])
  })

  it('attaches raw hex per record', () => {
    const one = userRec(1, '1', 'A')
    expect(parseUserData(withHeader(one))[0]!.raw).toBe(one.toString('hex'))
  })

  it('returns an empty array for an empty body', () => {
    expect(parseUserData(withHeader())).toEqual([])
  })

  it('throws when the body is not a whole number of records', () => {
    const data = withHeader(userRec(1, '1', 'A').subarray(0, 40))
    expect(() => parseUserData(data)).toThrow(ZkFramingError)
  })

  it('throws when the declared size exceeds what arrived', () => {
    const data = withHeader(userRec(1, '1', 'A'))
    expect(() => parseUserData(data.subarray(0, 20))).toThrow(ZkFramingError)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/codec/records/user.spec.ts`
Expected: FAIL — cannot resolve `user.js`.

- [ ] **Step 4: Write the implementation**

`src/codec/records/user.ts`:
```ts
import { ZkFramingError } from '../../errors.js'
import type { ZkUser } from '../../types.js'

export const USER_RECORD_SIZE = 72

function readNulTerminated(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('ascii')
}

function decodeOne(rec: Buffer): ZkUser {
  return {
    uid: rec.readUInt16LE(0),
    privilege: rec.readUInt8(2),
    // Whether a password exists is useful; the password itself is never
    // surfaced, so it cannot leak into a log or an upstream payload.
    hasPassword: readNulTerminated(rec, 3, 8).length > 0,
    name: readNulTerminated(rec, 11, 24),
    cardNumber: rec.readUInt32LE(35),
    userId: readNulTerminated(rec, 48, 8),
    raw: rec.toString('hex'),
  }
}

/**
 * Decodes a user-list payload: a 4-byte little-endian totalSize followed by
 * fixed-width 72-byte records. Applies the same fail-loud policy as the
 * attendance parser — a body that is not a whole number of records is refused
 * rather than parsed into misaligned garbage.
 */
export function parseUserData(data: Buffer): ZkUser[] {
  if (data.length < 4) {
    throw new ZkFramingError('user payload too short to hold its size header', data)
  }
  const totalSize = data.readUInt32LE(0)
  if (data.length < 4 + totalSize) {
    throw new ZkFramingError(
      `user payload declares ${totalSize} bytes but only ${data.length - 4} arrived`,
      data.subarray(0, 16),
    )
  }
  const body = data.subarray(4, 4 + totalSize)
  if (body.length % USER_RECORD_SIZE !== 0) {
    throw new ZkFramingError(
      `user body of ${body.length} bytes is not a multiple of ${USER_RECORD_SIZE}`,
    )
  }
  const out: ZkUser[] = []
  for (let off = 0; off + USER_RECORD_SIZE <= body.length; off += USER_RECORD_SIZE) {
    out.push(decodeOne(body.subarray(off, off + USER_RECORD_SIZE)))
  }
  return out
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/codec/records/user.spec.ts && pnpm typecheck`
Expected: 9 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/codec/records/user.ts src/types.ts test/codec/records/user.spec.ts
git commit -m "feat(codec): user record decoding"
```

---

## Task 9: Device emulator core

**Files:**
- Create: `test/emulator/index.ts`
- Test: `test/emulator/emulator.spec.ts`

**Interfaces:**
- Consumes: `encodePayload`, `decodePayload` (Task 3), `frameTcp`, `tryUnframeTcp` (Task 4), `CMD` (Task 3).
- Produces:
  - `startEmulator(opts: EmulatorOptions): Promise<Emulator>`
  - `interface EmulatorOptions { transport: 'tcp' | 'udp'; commKey?: number; sessionId?: number; behavior?: 'normal' | 'silent' | 'dropMidTransfer'; dropAfterChunk?: number; handlers?: Partial<HandlerTable> }`
  - `interface Emulator { port: number; transport: 'tcp' | 'udp'; received: DecodedPacket[]; receivedRaw: Buffer[]; state: EmulatorState; close(): Promise<void> }`
  - `type Handler = (req: DecodedPacket, state: EmulatorState) => Buffer[] | null`
  - `interface EmulatorState { sessionId: number; commKey: number; authenticated: boolean; users: ZkUser[]; records: EmulatorRecords | null; supportsBuffer: boolean; chunksSent: number; dropConnection: boolean; opts: EmulatorOptions }`
  - `reply(state, req, command, data?): Buffer` — helper that builds a response payload.

Later tasks register additional handlers. This task delivers the handshake only.

- [ ] **Step 1: Write the failing test**

`test/emulator/emulator.spec.ts`:
```ts
import net from 'node:net'
import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { startEmulator, type Emulator } from './index.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'

let running: Emulator | null = null
afterEach(async () => { await running?.close(); running = null })

/** Sends one raw payload and resolves with the first reply payload. */
function roundTripTcp(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(frameTcp(payload))
    })
    let acc = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk])
      const framed = tryUnframeTcp(acc)
      if (framed) { sock.destroy(); resolve(framed.payload) }
    })
    sock.on('error', reject)
  })
}

function roundTripUdp(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    sock.on('message', (msg) => { sock.close(); resolve(Buffer.from(msg)) })
    sock.on('error', reject)
    sock.send(payload, port, '127.0.0.1')
  })
}

describe('emulator', () => {
  it('answers CMD_CONNECT with ACK_OK carrying its session id over TCP', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0xbeef })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })),
    )
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0xbeef)
  })

  it('answers CMD_CONNECT over UDP with no TCP prefix', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x1234 })
    const raw = await roundTripUdp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    // A bare payload: no start marker, and the first two bytes are the command.
    expect(raw.readUInt16LE(0)).toBe(CMD.ACK_OK)
    expect(decodePayload(raw).sessionId).toBe(0x1234)
  })

  it('echoes the reply id it was sent', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 41 })),
    )
    expect(reply.replyId).toBe(41)
  })

  it('records every payload it received, decoded', async () => {
    running = await startEmulator({ transport: 'tcp' })
    await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT])
  })

  it('records raw wire bytes including the TCP prefix', async () => {
    running = await startEmulator({ transport: 'tcp' })
    await roundTripTcp(running.port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(running.receivedRaw[0]!.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x50, 0x82, 0x7d]))
  })

  it('answers an unknown command with ACK_ERROR', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const reply = decodePayload(
      await roundTripTcp(running.port, encodePayload({ command: 9999, sessionId: 1, replyId: 0 })),
    )
    expect(reply.command).toBe(CMD.ACK_ERROR)
  })

  it('says nothing at all when behavior is silent', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    const port = running.port
    const settled = await Promise.race([
      roundTripTcp(port, encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })).then(() => 'replied'),
      new Promise((r) => setTimeout(() => r('silent'), 300)),
    ])
    expect(settled).toBe('silent')
  })

  it('binds an ephemeral port and reports it', async () => {
    running = await startEmulator({ transport: 'tcp' })
    expect(running.port).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/emulator/emulator.spec.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the implementation**

`test/emulator/index.ts`:
```ts
import net from 'node:net'
import dgram from 'node:dgram'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload, type DecodedPacket } from '../../src/codec/packet.js'
import { frameTcp, tryUnframeTcp } from '../../src/codec/framing.js'
import type { ZkUser } from '../../src/types.js'

export interface EmulatorRecords {
  size: 8 | 16 | 40
  rows: Buffer[]
  /** Overrides the declared totalSize, to exercise the framing guard. */
  totalSizeOverride?: number
  junkPrefix?: boolean
}

export interface EmulatorOptions {
  transport: 'tcp' | 'udp'
  commKey?: number
  sessionId?: number
  users?: ZkUser[]
  records?: EmulatorRecords
  behavior?: 'normal' | 'silent' | 'dropMidTransfer'
  dropAfterChunk?: number
  chunkSize?: number
  /** When false, the buffered-read commands are refused so the caller must
   *  fall back to the legacy path. */
  supportsBuffer?: boolean
  handlers?: Partial<HandlerTable>
}

export interface EmulatorState {
  sessionId: number
  commKey: number
  authenticated: boolean
  users: ZkUser[]
  records: EmulatorRecords | null
  supportsBuffer: boolean
  chunksSent: number
  /** Set by the transport layer so a handler can end the connection. */
  dropConnection: boolean
  opts: EmulatorOptions
}

export type Handler = (req: DecodedPacket, state: EmulatorState) => Buffer[] | null
export type HandlerTable = Record<number, Handler>

export interface Emulator {
  readonly port: number
  readonly transport: 'tcp' | 'udp'
  readonly received: DecodedPacket[]
  readonly receivedRaw: Buffer[]
  readonly state: EmulatorState
  close(): Promise<void>
}

/** Builds one reply payload echoing the request's reply id. */
export function reply(
  state: EmulatorState,
  req: DecodedPacket,
  command: number,
  data?: Buffer,
): Buffer {
  return encodePayload({ command, sessionId: state.sessionId, replyId: req.replyId, data })
}

const baseHandlers: HandlerTable = {
  [CMD.CONNECT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
  [CMD.EXIT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
}

function buildState(opts: EmulatorOptions): EmulatorState {
  return {
    sessionId: opts.sessionId ?? 0x0001,
    commKey: opts.commKey ?? 0,
    authenticated: (opts.commKey ?? 0) === 0,
    users: opts.users ?? [],
    records: opts.records ?? null,
    supportsBuffer: opts.supportsBuffer ?? true,
    chunksSent: 0,
    dropConnection: false,
    opts,
  }
}

export async function startEmulator(opts: EmulatorOptions): Promise<Emulator> {
  const state = buildState(opts)
  const handlers: HandlerTable = { ...baseHandlers, ...(opts.handlers ?? {}) }
  const received: DecodedPacket[] = []
  const receivedRaw: Buffer[] = []

  const respond = (raw: Buffer, payload: Buffer): Buffer[] | null => {
    receivedRaw.push(Buffer.from(raw))
    const req = decodePayload(payload)
    received.push(req)
    if (opts.behavior === 'silent') return null
    const handler = handlers[req.command]
    if (!handler) return [reply(state, req, CMD.ACK_ERROR)]
    return handler(req, state)
  }

  if (opts.transport === 'tcp') {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0)
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk])
        for (;;) {
          const framed = tryUnframeTcp(acc)
          if (!framed) break
          const raw = acc.subarray(0, framed.consumed)
          acc = acc.subarray(framed.consumed)
          const out = respond(Buffer.from(raw), framed.payload)
          if (out) for (const p of out) sock.write(frameTcp(p))
          if (state.dropConnection) { state.dropConnection = false; sock.destroy() }
        }
      })
      sock.on('error', () => { /* client-side resets are expected in tests */ })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return {
      port, transport: 'tcp', received, receivedRaw, state,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, rinfo) => {
    const out = respond(Buffer.from(msg), Buffer.from(msg))
    if (out) for (const p of out) sock.send(p, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve))
  const port = sock.address().port
  return {
    port, transport: 'udp', received, receivedRaw, state,
    close: () => new Promise<void>((resolve) => { sock.close(() => resolve()) }),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/emulator/emulator.spec.ts && pnpm typecheck`
Expected: 8 passing, no type errors.

- [ ] **Step 5: Commit**

```bash
git add test/emulator/index.ts test/emulator/emulator.spec.ts
git commit -m "test: scriptable ZKTeco device emulator over TCP and UDP"
```

---

## Task 10: TCP transport

**Files:**
- Create: `src/transport/Transport.ts`, `src/transport/tcp.ts`
- Test: `test/transport/tcp.spec.ts`

**Interfaces:**
- Consumes: `frameTcp`, `tryUnframeTcp` (Task 4), errors (Task 3), emulator (Task 9).
- Produces:
  - `interface Transport { connect(): Promise<void>; send(payload: Buffer): Promise<void>; receive(timeoutMs: number): Promise<Buffer>; close(): Promise<void> }`
  - `interface TransportOptions { host: string; port: number }`
  - `class TcpTransport implements Transport`

`send` and `receive` deal in **bare payloads**; framing is the transport's business.

- [ ] **Step 1: Create `src/transport/Transport.ts`**

```ts
export interface TransportOptions {
  host: string
  port: number
}

/**
 * The only abstraction that touches a socket.
 *
 * TCP and UDP differ in exactly two ways — whether packets carry the 8-byte
 * length-prefixed header, and how bytes arrive. Both differences live behind
 * this interface, so nothing above it ever learns which transport is in play.
 * `send` and `receive` deal in bare payloads.
 */
export interface Transport {
  connect(): Promise<void>
  send(payload: Buffer): Promise<void>
  receive(timeoutMs: number): Promise<Buffer>
  close(): Promise<void>
}
```

- [ ] **Step 2: Write the failing test**

`test/transport/tcp.spec.ts`:
```ts
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TcpTransport } from '../../src/transport/tcp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { frameTcp } from '../../src/codec/framing.js'
import { ZkConnectionError, ZkTimeoutError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: TcpTransport | null = null
afterEach(async () => {
  await transport?.close(); transport = null
  await running?.close(); running = null
})

const connectPayload = () => encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })

describe('TcpTransport', () => {
  it('sends a framed payload and receives a bare one back', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x77 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    const reply = decodePayload(await transport.receive(2000))
    expect(reply.command).toBe(CMD.ACK_OK)
    expect(reply.sessionId).toBe(0x77)
  })

  it('reassembles a reply delivered in several TCP chunks', async () => {
    // A server that deliberately dribbles one framed packet out byte by byte.
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 5, replyId: 0 })
    const framed = frameTcp(payload)
    const server = net.createServer((sock) => {
      sock.on('data', () => {
        for (const byte of framed) sock.write(Buffer.from([byte]))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect()
      await transport.send(connectPayload())
      expect(decodePayload(await transport.receive(2000)).sessionId).toBe(5)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('separates two replies that arrived coalesced in one chunk', async () => {
    const a = frameTcp(encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 0 }))
    const b = frameTcp(encodePayload({ command: CMD.ACK_DATA, sessionId: 2, replyId: 1 }))
    const server = net.createServer((sock) => {
      sock.on('data', () => sock.write(Buffer.concat([a, b])))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect()
      await transport.send(connectPayload())
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
      expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_DATA)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('times out rather than hanging when the device stays silent', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('reports a refused connection as ZkConnectionError', async () => {
    // Port 1 on loopback is not listening.
    transport = new TcpTransport({ host: '127.0.0.1', port: 1 })
    await expect(transport.connect()).rejects.toBeInstanceOf(ZkConnectionError)
    transport = null
  })

  it('rejects a pending receive when the device disconnects mid-exchange', async () => {
    const server = net.createServer((sock) => { sock.on('data', () => sock.destroy()) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    try {
      transport = new TcpTransport({ host: '127.0.0.1', port })
      await transport.connect()
      await transport.send(connectPayload())
      await expect(transport.receive(2000)).rejects.toBeInstanceOf(ZkConnectionError)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('is safe to close twice', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
    transport = null
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/transport/tcp.spec.ts`
Expected: FAIL — cannot resolve `../../src/transport/tcp.js`.

- [ ] **Step 4: Write the implementation**

`src/transport/tcp.ts`:
```ts
import net from 'node:net'
import { frameTcp, tryUnframeTcp } from '../codec/framing.js'
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'
import type { Transport, TransportOptions } from './Transport.js'

export class TcpTransport implements Transport {
  private socket: net.Socket | null = null
  /** Bytes arrived but not yet consumed as complete packets. */
  private buffered = Buffer.alloc(0)
  /** Complete payloads ready to hand to `receive`. */
  private queue: Buffer[] = []
  private waiter: ((payload: Buffer) => void) | null = null
  private failure: Error | null = null
  private failWaiter: ((err: Error) => void) | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port })
      const onError = (err: Error): void => {
        sock.destroy()
        reject(new ZkConnectionError(`cannot connect to ${this.opts.host}:${this.opts.port}: ${err.message}`))
      }
      sock.once('error', onError)
      sock.once('connect', () => {
        sock.off('error', onError)
        this.socket = sock
        sock.on('data', (chunk) => this.absorb(chunk))
        sock.on('error', (err) => this.fail(new ZkConnectionError(err.message)))
        sock.on('close', () => this.fail(new ZkConnectionError('connection closed by peer')))
        resolve()
      })
    })
  }

  /**
   * TCP splits and coalesces freely, so bytes are accumulated and only
   * surfaced once the length prefix says a whole packet has arrived. Several
   * packets can emerge from one chunk.
   */
  private absorb(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk])
    for (;;) {
      let framed
      try {
        framed = tryUnframeTcp(this.buffered)
      } catch (err) {
        this.fail(err as Error)
        return
      }
      if (!framed) return
      this.buffered = this.buffered.subarray(framed.consumed)
      const waiter = this.waiter
      if (waiter) {
        this.waiter = null
        this.failWaiter = null
        waiter(framed.payload)
      } else {
        this.queue.push(framed.payload)
      }
    }
  }

  private fail(err: Error): void {
    this.failure = err
    const failWaiter = this.failWaiter
    if (failWaiter) {
      this.waiter = null
      this.failWaiter = null
      failWaiter(err)
    }
  }

  send(payload: Buffer): Promise<void> {
    const sock = this.socket
    if (!sock) return Promise.reject(new ZkConnectionError('transport is not connected'))
    return new Promise((resolve, reject) => {
      sock.write(frameTcp(payload), (err) =>
        err ? reject(new ZkConnectionError(err.message)) : resolve(),
      )
    })
  }

  receive(timeoutMs: number): Promise<Buffer> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        this.failWaiter = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiter = (payload) => { clearTimeout(timer); resolve(payload) }
      this.failWaiter = (err) => { clearTimeout(timer); reject(err) }
    })
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => {
      sock.removeAllListeners('close')
      sock.end(() => { sock.destroy(); resolve() })
    })
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/transport/tcp.spec.ts && pnpm typecheck`
Expected: 7 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/transport/Transport.ts src/transport/tcp.ts test/transport/tcp.spec.ts
git commit -m "feat(transport): TCP transport with packet reassembly and timeouts"
```

---

## Task 11: UDP transport

**Files:**
- Create: `src/transport/udp.ts`
- Test: `test/transport/udp.spec.ts`

**Interfaces:**
- Consumes: `Transport`, `TransportOptions` (Task 10), errors (Task 3), emulator (Task 9).
- Produces: `class UdpTransport implements Transport`.

UDP sends the **bare payload** with no start marker and no length prefix, and treats each datagram as one whole packet.

- [ ] **Step 1: Write the failing test**

`test/transport/udp.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodePayload, encodePayload } from '../../src/codec/packet.js'
import { ZkTimeoutError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let transport: UdpTransport | null = null
afterEach(async () => {
  await transport?.close(); transport = null
  await running?.close(); running = null
})

const connectPayload = () => encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 })

describe('UdpTransport', () => {
  it('round-trips a payload', async () => {
    running = await startEmulator({ transport: 'udp', sessionId: 0x99 })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    expect(decodePayload(await transport.receive(2000)).sessionId).toBe(0x99)
  })

  it('sends the bare payload with no TCP start marker', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await transport.receive(2000)
    const raw = running.receivedRaw[0]!
    expect(raw.length).toBe(8)
    expect(raw.readUInt16LE(0)).toBe(CMD.CONNECT)
  })

  it('times out rather than hanging when the device stays silent', async () => {
    running = await startEmulator({ transport: 'udp', behavior: 'silent' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('queues a datagram that arrived before receive was called', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.send(connectPayload())
    await new Promise((r) => setTimeout(r, 100))
    expect(decodePayload(await transport.receive(2000)).command).toBe(CMD.ACK_OK)
  })

  it('is safe to close twice', async () => {
    running = await startEmulator({ transport: 'udp' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
    transport = null
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/transport/udp.spec.ts`
Expected: FAIL — cannot resolve `../../src/transport/udp.js`.

- [ ] **Step 3: Write the implementation**

`src/transport/udp.ts`:
```ts
import dgram from 'node:dgram'
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'
import type { Transport, TransportOptions } from './Transport.js'

/**
 * UDP transport.
 *
 * Datagrams carry the bare payload: no start marker, no length prefix. One
 * datagram is one packet, so there is nothing to reassemble.
 *
 * This is the fallback. UDP loses packets and does not recover, and its
 * framing carries no length to validate against, so TCP is the default.
 */
export class UdpTransport implements Transport {
  private socket: dgram.Socket | null = null
  private queue: Buffer[] = []
  private waiter: ((payload: Buffer) => void) | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      sock.once('error', (err) => {
        sock.close()
        reject(new ZkConnectionError(err.message))
      })
      sock.on('message', (msg) => {
        const payload = Buffer.from(msg)
        const waiter = this.waiter
        if (waiter) { this.waiter = null; waiter(payload) } else { this.queue.push(payload) }
      })
      sock.bind(0, () => { this.socket = sock; resolve() })
    })
  }

  send(payload: Buffer): Promise<void> {
    const sock = this.socket
    if (!sock) return Promise.reject(new ZkConnectionError('transport is not connected'))
    return new Promise((resolve, reject) => {
      sock.send(payload, this.opts.port, this.opts.host, (err) =>
        err ? reject(new ZkConnectionError(err.message)) : resolve(),
      )
    })
  }

  receive(timeoutMs: number): Promise<Buffer> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiter = (payload) => { clearTimeout(timer); resolve(payload) }
    })
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/transport/udp.spec.ts && pnpm typecheck`
Expected: 5 passing, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/transport/udp.ts test/transport/udp.spec.ts
git commit -m "feat(transport): UDP transport"
```

---

## Task 12: Session

**Files:**
- Create: `src/session/Session.ts`
- Test: `test/session/session.spec.ts`

**Interfaces:**
- Consumes: `Transport` (Task 10), `encodePayload`/`decodePayload`/`applyReplyIdQuirk` (Task 3), `CMD` (Task 3), errors (Task 3).
- Produces:
  - `interface SessionOptions { timeoutMs: number }`
  - `class Session { readonly sessionId: number; open(): Promise<void>; execute(command: number, data?: Buffer): Promise<DecodedPacket>; close(): Promise<void> }`

`execute` throws `ZkProtocolError` on `CMD_ACK_ERROR` and returns every other reply verbatim, because bulk reads legitimately receive `ACK_DATA` and `PREPARE_DATA`.

- [ ] **Step 1: Write the failing test**

`test/session/session.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkAuthError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`Session over ${transportKind}`, () => {
    it('acquires the session id the device issues', async () => {
      running = await startEmulator({ transport: transportKind, sessionId: 0x4242 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(session.sessionId).toBe(0x4242)
    })

    it('sends the acquired session id on subsequent commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        sessionId: 0x0abc,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      expect(running.received[1]!.sessionId).toBe(0x0abc)
    })

    it('transmits a reply id one ahead of the one its checksum covers', async () => {
      // The reply-id quirk, observed end to end: the wire packet carries N+1
      // while its checksum was computed over N. See spec §5.1.
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)

      const sent = running.received[1]!
      const asTransmitted = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId,
      })
      const asChecksummed = encodePayload({
        command: sent.command, sessionId: sent.sessionId, replyId: sent.replyId - 1,
      })
      expect(sent.checksum).not.toBe(checksum16(asTransmitted))
      expect(sent.checksum).toBe(checksum16(asChecksummed))
    })

    it('increments the reply id across commands', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.execute(CMD.GET_FREE_SIZES)
      await session.execute(CMD.GET_FREE_SIZES)
      const ids = running.received.map((p) => p.replyId)
      expect(ids[2]).toBe(ids[1]! + 1)
    })

    it('throws ZkProtocolError when the device replies ACK_ERROR', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('returns ACK_DATA replies verbatim rather than treating them as failures', async () => {
      const payload = Buffer.from([1, 2, 3])
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_DATA, payload)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const res = await session.execute(CMD.ATTLOG_RRQ)
      expect(res.command).toBe(CMD.ACK_DATA)
      expect(res.data).toEqual(payload)
    })

    it('throws ZkAuthError when the device demands a comm key', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.CONNECT]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })

    it('times out on a silent device instead of hanging', async () => {
      running = await startEmulator({ transport: transportKind, behavior: 'silent' })
      session = new Session(makeTransport(running.port), { timeoutMs: 200 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkTimeoutError)
      session = null
    })

    it('is safe to close twice', async () => {
      running = await startEmulator({ transport: transportKind })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.close()
      await expect(session.close()).resolves.toBeUndefined()
      session = null
    })
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/session/session.spec.ts`
Expected: FAIL — cannot resolve `../../src/session/Session.js`.

- [ ] **Step 3: Write the implementation**

`src/session/Session.ts`:
```ts
import { CMD } from '../codec/commands.js'
import { applyReplyIdQuirk, decodePayload, encodePayload, type DecodedPacket } from '../codec/packet.js'
import { ZkAuthError, ZkProtocolError } from '../errors.js'
import type { Transport } from '../transport/Transport.js'

export interface SessionOptions {
  timeoutMs: number
}

/**
 * One request-response conversation with a device: session id acquisition,
 * reply-id sequencing, and per-request deadlines.
 */
export class Session {
  private currentSessionId = 0
  private replyId = 0
  private open_ = false

  constructor(
    private readonly transport: Transport,
    private readonly opts: SessionOptions,
  ) {}

  get sessionId(): number {
    return this.currentSessionId
  }

  /** Handshakes and stores the session id the device issues. */
  async open(): Promise<void> {
    await this.transport.connect()
    this.open_ = true
    const res = await this.send(CMD.CONNECT, undefined, { sessionId: 0 })
    if (res.command === CMD.ACK_UNAUTH) {
      throw new ZkAuthError('device requires a comm key')
    }
    if (res.command !== CMD.ACK_OK) {
      throw new ZkProtocolError(`handshake refused with command ${res.command}`)
    }
    this.currentSessionId = res.sessionId
  }

  /** Sends one command and returns the reply. Throws only on ACK_ERROR. */
  async execute(command: number, data?: Buffer): Promise<DecodedPacket> {
    const res = await this.send(command, data)
    if (res.command === CMD.ACK_ERROR) {
      throw new ZkProtocolError(`device rejected command ${command}`)
    }
    return res
  }

  /**
   * Encodes, applies the reply-id quirk, transmits, and awaits one reply.
   *
   * The checksum is computed over the CURRENT reply id, then the transmitted
   * packet carries the incremented one with the checksum left alone. That
   * mismatch is what devices appear to expect — see applyReplyIdQuirk.
   */
  private async send(
    command: number,
    data: Buffer | undefined,
    override?: { sessionId: number },
  ): Promise<DecodedPacket> {
    const sessionId = override?.sessionId ?? this.currentSessionId
    const payload = encodePayload({ command, sessionId, replyId: this.replyId, data })
    const wire = applyReplyIdQuirk(payload, this.replyId + 1)
    this.replyId = (this.replyId + 1) & 0xffff
    await this.transport.send(wire)
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  /** Receives one further packet in an ongoing multi-packet exchange. */
  async receiveMore(): Promise<DecodedPacket> {
    return decodePayload(await this.transport.receive(this.opts.timeoutMs))
  }

  async close(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close()
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/session/session.spec.ts && pnpm typecheck`
Expected: 18 passing (9 scenarios × 2 transports), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/session/Session.ts test/session/session.spec.ts
git commit -m "feat(session): handshake, reply-id sequencing, per-request deadlines"
```

---

## Task 13: Oracle harness and fixtures

**Files:**
- Create: `tools/oracle/README.md`, `tools/oracle/requirements.txt`, `tools/oracle/capture_pyzk.py`, `tools/oracle/capture_zkjs.ts`, `tools/oracle/capture.ts`, `tools/oracle/analyze.ts`
- Create: `test/fixtures/oracle/handshake-tcp.json`, `test/fixtures/oracle/handshake-udp.json` (generated, then committed)
- Test: `test/oracle/fixtures.spec.ts`
- Modify: `package.json` (add `zkteco-js` devDependency and an `oracle:capture` script)

**Interfaces:**
- Consumes: emulator (Task 9), `checksum16` (Task 2), `encodePayload` (Task 3), `START_MARKER` (Task 4), `mixCommKey` (Task 5).
- Produces:
  - Fixture shape: `{ source: 'pyzk' | 'zkteco-js', transport: 'tcp' | 'udp', emulatorSessionId: number, packets: Array<{ hex: string; command: number; checksum: number; sessionId: number; replyId: number }> }`
  - `classifyChecksum(packet): 'self' | 'previous-reply-id' | 'neither'` in `tools/oracle/analyze.ts`, re-exported for the test.

Read spec §7.3 and §8 before starting. **`pyzk` is executed as a black box. Do not open any file under `site-packages/zk/`.**

- [ ] **Step 1: Add the JavaScript oracle dependency and a capture script**

```bash
pnpm add -D zkteco-js tsx
```

Then add to `package.json` `scripts`:
```json
"oracle:capture": "tsx tools/oracle/capture.ts"
```

- [ ] **Step 2: Write `tools/oracle/README.md`**

````markdown
# Oracle capture

With no physical device available, correctness rests on comparing the bytes this
library emits against bytes emitted by two independent implementations that have
run against real hardware.

Both are driven as **black boxes** against the emulator in `test/emulator/`. The
bytes they put on the socket are recorded and committed as fixtures under
`test/fixtures/oracle/`. CI reads only those JSON files — it needs neither
Python nor either oracle installed.

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
````

- [ ] **Step 3: Write `tools/oracle/requirements.txt`**

```
pyzk==0.9
```

- [ ] **Step 4: Write `tools/oracle/capture_pyzk.py`**

```python
"""Drives pyzk against the local emulator so its wire bytes can be recorded.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp)
    try:
        conn.connect()
    except Exception as exc:  # the emulator may answer only part of a session
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

- [ ] **Step 5: Write `tools/oracle/capture_zkjs.ts`**

```ts
/**
 * Drives zkteco-js (MIT) against the local emulator.
 *
 * Attribution: https://github.com/coding-libs/zkteco-js
 */
import ZKLib from 'zkteco-js'

const port = Number(process.argv[2])

async function main(): Promise<void> {
  const device = new ZKLib('127.0.0.1', port, 5000, 5000)
  try {
    await device.createSocket()
  } catch (err) {
    process.stderr.write(`zkteco-js stopped: ${String(err)}\n`)
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

- [ ] **Step 6: Write `tools/oracle/capture.ts`**

```ts
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { decodePayload } from '../../src/codec/packet.js'
import { startEmulator } from '../../test/emulator/index.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle')
const EMULATOR_SESSION_ID = 0x1f2e

function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

async function capture(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
): Promise<void> {
  const emulator = await startEmulator({ transport, sessionId: EMULATOR_SESSION_ID })
  try {
    if (source === 'pyzk') {
      await run(pythonPath(), ['tools/oracle/capture_pyzk.py', String(emulator.port), transport])
    } else {
      await run('npx', ['tsx', 'tools/oracle/capture_zkjs.ts', String(emulator.port)])
    }
    // Give the last datagram a moment to land before tearing the socket down.
    await new Promise((r) => setTimeout(r, 300))

    const packets = emulator.received.map((p, i) => ({
      hex: emulator.receivedRaw[i]!.toString('hex'),
      command: p.command,
      checksum: p.checksum,
      sessionId: p.sessionId,
      replyId: p.replyId,
    }))
    const fixture = { source, transport, emulatorSessionId: EMULATOR_SESSION_ID, packets }
    mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `handshake-${transport}-${source}.json`)
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`wrote ${file} (${packets.length} packets)\n`)
  } finally {
    await emulator.close()
  }
}

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await capture(source, transport)
  }
}
```

- [ ] **Step 7: Write `tools/oracle/analyze.ts`**

```ts
import { checksum16 } from '../../src/codec/checksum.js'
import { encodePayload } from '../../src/codec/packet.js'

export interface CapturedPacket {
  hex: string
  command: number
  checksum: number
  sessionId: number
  replyId: number
}

export interface OracleFixture {
  source: 'pyzk' | 'zkteco-js'
  transport: 'tcp' | 'udp'
  emulatorSessionId: number
  packets: CapturedPacket[]
}

export type ChecksumClass = 'self' | 'previous-reply-id' | 'neither'

/**
 * Decides which reply id a captured packet's checksum was computed over.
 *
 * 'self'               — the checksum matches the packet as transmitted.
 * 'previous-reply-id'  — the checksum matches the same packet with replyId - 1,
 *                        which is the quirk this library implements.
 * 'neither'            — something else is going on; investigate before
 *                        trusting any of it.
 */
export function classifyChecksum(p: CapturedPacket, dataHexAfterHeader = ''): ChecksumClass {
  const data = Buffer.from(dataHexAfterHeader, 'hex')
  const asSent = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: p.replyId, data,
  })
  if (checksum16(asSent) === p.checksum) return 'self'
  const asPrevious = encodePayload({
    command: p.command, sessionId: p.sessionId, replyId: (p.replyId - 1) & 0xffff, data,
  })
  if (checksum16(asPrevious) === p.checksum) return 'previous-reply-id'
  return 'neither'
}
```

- [ ] **Step 8: Generate the fixtures**

```bash
python -m venv tools/oracle/.venv
tools/oracle/.venv/Scripts/pip install -r tools/oracle/requirements.txt
pnpm oracle:capture
```

Expected: four files under `test/fixtures/oracle/`. Inspect them — each should contain at least a `CMD_CONNECT` packet.

- [ ] **Step 9: Write the test that pins the library against the fixtures**

`test/oracle/fixtures.spec.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyChecksum, type OracleFixture } from '../../tools/oracle/analyze.js'
import { START_MARKER } from '../../src/codec/framing.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')
// Only the handshake captures. Task 14 adds `auth-*` fixtures alongside these;
// they are asserted separately because comm-key mixing has its own oracle story.
const fixtures = readdirSync(DIR)
  .filter((f) => f.startsWith('handshake-') && f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as OracleFixture)

describe('oracle fixtures', () => {
  it('exist for both oracles on both transports', () => {
    const seen = fixtures.map((f) => `${f.source}/${f.transport}`).sort()
    expect(seen).toEqual([
      'pyzk/tcp', 'pyzk/udp', 'zkteco-js/tcp', 'zkteco-js/udp',
    ])
  })

  it.each(fixtures.map((f) => [`${f.source} over ${f.transport}`, f] as const))(
    '%s captured a handshake', (_name, fixture) => {
      expect(fixture.packets.length).toBeGreaterThan(0)
      expect(fixture.packets[0]!.command).toBe(CMD.CONNECT)
    },
  )

  it.each(fixtures.filter((f) => f.transport === 'tcp').map((f) => [f.source, f] as const))(
    '%s frames TCP packets with the start marker this library writes', (_src, fixture) => {
      for (const p of fixture.packets) {
        expect(Buffer.from(p.hex, 'hex').subarray(0, 4)).toEqual(START_MARKER)
      }
    },
  )

  it.each(fixtures.filter((f) => f.transport === 'udp').map((f) => [f.source, f] as const))(
    '%s sends UDP payloads bare, with no start marker', (_src, fixture) => {
      for (const p of fixture.packets) {
        expect(Buffer.from(p.hex, 'hex').subarray(0, 4)).not.toEqual(START_MARKER)
      }
    },
  )

  it('both oracles agree on which reply id the checksum covers', () => {
    // This is the adjudication described in spec §5.1. Whatever the two
    // independent implementations agree on is what the library implements. If
    // this test ever fails, do NOT pick a side: record the divergence and
    // leave it for first-hardware verification.
    const verdicts = new Map<string, Set<string>>()
    for (const fixture of fixtures) {
      const classes = new Set(fixture.packets.map((p) => classifyChecksum(p)))
      verdicts.set(`${fixture.source}/${fixture.transport}`, classes)
    }
    const flattened = new Set([...verdicts.values()].flatMap((s) => [...s]))
    expect(flattened.has('neither')).toBe(false)
    expect(flattened.size, `oracles disagree: ${JSON.stringify([...verdicts])}`).toBe(1)
  })
})
```

- [ ] **Step 10: Run the test**

Run: `pnpm vitest run test/oracle/fixtures.spec.ts`
Expected: PASS.

**If the last test fails because the two oracles disagree:** stop. Do not change `applyReplyIdQuirk` to satisfy one of them. Record what each emitted in `PROVENANCE.md` under a "Known divergences" heading, mark it in the spec's §12 checklist, and skip that one assertion with an explanatory comment naming the divergence.

**If both agree on `'self'`** rather than `'previous-reply-id'`: the quirk does not apply to these implementations. Change `Session.send` to transmit `payload` instead of `applyReplyIdQuirk(payload, …)`, keep `applyReplyIdQuirk` exported and tested for devices that need it, and note the finding in `PROVENANCE.md`.

- [ ] **Step 11: Commit**

```bash
git add tools/oracle test/fixtures/oracle test/oracle/fixtures.spec.ts package.json pnpm-lock.yaml
git commit -m "test(oracle): capture wire bytes from two independent implementations"
```

---

## Task 14: Comm-key authentication

**Files:**
- Modify: `src/session/Session.ts` (add `commKey` to `SessionOptions`, handle `ACK_UNAUTH` in `open`)
- Modify: `test/emulator/index.ts` (comm-key challenge in the `CONNECT` handler, plus an `AUTH` handler)
- Test: `test/session/auth.spec.ts`

**Interfaces:**
- Consumes: `mixCommKey` (Task 5), `Session` (Task 12), emulator (Task 9).
- Produces: `SessionOptions` gains `commKey?: number` (default `0`, meaning unset).

Note the limit of these tests honestly: the emulator validates the mixed key with the library's own `mixCommKey`, so they prove the **flow**, not the algorithm. The algorithm is pinned by Task 13's fixtures and by first-hardware verification.

- [ ] **Step 1: Extend the emulator**

Replace the `baseHandlers` block in `test/emulator/index.ts` with:

```ts
import { mixCommKey } from '../../src/codec/commkey.js'

const baseHandlers: HandlerTable = {
  [CMD.CONNECT]: (req, state) => [
    reply(state, req, state.authenticated ? CMD.ACK_OK : CMD.ACK_UNAUTH),
  ],
  [CMD.AUTH]: (req, state) => {
    const expected = mixCommKey(state.commKey, state.sessionId)
    if (req.data.equals(expected)) {
      state.authenticated = true
      return [reply(state, req, CMD.ACK_OK)]
    }
    return [reply(state, req, CMD.ACK_UNAUTH)]
  },
  [CMD.EXIT]: (req, state) => [reply(state, req, CMD.ACK_OK)],
}
```

- [ ] **Step 2: Write the failing test**

`test/session/auth.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { ZkAuthError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`comm-key authentication over ${transportKind}`, () => {
    it('connects without CMD_AUTH when the device does not ask', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 0 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT])
    })

    it('answers ACK_UNAUTH with a mixed comm key and completes the handshake', async () => {
      running = await startEmulator({
        transport: transportKind, commKey: 1234, sessionId: 0x0777,
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 1234 })
      await session.open()
      expect(session.sessionId).toBe(0x0777)
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT, CMD.AUTH])
    })

    it('mixes the key against the session id the device issued', async () => {
      running = await startEmulator({
        transport: transportKind, commKey: 4321, sessionId: 0x0abc,
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 4321 })
      await session.open()
      const auth = running.received.find((p) => p.command === CMD.AUTH)!
      expect(auth.data).toEqual(mixCommKey(4321, 0x0abc))
    })

    it('throws ZkAuthError on a wrong comm key', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 1234 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000, commKey: 9999 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })

    it('throws ZkAuthError when the device asks and no key was configured', async () => {
      running = await startEmulator({ transport: transportKind, commKey: 1234 })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await expect(session.open()).rejects.toBeInstanceOf(ZkAuthError)
      session = null
    })
  })
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/session/auth.spec.ts`
Expected: FAIL — the session throws `ZkAuthError` even when a correct key is configured.

- [ ] **Step 4: Update `src/session/Session.ts`**

Add the import and the option:
```ts
import { mixCommKey } from '../codec/commkey.js'

export interface SessionOptions {
  timeoutMs: number
  /** Device comm key. 0 means unset. */
  commKey?: number
}
```

Replace the body of `open()` with:
```ts
  async open(): Promise<void> {
    await this.transport.connect()
    this.open_ = true
    const res = await this.send(CMD.CONNECT, undefined, { sessionId: 0 })

    if (res.command === CMD.ACK_UNAUTH) {
      const commKey = this.opts.commKey ?? 0
      if (commKey === 0) {
        throw new ZkAuthError('device requires a comm key but none was configured')
      }
      // The key is mixed against the session id the device just issued.
      this.currentSessionId = res.sessionId
      const auth = await this.send(CMD.AUTH, mixCommKey(commKey, res.sessionId))
      if (auth.command !== CMD.ACK_OK) {
        throw new ZkAuthError('device rejected the comm key')
      }
      this.currentSessionId = auth.sessionId
      return
    }

    if (res.command !== CMD.ACK_OK) {
      throw new ZkProtocolError(`handshake refused with command ${res.command}`)
    }
    this.currentSessionId = res.sessionId
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/session && pnpm typecheck`
Expected: all session tests passing (Task 12's suite still green), no type errors.

- [ ] **Step 6: Extend the oracle capture to cover comm-key mixing**

Spec §11 requires an oracle fixture for comm-key mixing, and Task 13 could not
produce one: the emulator had no comm key to challenge with. It does now.

In `tools/oracle/capture.ts`, add a second constant and thread a key through:

```ts
const ORACLE_COMM_KEY = 1234

async function capture(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
  commKey = 0,
): Promise<void> {
  const emulator = await startEmulator({ transport, sessionId: EMULATOR_SESSION_ID, commKey })
  // ...unchanged...
  //   pyzk:      [..., String(emulator.port), transport, String(commKey)]
  //   zkteco-js: [..., String(emulator.port), String(commKey)]
  const fixture = { source, transport, commKey, emulatorSessionId: EMULATOR_SESSION_ID, packets }
  const kind = commKey === 0 ? 'handshake' : 'auth'
  const file = path.join(OUT_DIR, `${kind}-${transport}-${source}.json`)
  // ...unchanged...
}

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await capture(source, transport, 0)
    await capture(source, transport, ORACLE_COMM_KEY)
  }
}
```

In `tools/oracle/capture_pyzk.py`, accept and pass the key:
```python
    comm_key = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp, password=comm_key)
```

In `tools/oracle/capture_zkjs.ts`, read `process.argv[3]` and pass it if the
library exposes a comm-key option. **If it does not, leave the driver as it is.**
`zkteco-js` may have no comm-key support at all, in which case its `auth-*`
fixtures will simply contain no `CMD_AUTH` packet — that is a fact to record,
not a bug to work around.

Add `commKey: number` to the `OracleFixture` interface in `tools/oracle/analyze.ts`.

- [ ] **Step 7: Write the comm-key oracle test**

`test/oracle/commkey.spec.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OracleFixture } from '../../tools/oracle/analyze.js'
import { mixCommKey } from '../../src/codec/commkey.js'
import { CMD } from '../../src/codec/commands.js'

const DIR = path.join('test', 'fixtures', 'oracle')

/** Payload data begins after the TCP prefix (8) plus the packet header (8). */
const dataOffset = (transport: 'tcp' | 'udp'): number => (transport === 'tcp' ? 16 : 8)

function load(name: string): OracleFixture | null {
  const file = path.join(DIR, name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OracleFixture) : null
}

describe('comm-key mixing against the oracles', () => {
  for (const transport of ['tcp', 'udp'] as const) {
    it(`pyzk over ${transport} mixes the key the way this library does`, () => {
      const fixture = load(`auth-${transport}-pyzk.json`)
      expect(fixture, 'run `pnpm oracle:capture` to generate this fixture').not.toBeNull()
      const auth = fixture!.packets.find((p) => p.command === CMD.AUTH)
      expect(auth, 'pyzk sent no CMD_AUTH — check the emulator issued ACK_UNAUTH').toBeDefined()

      const body = Buffer.from(auth!.hex, 'hex').subarray(dataOffset(transport))
      expect(body).toEqual(mixCommKey(fixture!.commKey, fixture!.emulatorSessionId))
    })
  }

  it('records whether zkteco-js offered a second opinion', () => {
    // zkteco-js may not support comm keys. If it does not, its auth fixtures
    // carry no CMD_AUTH and comm-key mixing rests on a single oracle. That is
    // a real weakness, so it is asserted explicitly rather than left implicit:
    // whichever branch holds, note it in PROVENANCE.md under the verification
    // level, and add comm-key mixing to the first-hardware checklist.
    const fixture = load('auth-tcp-zkteco-js.json')
    expect(fixture).not.toBeNull()
    const auth = fixture!.packets.find((p) => p.command === CMD.AUTH)
    if (auth) {
      const body = Buffer.from(auth.hex, 'hex').subarray(dataOffset('tcp'))
      expect(body).toEqual(mixCommKey(fixture!.commKey, fixture!.emulatorSessionId))
    } else {
      expect(fixture!.packets.length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 8: Regenerate the fixtures and run the tests**

Run:
```bash
pnpm oracle:capture
pnpm vitest run test/oracle test/session && pnpm typecheck
```
Expected: green.

**If the pyzk assertion fails**, the mixing algorithm in `src/codec/commkey.ts`
disagrees with a six-year field-proven implementation and is very likely wrong.
Do not adjust the test. Re-read spec §A.4, re-derive the implementation from the
prose, and repeat — without opening pyzk's source. If it still disagrees, record
both byte strings in `PROVENANCE.md` under "Known divergences" and mark comm-key
mixing as unresolved in the spec's first-hardware checklist.

- [ ] **Step 9: Commit**

```bash
git add src/session/Session.ts test/emulator/index.ts test/session/auth.spec.ts
git add tools/oracle test/fixtures/oracle test/oracle/commkey.spec.ts
git commit -m "feat(session): comm-key authentication, pinned by oracle capture"
```

---

## Task 15: Device info

**Files:**
- Create: `src/commands/info.ts`
- Modify: `src/types.ts` (append `ZkDeviceInfo`), `test/emulator/index.ts` (add a `GET_FREE_SIZES` handler)
- Test: `test/commands/info.spec.ts`

**Interfaces:**
- Consumes: `Session` (Task 12), `CMD` (Task 3), `ZkProtocolError` (Task 3).
- Produces:
  - `interface ZkDeviceInfo { userCount: number; recordCount: number; recordCapacity: number }`
  - `getInfo(session: Session): Promise<ZkDeviceInfo>`
  - `FREE_SIZES_OFFSET = { userCount: 16, recordCount: 32, recordCapacity: 64 }` exported so the emulator and the first-hardware check use one definition.
  - Emulator gains `encodeFreeSizes(info): Buffer`.

**Provenance note for this task:** the field offsets inside the `CMD_GET_FREE_SIZES` reply are taken from protocol documentation and have never been checked against a device. They are named constants in one place precisely so a single edit corrects them. Add them to the first-hardware checklist in the spec (§12) as part of Step 6.

- [ ] **Step 1: Append `ZkDeviceInfo` to `src/types.ts`**

```ts
/** Counters the device reports about its own storage. */
export interface ZkDeviceInfo {
  userCount: number
  recordCount: number
  recordCapacity: number
}
```

- [ ] **Step 2: Write the failing test**

`test/commands/info.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { FREE_SIZES_OFFSET, getInfo } from '../../src/commands/info.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkProtocolError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  describe(`getInfo over ${transportKind}`, () => {
    it('reads the three counters the library exposes', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 42, recordCount: 1337, recordCapacity: 100_000 },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect(await getInfo(session)).toEqual({
        userCount: 42, recordCount: 1337, recordCapacity: 100_000,
      })
    })

    it('reports a freshly installed device as holding no records', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 0, recordCapacity: 100_000 },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      expect((await getInfo(session)).recordCount).toBe(0)
    })

    it('throws when the reply is too short to hold the fields it claims', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => [
            reply(state, req, CMD.ACK_OK, Buffer.alloc(8)),
          ],
        },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(getInfo(session)).rejects.toBeInstanceOf(ZkProtocolError)
    })
  })
}

describe('FREE_SIZES_OFFSET', () => {
  it('is exported as a single definition both the library and tests use', () => {
    expect(FREE_SIZES_OFFSET.userCount).toBeTypeOf('number')
    expect(FREE_SIZES_OFFSET.recordCount).toBeTypeOf('number')
    expect(FREE_SIZES_OFFSET.recordCapacity).toBeTypeOf('number')
  })
})
```

- [ ] **Step 3: Extend the emulator**

Add to `EmulatorOptions`:
```ts
  info?: { userCount: number; recordCount: number; recordCapacity: number }
```

Add to `EmulatorState`:
```ts
  info: { userCount: number; recordCount: number; recordCapacity: number }
```
and in `buildState`:
```ts
    info: opts.info ?? { userCount: 0, recordCount: 0, recordCapacity: 0 },
```

Add the encoder and handler:
```ts
import { FREE_SIZES_OFFSET } from '../../src/commands/info.js'

/** Builds a CMD_GET_FREE_SIZES reply body using the library's own offsets. */
export function encodeFreeSizes(info: EmulatorState['info']): Buffer {
  const buf = Buffer.alloc(FREE_SIZES_OFFSET.recordCapacity + 4)
  buf.writeUInt32LE(info.userCount, FREE_SIZES_OFFSET.userCount)
  buf.writeUInt32LE(info.recordCount, FREE_SIZES_OFFSET.recordCount)
  buf.writeUInt32LE(info.recordCapacity, FREE_SIZES_OFFSET.recordCapacity)
  return buf
}
```

and register it in `baseHandlers`:
```ts
  [CMD.GET_FREE_SIZES]: (req, state) => [
    reply(state, req, CMD.ACK_OK, encodeFreeSizes(state.info)),
  ],
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run test/commands/info.spec.ts`
Expected: FAIL — cannot resolve `../../src/commands/info.js`.

- [ ] **Step 5: Write the implementation**

`src/commands/info.ts`:
```ts
import { CMD } from '../codec/commands.js'
import { ZkProtocolError } from '../errors.js'
import type { Session } from '../session/Session.js'
import type { ZkDeviceInfo } from '../types.js'

/**
 * Byte offsets of the counters inside the CMD_GET_FREE_SIZES reply body, which
 * is an array of little-endian uint32 values.
 *
 * NOT HARDWARE-VERIFIED. These come from protocol documentation and have never
 * been checked against a device. They live here as named constants, used by the
 * library and by the test emulator alike, so that one edit corrects them when
 * a real device contradicts them. See the first-hardware checklist in the spec.
 */
export const FREE_SIZES_OFFSET = {
  userCount: 16,
  recordCount: 32,
  recordCapacity: 64,
} as const

const REQUIRED_LENGTH = FREE_SIZES_OFFSET.recordCapacity + 4

/** Reads the device's own storage counters. */
export async function getInfo(session: Session): Promise<ZkDeviceInfo> {
  const res = await session.execute(CMD.GET_FREE_SIZES)
  if (res.data.length < REQUIRED_LENGTH) {
    throw new ZkProtocolError(
      `CMD_GET_FREE_SIZES reply is ${res.data.length} bytes, need at least ${REQUIRED_LENGTH}`,
      res.data,
    )
  }
  return {
    userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
    recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
    recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
  }
}
```

- [ ] **Step 6: Add the offsets to the spec's first-hardware checklist**

In `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`, §12, insert after item 3:

```markdown
4. Confirm the `CMD_GET_FREE_SIZES` field offsets in `src/commands/info.ts`
   (`FREE_SIZES_OFFSET`) against a real reply. They are documentation-derived
   and unverified; a wrong `recordCount` silently poisons the framing guard.
```

Renumber the items that follow.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run && pnpm typecheck`
Expected: everything green.

- [ ] **Step 8: Commit**

```bash
git add src/commands/info.ts src/types.ts test/emulator/index.ts test/commands/info.spec.ts docs/superpowers/specs
git commit -m "feat(commands): device storage counters"
```

---

## Task 16: Bulk read, legacy path

**Files:**
- Create: `src/session/dataRead.ts`
- Modify: `test/emulator/index.ts` (data-serving handlers)
- Test: `test/session/dataRead.legacy.spec.ts`

**Interfaces:**
- Consumes: `Session` (Task 12), `CMD`, `MAX_CHUNK` (Task 3), errors (Task 3).
- Produces: `readBulkLegacy(session: Session, command: number): Promise<Buffer>` — returns the concatenated data stream, which begins with its own 4-byte little-endian totalSize header.
- Emulator produces: `serveData(state, req, body): Buffer[]` and options `records`, `users`, `chunkSize`, `behavior: 'dropMidTransfer'`, `dropAfterChunk`.

The legacy exchange: send the read command; the device answers either `ACK_DATA` with the whole body inline, or `PREPARE_DATA` announcing a size followed by a run of `CMD_DATA` packets and a closing `ACK_OK`. Then `CMD_FREE_DATA` releases the device buffer.

- [ ] **Step 1: Extend the emulator to serve data**

Add to `EmulatorOptions`: `chunkSize?: number`. Add this helper and handlers to `test/emulator/index.ts`:

```ts
/** Prefixes a body with the 4-byte totalSize header the device sends. */
export function withSizeHeader(body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** Builds the attendance body the emulator was configured with. */
export function attendanceBody(records: EmulatorRecords): Buffer {
  const rows = Buffer.concat(records.rows)
  const prefixed = records.junkPrefix
    ? Buffer.concat([Buffer.from([0xff, 0x32, 0x35, 0x35, 0, 0, 0, 0, 0]), rows])
    : rows
  const head = Buffer.alloc(4)
  head.writeUInt32LE(records.totalSizeOverride ?? prefixed.length, 0)
  return Buffer.concat([head, prefixed])
}

/**
 * Answers a bulk-read command the legacy way: inline when the body is small,
 * otherwise PREPARE_DATA, a run of CMD_DATA chunks, and a closing ACK_OK.
 */
export function serveDataLegacy(
  state: EmulatorState,
  req: DecodedPacket,
  stream: Buffer,
): Buffer[] {
  const chunkSize = state.opts.chunkSize ?? 1024
  if (stream.length <= chunkSize) return [reply(state, req, CMD.ACK_DATA, stream)]

  const size = Buffer.alloc(4)
  size.writeUInt32LE(stream.length, 0)
  const out: Buffer[] = [reply(state, req, CMD.PREPARE_DATA, size)]
  for (let off = 0; off < stream.length; off += chunkSize) {
    state.chunksSent += 1
    if (
      state.opts.behavior === 'dropMidTransfer' &&
      state.chunksSent > (state.opts.dropAfterChunk ?? 1)
    ) {
      state.dropConnection = true
      return out
    }
    out.push(reply(state, req, CMD.DATA, stream.subarray(off, off + chunkSize)))
  }
  out.push(reply(state, req, CMD.ACK_OK))
  return out
}
```

Register in `baseHandlers`:
```ts
  [CMD.ATTLOG_RRQ]: (req, state) =>
    serveDataLegacy(state, req, state.records ? attendanceBody(state.records) : withSizeHeader(Buffer.alloc(0))),
  [CMD.USERTEMP_RRQ]: (req, state) =>
    serveDataLegacy(state, req, withSizeHeader(Buffer.concat(state.users.map((u) => Buffer.from(u.raw, 'hex'))))),
  [CMD.FREE_DATA]: (req, state) => [reply(state, req, CMD.ACK_OK)],
```

- [ ] **Step 2: Write the failing test**

`test/session/dataRead.legacy.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { readBulkLegacy } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkConnectionError, ZkProtocolError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** One 8-byte attendance record with the given uid. */
function rec8(uid: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  return b
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  const openSession = async (port: number): Promise<Session> => {
    const s = new Session(makeTransport(port), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  describe(`readBulkLegacy over ${transportKind}`, () => {
    it('returns an inline ACK_DATA body in one piece', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2)] },
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      const stream = await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(stream.readUInt32LE(0)).toBe(16)
      expect(stream.length).toBe(20)
    })

    it('reassembles a body delivered as several CMD_DATA chunks', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows },
        chunkSize: 32,
      })
      session = await openSession(running.port)
      const stream = await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(stream.readUInt32LE(0)).toBe(400)
      expect(stream.length).toBe(404)
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      await readBulkLegacy(session, CMD.ATTLOG_RRQ)
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })

    it('rejects when the device disconnects mid-transfer', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: 'tcp',
        records: { size: 8, rows },
        chunkSize: 32,
        behavior: 'dropMidTransfer',
        dropAfterChunk: 2,
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkConnectionError)
      session = null
    })

    it('throws when the device answers with something other than data', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: { [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkProtocolError)
    })

    it('throws when PREPARE_DATA does not carry a size', async () => {
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.ATTLOG_RRQ]: (req, state) => [reply(state, req, CMD.PREPARE_DATA, Buffer.alloc(2))],
        },
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkProtocolError)
    })
  })
}

// The drop-mid-transfer case is TCP-only: a UDP peer has no connection to drop.
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/session/dataRead.legacy.spec.ts`
Expected: FAIL — cannot resolve `../../src/session/dataRead.js`.

- [ ] **Step 4: Write the implementation**

`src/session/dataRead.ts`:
```ts
import { CMD } from '../codec/commands.js'
import { ZkProtocolError } from '../errors.js'
import type { Session } from './Session.js'

/**
 * Reads a bulk payload the legacy way, which older firmware understands.
 *
 * The device answers either ACK_DATA with the whole body inline, or
 * PREPARE_DATA announcing a size, then a run of CMD_DATA packets, then ACK_OK.
 * The returned stream begins with its own 4-byte little-endian totalSize
 * header — the record parsers expect that header and validate against it.
 */
export async function readBulkLegacy(session: Session, command: number): Promise<Buffer> {
  const res = await session.execute(command)

  if (res.command === CMD.ACK_DATA) {
    await freeBuffer(session)
    return res.data
  }

  if (res.command !== CMD.PREPARE_DATA) {
    throw new ZkProtocolError(
      `expected ACK_DATA or PREPARE_DATA for command ${command}, got ${res.command}`,
      res.data,
    )
  }
  if (res.data.length < 4) {
    throw new ZkProtocolError('PREPARE_DATA did not carry a size', res.data)
  }

  const declared = res.data.readUInt32LE(0)
  const chunks: Buffer[] = []
  let received = 0

  while (received < declared) {
    const packet = await session.receiveMore()
    if (packet.command === CMD.DATA) {
      chunks.push(packet.data)
      received += packet.data.length
      continue
    }
    throw new ZkProtocolError(
      `transfer ended after ${received} of ${declared} bytes with command ${packet.command}`,
    )
  }

  // The device closes the run with an acknowledgement.
  const tail = await session.receiveMore()
  if (tail.command !== CMD.ACK_OK) {
    throw new ZkProtocolError(`expected ACK_OK to close the transfer, got ${tail.command}`)
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}

async function freeBuffer(session: Session): Promise<void> {
  try {
    await session.execute(CMD.FREE_DATA)
  } catch {
    // Releasing the device-side buffer is best effort; failing to do so must
    // not discard data the caller already has in hand.
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/session/dataRead.legacy.spec.ts && pnpm typecheck`
Expected: 12 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/session/dataRead.ts test/emulator/index.ts test/session/dataRead.legacy.spec.ts
git commit -m "feat(session): legacy bulk read with chunk reassembly"
```

---

## Task 17: Bulk read, buffered path with fallback

**Files:**
- Modify: `src/session/dataRead.ts` (add `readBulkBuffered` and `readBulk`)
- Modify: `test/emulator/index.ts` (buffered-read handlers, `supportsBuffer`)
- Test: `test/session/dataRead.buffered.spec.ts`

**Interfaces:**
- Consumes: everything from Task 16.
- Produces:
  - `readBulkBuffered(session: Session, command: number, maxChunk: number): Promise<Buffer>`
  - `readBulk(session: Session, command: number, transport: 'tcp' | 'udp'): Promise<Buffer>` — tries the buffered path, falls back to legacy on `ZkProtocolError`.

`_CMD_PREPARE_BUFFER` (1503) and `_CMD_READ_BUFFER` (1504) are **not documented by the vendor**. The request shapes below come from the protocol write-ups referenced in the spec and are unverified. The fallback exists exactly because of that: a device that refuses them must still work.

- [ ] **Step 1: Extend the emulator**

Add to `test/emulator/index.ts`:

```ts
/** The body a buffered read is currently serving, keyed by nothing — one at a time. */
function bufferedStream(state: EmulatorState, command: number): Buffer {
  if (command === CMD.USERTEMP_RRQ) {
    return withSizeHeader(Buffer.concat(state.users.map((u) => Buffer.from(u.raw, 'hex'))))
  }
  return state.records ? attendanceBody(state.records) : withSizeHeader(Buffer.alloc(0))
}

const bufferedHandlers: HandlerTable = {
  [CMD.PREPARE_BUFFER]: (req, state) => {
    if (!state.supportsBuffer) return [reply(state, req, CMD.ACK_ERROR)]
    // Request body: <int8 1><int16 command><int32 fct><int32 ext>
    const command = req.data.readUInt16LE(1)
    state.pendingBuffer = bufferedStream(state, command)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(state.pendingBuffer.length, 0)
    return [reply(state, req, CMD.ACK_OK, size)]
  },
  [CMD.READ_BUFFER]: (req, state) => {
    if (!state.supportsBuffer || !state.pendingBuffer) {
      return [reply(state, req, CMD.ACK_ERROR)]
    }
    const offset = req.data.readUInt32LE(0)
    const want = req.data.readUInt32LE(4)
    state.chunksSent += 1
    if (
      state.opts.behavior === 'dropMidTransfer' &&
      state.chunksSent > (state.opts.dropAfterChunk ?? 1)
    ) {
      state.dropConnection = true
      return []
    }
    const slice = state.pendingBuffer.subarray(offset, offset + want)
    return [reply(state, req, CMD.ACK_DATA, slice)]
  },
}
```

Add `pendingBuffer: Buffer | null` to `EmulatorState` (initialised to `null` in `buildState`), and spread `bufferedHandlers` into `baseHandlers`.

- [ ] **Step 2: Write the failing test**

`test/session/dataRead.buffered.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { readBulk, readBulkBuffered } from '../../src/session/dataRead.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD, MAX_CHUNK } from '../../src/codec/commands.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

function rec8(uid: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  return b
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  const openSession = async (port: number): Promise<Session> => {
    const s = new Session(makeTransport(port), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  describe(`buffered bulk read over ${transportKind}`, () => {
    it('reads a body through PREPARE_BUFFER and READ_BUFFER', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2), rec8(3)] },
      })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream.readUInt32LE(0)).toBe(24)
      expect(stream.length).toBe(28)
    })

    it('requests successive offsets when the body exceeds one chunk', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows } })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)
      expect(stream.length).toBe(804)
      const reads = running.received.filter((p) => p.command === CMD.READ_BUFFER)
      expect(reads.length).toBeGreaterThan(1)
      expect(reads[1]!.data.readUInt32LE(0)).toBe(64)
    })

    it('sends the documented PREPARE_BUFFER request shape', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      const prepare = running.received.find((p) => p.command === CMD.PREPARE_BUFFER)!
      expect(prepare.data.length).toBe(11)
      expect(prepare.data.readUInt8(0)).toBe(1)
      expect(prepare.data.readUInt16LE(1)).toBe(CMD.ATTLOG_RRQ)
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })
  })

  describe(`readBulk dispatch over ${transportKind}`, () => {
    it('uses the buffered path when the device supports it', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1)] },
      })
      session = await openSession(running.port)
      await readBulk(session, CMD.ATTLOG_RRQ, transportKind)
      expect(running.received.map((p) => p.command)).toContain(CMD.PREPARE_BUFFER)
    })

    it('falls back to the legacy path when the device refuses PREPARE_BUFFER', async () => {
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows: [rec8(1), rec8(2)] },
        supportsBuffer: false,
        chunkSize: 4096,
      })
      session = await openSession(running.port)
      const stream = await readBulk(session, CMD.ATTLOG_RRQ, transportKind)
      expect(stream.readUInt32LE(0)).toBe(16)
      expect(running.received.map((p) => p.command)).toContain(CMD.ATTLOG_RRQ)
    })
  })
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/session/dataRead.buffered.spec.ts`
Expected: FAIL — `readBulkBuffered` is not exported.

- [ ] **Step 4: Extend `src/session/dataRead.ts`**

Append:
```ts
import { MAX_CHUNK } from '../codec/commands.js'

/**
 * Reads a bulk payload through the buffered commands.
 *
 * _CMD_PREPARE_BUFFER (1503) and _CMD_READ_BUFFER (1504) are undocumented by
 * the vendor. The request shapes here follow published protocol write-ups and
 * are unverified against hardware, which is exactly why `readBulk` keeps the
 * legacy path as a fallback rather than treating a refusal as fatal.
 */
export async function readBulkBuffered(
  session: Session,
  command: number,
  maxChunk: number,
): Promise<Buffer> {
  // <int8 1><int16 command><int32 fct><int32 ext>
  const request = Buffer.alloc(11)
  request.writeUInt8(1, 0)
  request.writeUInt16LE(command, 1)
  request.writeUInt32LE(0, 3)
  request.writeUInt32LE(0, 7)

  const prepared = await session.execute(CMD.PREPARE_BUFFER, request)
  if (prepared.data.length < 4) {
    throw new ZkProtocolError('PREPARE_BUFFER did not report a size', prepared.data)
  }
  const total = prepared.data.readUInt32LE(0)

  const chunks: Buffer[] = []
  let offset = 0
  while (offset < total) {
    const want = Math.min(maxChunk, total - offset)
    const req = Buffer.alloc(8)
    req.writeUInt32LE(offset, 0)
    req.writeUInt32LE(want, 4)
    const res = await session.execute(CMD.READ_BUFFER, req)
    if (res.data.length === 0) {
      throw new ZkProtocolError(`READ_BUFFER returned nothing at offset ${offset}`)
    }
    chunks.push(res.data)
    offset += res.data.length
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}

/**
 * Reads a bulk payload, preferring the buffered commands and falling back to
 * the legacy exchange when the device refuses them. Older firmware does not
 * implement 1503/1504 at all.
 */
export async function readBulk(
  session: Session,
  command: number,
  transport: 'tcp' | 'udp',
): Promise<Buffer> {
  try {
    return await readBulkBuffered(session, command, MAX_CHUNK[transport])
  } catch (err) {
    if (!(err instanceof ZkProtocolError)) throw err
    return readBulkLegacy(session, command)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/session && pnpm typecheck`
Expected: all session tests green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/session/dataRead.ts test/emulator/index.ts test/session/dataRead.buffered.spec.ts
git commit -m "feat(session): buffered bulk read with legacy fallback"
```

---

## Task 18: Read the user list

**Files:**
- Create: `src/commands/users.ts`
- Test: `test/commands/users.spec.ts`

**Interfaces:**
- Consumes: `readBulk` (Task 17), `parseUserData` (Task 8), `CMD` (Task 3).
- Produces: `getUsers(session: Session, transport: 'tcp' | 'udp'): Promise<ZkUser[]>`

- [ ] **Step 1: Write the failing test**

`test/commands/users.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { getUsers } from '../../src/commands/users.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** Builds an emulator user whose `raw` is the 72-byte record it serves. */
function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  const openSession = async (port: number): Promise<Session> => {
    const s = new Session(makeTransport(port), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  describe(`getUsers over ${transportKind}`, () => {
    it('decodes the enrolled users', async () => {
      running = await startEmulator({
        transport: transportKind,
        users: [emUser(1, '000123', 'Alice'), emUser(2, '007', 'Bob')],
      })
      session = await openSession(running.port)
      const users = await getUsers(session, transportKind)
      expect(users.map((u) => [u.uid, u.userId, u.name])).toEqual([
        [1, '000123', 'Alice'],
        [2, '007', 'Bob'],
      ])
    })

    it('returns an empty array on a device with nobody enrolled', async () => {
      running = await startEmulator({ transport: transportKind, users: [] })
      session = await openSession(running.port)
      expect(await getUsers(session, transportKind)).toEqual([])
    })
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/commands/users.spec.ts`
Expected: FAIL — cannot resolve `../../src/commands/users.js`.

- [ ] **Step 3: Write the implementation**

`src/commands/users.ts`:
```ts
import { CMD } from '../codec/commands.js'
import { parseUserData } from '../codec/records/user.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkUser } from '../types.js'

/**
 * Reads the enrolled user list.
 *
 * This is not an optional convenience: the 8- and 16-byte attendance dialects
 * carry no printed user id, so resolving a punch to a person depends on it.
 */
export async function getUsers(
  session: Session,
  transport: 'tcp' | 'udp',
): Promise<ZkUser[]> {
  const stream = await readBulk(session, CMD.USERTEMP_RRQ, transport)
  return parseUserData(stream)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/commands/users.spec.ts && pnpm typecheck`
Expected: 4 passing, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/users.ts test/commands/users.spec.ts
git commit -m "feat(commands): read the enrolled user list"
```

---

## Task 19: Read attendance logs and resolve identities

**Files:**
- Create: `src/commands/attendance.ts`
- Test: `test/commands/attendance.spec.ts`

**Interfaces:**
- Consumes: `getInfo` (Task 15), `getUsers` (Task 18), `readBulk` (Task 17), `parseAttendanceData` (Task 7).
- Produces:
  - `interface GetAttendanceOptions { since?: ZkNaiveTime; resolveUserIds?: boolean }`
  - `getAttendanceLogs(session: Session, transport: 'tcp' | 'udp', opts?: GetAttendanceOptions): Promise<ZkAttendanceLog[]>`

Read spec §4.2 and §4.3 before starting. Two behaviours matter more than the happy path: an identity is **never fabricated**, and `since` is a client-side filter that must be documented as one.

- [ ] **Step 1: Write the failing test**

`test/commands/attendance.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { getAttendanceLogs } from '../../src/commands/attendance.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { decodeZkTime } from '../../src/codec/time.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { ZkFramingError } from '../../src/errors.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const DAY = 86_400

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'ascii')
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt32LE(t, 27)
  return b
}

function rec16(numericUserId: number, t: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(numericUserId, 0)
  b.writeUInt32LE(t, 4)
  return b
}

function rec8(uid: number, t: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0)
  b.writeUInt32LE(t, 3)
  return b
}

for (const transportKind of ['tcp', 'udp'] as const) {
  const makeTransport = (port: number) =>
    transportKind === 'tcp'
      ? new TcpTransport({ host: '127.0.0.1', port })
      : new UdpTransport({ host: '127.0.0.1', port })

  const openSession = async (port: number): Promise<Session> => {
    const s = new Session(makeTransport(port), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  describe(`getAttendanceLogs over ${transportKind}`, () => {
    it('marks 40-byte identities as coming from the device', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(5, '000123', DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({
        userId: '000123', userIdSource: 'device', uid: 5, recordSize: 40,
      })
      expect(log!.timestamp.local).toBe('2000-01-02T00:00:00')
    })

    it('resolves an 8-byte record through the user list and says so', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '000777', 'Carol')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '000777', userIdSource: 'lookup', uid: 9 })
    })

    it('resolves a 16-byte record by numeric id while preserving leading zeros', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(1, '007', 'Bob')],
        records: { size: 16, rows: [rec16(7, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '007', userIdSource: 'lookup' })
    })

    it('returns null rather than inventing an identity it cannot resolve', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        users: [],
        records: { size: 8, rows: [rec8(99, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null, uid: 99 })
    })

    it('skips the user lookup entirely when resolveUserIds is false', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '000777', 'Carol')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind, { resolveUserIds: false })
      expect(log).toMatchObject({ userId: null, userIdSource: null })
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('never looks up users for the 40-byte dialect', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(5, 'ignored', 'X')],
        records: { size: 40, rows: [rec40(5, '000123', DAY)] },
      })
      session = await openSession(running.port)
      await getAttendanceLogs(session, transportKind)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('returns an empty array without issuing a read on an empty buffer', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 0, recordCapacity: 1000 },
      })
      session = await openSession(running.port)
      expect(await getAttendanceLogs(session, transportKind)).toEqual([])
      expect(running.received.map((p) => p.command)).not.toContain(CMD.ATTLOG_RRQ)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.PREPARE_BUFFER)
    })

    it('filters client-side on `since`, inclusive of the boundary', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 3, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY), rec40(1, 'A', 2 * DAY), rec40(1, 'A', 3 * DAY)] },
      })
      session = await openSession(running.port)
      const logs = await getAttendanceLogs(session, transportKind, { since: decodeZkTime(2 * DAY) })
      expect(logs.map((l) => l.timestamp.local)).toEqual([
        '2000-01-03T00:00:00', '2000-01-04T00:00:00',
      ])
    })

    it('throws instead of parsing when the framing does not add up', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 3, recordCapacity: 1000 },
        // Two records on the wire, three claimed by the counter.
        records: { size: 8, rows: [rec8(1, 0), rec8(2, 0)] },
      })
      session = await openSession(running.port)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toBeInstanceOf(ZkFramingError)
    })

    it('skips a junk prefix on the 40-byte dialect', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(3, 'Z9', DAY)], junkPrefix: true },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: 'Z9', uid: 3 })
    })

    it('attaches raw hex to every record', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log!.raw).toMatch(/^[0-9a-f]{80}$/)
    })
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/commands/attendance.spec.ts`
Expected: FAIL — cannot resolve `../../src/commands/attendance.js`.

- [ ] **Step 3: Write the implementation**

`src/commands/attendance.ts`:
```ts
import { CMD } from '../codec/commands.js'
import { parseAttendanceData, type DecodedAttendanceRecord } from '../codec/records/attendance.js'
import { readBulk } from '../session/dataRead.js'
import type { Session } from '../session/Session.js'
import type { ZkAttendanceLog, ZkNaiveTime, ZkUser } from '../types.js'
import { getInfo } from './info.js'
import { getUsers } from './users.js'

export interface GetAttendanceOptions {
  /**
   * Drops records earlier than this, INCLUSIVE of the boundary.
   *
   * CLIENT-SIDE FILTER. The protocol has no "read from timestamp X" capability
   * — the device returns its entire buffer and the filtering happens here,
   * after everything has been downloaded. On a device holding 100,000 records
   * every call re-reads all of them, so a short poll interval will keep the
   * terminal busy and slow to respond to the people badging at it. Poll on the
   * order of minutes, not seconds.
   */
  since?: ZkNaiveTime

  /**
   * Resolve the printed user id for the 8- and 16-byte dialects by also
   * reading the user list. Defaults to true. Turning it off saves one device
   * round-trip and leaves `userId` null for those dialects.
   */
  resolveUserIds?: boolean
}

/** Naive times sort correctly as strings — the format is fixed-width. */
function isAtOrAfter(a: ZkNaiveTime, boundary: ZkNaiveTime): boolean {
  return a.local >= boundary.local
}

function resolve(
  record: DecodedAttendanceRecord,
  byUid: Map<number, ZkUser>,
  byNumericUserId: Map<number, ZkUser>,
): Pick<ZkAttendanceLog, 'userId' | 'userIdSource'> {
  if (record.userIdFromRecord !== null) {
    return { userId: record.userIdFromRecord, userIdSource: 'device' }
  }
  const match =
    record.uid !== null
      ? byUid.get(record.uid)
      : record.numericUserId !== null
        ? byNumericUserId.get(record.numericUserId)
        : undefined
  // No match means no identity. Never fabricate one — a null beats a name that
  // belongs to somebody else.
  return match ? { userId: match.userId, userIdSource: 'lookup' } : { userId: null, userIdSource: null }
}

/** Reads the attendance log. */
export async function getAttendanceLogs(
  session: Session,
  transport: 'tcp' | 'udp',
  opts: GetAttendanceOptions = {},
): Promise<ZkAttendanceLog[]> {
  // The record count is needed before anything else: the framing guard divides
  // by it, and a freshly installed device must not be sent a read at all.
  const { recordCount } = await getInfo(session)
  if (recordCount === 0) return []

  const stream = await readBulk(session, CMD.ATTLOG_RRQ, transport)
  const records = parseAttendanceData(stream, recordCount)

  const needsLookup =
    opts.resolveUserIds !== false && records.some((r) => r.userIdFromRecord === null)
  const users = needsLookup ? await getUsers(session, transport) : []
  const byUid = new Map(users.map((u) => [u.uid, u]))
  // The 16-byte dialect carries a numeric user id, so match on the numeric
  // value of the printed one. Leading zeros survive because the string from
  // the user list is what gets returned.
  const byNumericUserId = new Map(
    users.filter((u) => /^\d+$/.test(u.userId)).map((u) => [Number(u.userId), u]),
  )

  const logs: ZkAttendanceLog[] = records.map((r) => ({
    ...resolve(r, byUid, byNumericUserId),
    uid: r.uid,
    timestamp: r.timestamp,
    status: r.status,
    verifyMode: r.verifyMode,
    recordSize: r.recordSize,
    raw: r.raw,
  }))

  const since = opts.since
  return since ? logs.filter((l) => isAtOrAfter(l.timestamp, since)) : logs
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/commands/attendance.spec.ts && pnpm typecheck`
Expected: 22 passing (11 scenarios × 2 transports), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/attendance.ts test/commands/attendance.spec.ts
git commit -m "feat(commands): read attendance logs with identity provenance"
```

---

## Task 20: The `ZkDevice` facade, public exports, and the dual build

**Files:**
- Create: `src/ZkDevice.ts`, `tsup.config.ts`
- Modify: `src/index.ts`
- Test: `test/ZkDevice.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface ZkDeviceOptions { host: string; port?: number; transport?: 'tcp' | 'udp'; commKey?: number; timeoutMs?: number }`
  - `class ZkDevice { connect(): Promise<void>; getInfo(): Promise<ZkDeviceInfo>; getUsers(): Promise<ZkUser[]>; getAttendanceLogs(opts?: GetAttendanceOptions): Promise<ZkAttendanceLog[]>; disconnect(): Promise<void> }`
  - `src/index.ts` exports `ZkDevice`, every option and result type, every error class, and the `decodeZkTime` helper.

- [ ] **Step 1: Write the failing test**

`test/ZkDevice.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { ZkDevice } from '../src/ZkDevice.js'
import { ZkConnectionError } from '../src/errors.js'
import { startEmulator, type Emulator } from './emulator/index.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
afterEach(async () => {
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

const DAY = 86_400

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'ascii')
  b.writeUInt32LE(t, 27)
  return b
}

for (const transport of ['tcp', 'udp'] as const) {
  describe(`ZkDevice over ${transport}`, () => {
    it('connects, reads counters, reads logs, disconnects', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 3, recordCount: 1, recordCapacity: 100_000 },
        records: { size: 40, rows: [rec40(1, '000123', DAY)] },
      })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      expect(await device.getInfo()).toEqual({
        userCount: 3, recordCount: 1, recordCapacity: 100_000,
      })
      const logs = await device.getAttendanceLogs()
      expect(logs[0]).toMatchObject({ userId: '000123', userIdSource: 'device' })
      await device.disconnect()
      device = null
    })

    it('is safe to disconnect twice', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      await device.disconnect()
      await expect(device.disconnect()).resolves.toBeUndefined()
      device = null
    })

    it('is safe to disconnect without ever connecting', async () => {
      device = new ZkDevice({ host: '127.0.0.1', port: 4370, transport })
      await expect(device.disconnect()).resolves.toBeUndefined()
      device = null
    })

    it('refuses to run a command before connect', async () => {
      running = await startEmulator({ transport })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await expect(device.getInfo()).rejects.toBeInstanceOf(ZkConnectionError)
      device = null
    })
  })
}

describe('ZkDevice defaults', () => {
  it('defaults to the TCP transport', async () => {
    running = await startEmulator({ transport: 'tcp' })
    // Explicit port so the test can reach the emulator; transport is left out.
    device = new ZkDevice({ host: '127.0.0.1', port: running.port })
    await device.connect()
    expect(running.transport).toBe('tcp')
    await device.disconnect()
    device = null
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/ZkDevice.spec.ts`
Expected: FAIL — cannot resolve `../src/ZkDevice.js`.

- [ ] **Step 3: Write `src/ZkDevice.ts`**

```ts
import { getAttendanceLogs, type GetAttendanceOptions } from './commands/attendance.js'
import { getInfo } from './commands/info.js'
import { getUsers } from './commands/users.js'
import { ZkConnectionError } from './errors.js'
import { Session } from './session/Session.js'
import { TcpTransport } from './transport/tcp.js'
import { UdpTransport } from './transport/udp.js'
import type { Transport } from './transport/Transport.js'
import type { ZkAttendanceLog, ZkDeviceInfo, ZkUser } from './types.js'

export interface ZkDeviceOptions {
  host: string
  /** Defaults to 4370. */
  port?: number
  /**
   * Defaults to 'tcp'. TCP frames packets with a length prefix, so it is the
   * more reliable of the two; UDP is a fallback for firmware that needs it.
   */
  transport?: 'tcp' | 'udp'
  /** Device comm key. 0, the default, means unset. */
  commKey?: number
  /** Per-request deadline. Defaults to 5000ms. */
  timeoutMs?: number
}

export class ZkDevice {
  private session: Session | null = null
  private readonly host: string
  private readonly port: number
  private readonly transportKind: 'tcp' | 'udp'
  private readonly commKey: number
  private readonly timeoutMs: number

  constructor(opts: ZkDeviceOptions) {
    this.host = opts.host
    this.port = opts.port ?? 4370
    this.transportKind = opts.transport ?? 'tcp'
    this.commKey = opts.commKey ?? 0
    this.timeoutMs = opts.timeoutMs ?? 5_000
  }

  private makeTransport(): Transport {
    const opts = { host: this.host, port: this.port }
    return this.transportKind === 'tcp' ? new TcpTransport(opts) : new UdpTransport(opts)
  }

  private requireSession(): Session {
    if (!this.session) throw new ZkConnectionError('not connected — call connect() first')
    return this.session
  }

  /** Handshakes, authenticating with the comm key when the device asks. */
  async connect(): Promise<void> {
    const session = new Session(this.makeTransport(), {
      timeoutMs: this.timeoutMs,
      commKey: this.commKey,
    })
    await session.open()
    this.session = session
  }

  async getInfo(): Promise<ZkDeviceInfo> {
    return getInfo(this.requireSession())
  }

  async getUsers(): Promise<ZkUser[]> {
    return getUsers(this.requireSession(), this.transportKind)
  }

  /**
   * Reads the attendance log.
   *
   * The device is never disabled first. Many implementations send
   * CMD_DISABLEDEVICE before a bulk read so the buffer cannot shift
   * mid-transfer; on a polling schedule that locks employees out of badging
   * every cycle. The interleaved-write risk is accepted instead, and the
   * framing guard refuses anything that does not add up.
   */
  async getAttendanceLogs(opts?: GetAttendanceOptions): Promise<ZkAttendanceLog[]> {
    return getAttendanceLogs(this.requireSession(), this.transportKind, opts)
  }

  /** Closes the session. Safe to call twice, and safe before connect(). */
  async disconnect(): Promise<void> {
    const session = this.session
    this.session = null
    if (session) await session.close()
  }
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
export { ZkDevice, type ZkDeviceOptions } from './ZkDevice.js'
export type { GetAttendanceOptions } from './commands/attendance.js'
export type {
  ZkAttendanceLog,
  ZkDeviceInfo,
  ZkNaiveTime,
  ZkUser,
} from './types.js'
export {
  ZkAuthError,
  ZkConnectionError,
  ZkError,
  ZkFramingError,
  ZkProtocolError,
  ZkTimeoutError,
} from './errors.js'
export { decodeZkTime, decodeZkTime6 } from './codec/time.js'

export const VERSION = '0.1.0'
```

- [ ] **Step 5: Write `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
})
```

- [ ] **Step 6: Verify the build ships no dependencies**

Run:
```bash
pnpm build
node -e "const m=require('./dist/index.cjs'); if(typeof m.ZkDevice!=='function') throw new Error('CJS export missing'); console.log('cjs ok')"
node --input-type=module -e "import('./dist/index.js').then(m=>{if(typeof m.ZkDevice!=='function')throw new Error('ESM export missing');console.log('esm ok')})"
node -e "const p=require('./package.json'); if(Object.keys(p.dependencies).length) throw new Error('runtime dependencies crept in'); console.log('zero deps ok')"
```
Expected: `cjs ok`, `esm ok`, `zero deps ok`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: everything green.

- [ ] **Step 8: Commit**

```bash
git add src/ZkDevice.ts src/index.ts tsup.config.ts test/ZkDevice.spec.ts
git commit -m "feat: ZkDevice facade, public exports, dual ESM/CJS build"
```

---

## Task 21: End-to-end scenario suite

**Files:**
- Create: `test/scenarios.spec.ts`

**Interfaces:**
- Consumes: `ZkDevice` (Task 20), emulator (Tasks 9, 14–17).
- Produces: nothing new — this task proves the ten scenarios of spec §7.2 hold through the **public** surface, over both transports.

Everything so far tested a layer. This tests the thing that ships.

- [ ] **Step 1: Write the suite**

`test/scenarios.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { ZkDevice } from '../src/ZkDevice.js'
import { ZkAuthError, ZkFramingError, ZkTimeoutError } from '../src/errors.js'
import { USER_RECORD_SIZE } from '../src/codec/records/user.js'
import { startEmulator, type Emulator } from './emulator/index.js'
import type { ZkUser } from '../src/types.js'

let running: Emulator | null = null
let device: ZkDevice | null = null
afterEach(async () => {
  await device?.disconnect().catch(() => {}); device = null
  await running?.close(); running = null
})

const DAY = 86_400

function emUser(uid: number, userId: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 48, 8, 'ascii')
  return { uid, userId, name: 'N', privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0); b.write(userId, 2, 24, 'ascii'); b.writeUInt32LE(t, 27)
  return b
}
function rec16(numericUserId: number, t: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(numericUserId, 0); b.writeUInt32LE(t, 4)
  return b
}
function rec8(uid: number, t: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(uid, 0); b.writeUInt32LE(t, 3)
  return b
}

for (const transport of ['tcp', 'udp'] as const) {
  describe(`scenarios over ${transport}`, () => {
    const connect = async (emulator: Emulator, commKey?: number): Promise<ZkDevice> => {
      const d = new ZkDevice({
        host: '127.0.0.1', port: emulator.port, transport, commKey, timeoutMs: 2000,
      })
      await d.connect()
      return d
    }

    // 1. Handshake, with and without auth.
    it('handshakes on a device that needs no comm key', async () => {
      running = await startEmulator({ transport })
      device = await connect(running)
      expect(device).toBeInstanceOf(ZkDevice)
    })

    it('handshakes with the right comm key and refuses the wrong one', async () => {
      running = await startEmulator({ transport, commKey: 1234 })
      device = await connect(running, 1234)
      await device.disconnect()
      device = null

      const wrong = new ZkDevice({
        host: '127.0.0.1', port: running.port, transport, commKey: 4321, timeoutMs: 2000,
      })
      await expect(wrong.connect()).rejects.toBeInstanceOf(ZkAuthError)
    })

    // 2. All three record dialects.
    it.each([
      ['40-byte', { size: 40 as const, rows: [rec40(1, '000123', DAY)] }, [] as ZkUser[], '000123', 'device'],
      ['16-byte', { size: 16 as const, rows: [rec16(7, DAY)] }, [emUser(1, '007')], '007', 'lookup'],
      ['8-byte', { size: 8 as const, rows: [rec8(9, DAY)] }, [emUser(9, '000777')], '000777', 'lookup'],
    ])('reads the %s dialect', async (_name, records, users, expectedId, expectedSource) => {
      running = await startEmulator({
        transport, users,
        info: { userCount: users.length, recordCount: 1, recordCapacity: 1000 },
        records,
      })
      device = await connect(running)
      const [log] = await device.getAttendanceLogs()
      expect(log).toMatchObject({ userId: expectedId, userIdSource: expectedSource })
    })

    // 3. Multi-chunk read.
    it('reads a body far larger than one chunk', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => rec40(i + 1, `U${i + 1}`, DAY))
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 500, recordCapacity: 100_000 },
        records: { size: 40, rows },
      })
      device = await connect(running)
      const logs = await device.getAttendanceLogs()
      expect(logs).toHaveLength(500)
      expect(logs[499]!.userId).toBe('U500')
    })

    // 4. Empty buffer.
    it('returns an empty array on a freshly installed device', async () => {
      running = await startEmulator({
        transport, info: { userCount: 0, recordCount: 0, recordCapacity: 100_000 },
      })
      device = await connect(running)
      expect(await device.getAttendanceLogs()).toEqual([])
    })

    // 5. Framing guard.
    it('throws rather than parsing when the record count and body disagree', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 7, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, 0), rec8(2, 0)] },
      })
      device = await connect(running)
      await expect(device.getAttendanceLogs()).rejects.toBeInstanceOf(ZkFramingError)
    })

    // 7. Silent device.
    it('times out on a silent device instead of hanging', async () => {
      running = await startEmulator({ transport, behavior: 'silent' })
      const d = new ZkDevice({
        host: '127.0.0.1', port: running.port, transport, timeoutMs: 200,
      })
      await expect(d.connect()).rejects.toBeInstanceOf(ZkTimeoutError)
    })

    // 8. Junk prefix.
    it('skips a junk prefix on the 40-byte dialect', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(3, 'Z9', DAY)], junkPrefix: true },
      })
      device = await connect(running)
      expect((await device.getAttendanceLogs())[0]).toMatchObject({ userId: 'Z9' })
    })

    // 10. Time boundaries, end to end.
    it('decodes boundary timestamps without normalising them', async () => {
      const rows = [
        rec40(1, 'A', 0),                       // 2000-01-01, the power-loss reset
        rec40(2, 'B', 30 * DAY),                // day 31 of the pseudo-calendar
        rec40(3, 'C', 31 * DAY + 30 * DAY),     // February 31st: does not exist
        rec40(4, 'D', 12 * 31 * DAY),           // year rollover
      ]
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 4, recordCapacity: 1000 },
        records: { size: 40, rows },
      })
      device = await connect(running)
      const logs = await device.getAttendanceLogs()
      expect(logs.map((l) => l.timestamp.local)).toEqual([
        '2000-01-01T00:00:00',
        '2000-01-31T00:00:00',
        '2000-02-31T00:00:00',
        '2001-01-01T00:00:00',
      ])
    })

    it('never returns a Date', async () => {
      running = await startEmulator({
        transport,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 40, rows: [rec40(1, 'A', DAY)] },
      })
      device = await connect(running)
      const [log] = await device.getAttendanceLogs()
      expect(log!.timestamp).not.toBeInstanceOf(Date)
      expect(JSON.parse(JSON.stringify(log)).timestamp.local).toBe('2000-01-02T00:00:00')
    })
  })
}

// 6. Device disconnects mid-transfer. TCP only — a UDP peer has no connection
//    to drop, so the scenario does not exist there.
describe('scenarios over tcp only', () => {
  it('surfaces an error when the device disconnects mid-transfer', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => rec40(i + 1, `U${i + 1}`, DAY))
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 0, recordCount: 500, recordCapacity: 100_000 },
      records: { size: 40, rows },
      behavior: 'dropMidTransfer',
      dropAfterChunk: 1,
    })
    device = new ZkDevice({ host: '127.0.0.1', port: running.port, timeoutMs: 2000 })
    await device.connect()
    await expect(device.getAttendanceLogs()).rejects.toThrow()
    device = null
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: everything green. If the multi-chunk scenario is slow, raise `testTimeout` in `vitest.config.ts` rather than shrinking the fixture — the point of that test is that the chunk loop actually runs.

- [ ] **Step 3: Commit**

```bash
git add test/scenarios.spec.ts
git commit -m "test: end-to-end scenario suite across both transports"
```

---

## Task 22: Documentation, provenance, CI, and the device report template

**Files:**
- Create: `README.md`, `PROVENANCE.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/device-report.yml`
- Modify: `package.json` (repository, keywords)

**Interfaces:**
- Consumes: the finished library.
- Produces: the published surface of the project.

- [ ] **Step 1: Write `README.md`**

The banner comes first, before badges, before the example. Copy it verbatim from spec §9.3.

````markdown
# zkteco-protocol

Dependency-free TypeScript client for the ZKTeco binary protocol on port 4370.
Reads attendance logs and the user list over LAN, with types that tell the truth
about what the protocol actually guarantees.

> **⚠ Not hardware-verified.** No physical ZKTeco device has ever been tested
> against this library. Every byte layout here is a hypothesis derived from
> published protocol documentation and cross-checked against two independent
> implementations. Treat readings as unverified until your model appears in the
> table below — and if you have a device, [a report](../../issues/new?template=device-report.yml)
> is the single most useful thing you can contribute.

## Install

```bash
npm install zkteco-protocol
```

Node 20.19 or newer. No runtime dependencies — just `node:net` and `node:dgram`.

## Usage

```ts
import { ZkDevice } from 'zkteco-protocol'

const dev = new ZkDevice({
  host: '192.168.1.201',
  port: 4370,        // default
  transport: 'tcp',  // 'tcp' | 'udp' — default 'tcp'
  commKey: 0,        // 0 means unset
  timeoutMs: 5_000,
})

await dev.connect()
const info = await dev.getInfo()   // { userCount, recordCount, recordCapacity }
const logs = await dev.getAttendanceLogs()
await dev.disconnect()
```

## Two things worth knowing before you use this

### Timestamps are naive, and stay that way

Devices record wall-clock time with no offset and no zone. This library returns
`ZkNaiveTime`, never a JavaScript `Date`:

```ts
{ year: 2026, month: 8, day: 27, hour: 8, minute: 1, second: 0,
  local: '2026-08-27T08:01:00' }
```

A `Date` would bind that reading to whatever timezone the decoding process
happens to run in — right by accident on a machine near the device, hours wrong
in CI, and silent either way. Apply a timezone yourself, deliberately.

The packed calendar the device uses has 31-day months, so a decoded reading can
legitimately be `2026-02-31`. That is returned as-is rather than normalised; a
`Date` would have slid it quietly to 3 March.

### `since` is a client-side filter, not a device capability

```ts
await dev.getAttendanceLogs({ since })
```

The protocol has no "read from timestamp X". The device returns its **entire**
buffer and the filtering happens here. On a device holding 100,000 records,
every call re-reads all of them, so poll on the order of minutes. A ten-second
poll will keep the terminal too busy to respond to the people badging at it.

## Identity, and why `userId` can be null

40-byte records carry the printed user id. The 8- and 16-byte dialects do not,
so it is resolved through the user list — and that resolution can be wrong,
because device-internal `uid` values are recycled when a user is deleted. Every
record says where its identity came from:

| `userIdSource` | Meaning |
|---|---|
| `'device'` | The record carried it. Trustworthy. |
| `'lookup'` | Resolved through the user list. May be wrong if the uid was recycled. |
| `null` | Not determined. `userId` is `null` — never a guess. |

`status` and `verifyMode` are returned as raw numbers. Their meanings differ
between models, and decoding them would produce data that is confidently wrong.

## Device compatibility

| Model | Firmware | Transport | Record size | Verified by | Date |
|---|---|---|---|---|---|
| *(none yet)* | | | | | |

## Credits

Protocol documentation: [adrobinoga/zk-protocol](https://github.com/adrobinoga/zk-protocol).
Cross-referenced against [zkteco-js](https://github.com/coding-libs/zkteco-js) (MIT).
See [PROVENANCE.md](PROVENANCE.md) for exactly how each source was used — and
for why no `pyzk` code appears here.

## License

MIT
````

- [ ] **Step 2: Write `PROVENANCE.md`**

```markdown
# Provenance

This library was written without access to a ZKTeco device. This file records
exactly which sources informed it and how, so anyone can judge how much to
trust it — and so its licensing position is checkable rather than asserted.

## Verification level

**`docs`.** Every byte layout is documentation-derived and cross-checked
against two independent implementations. None has been confirmed against
hardware. The README carries this warning where users will see it.

## Sources

| Source | License | How it was used |
|---|---|---|
| [adrobinoga/zk-protocol](https://github.com/adrobinoga/zk-protocol) | none | Principal specification. Read for understanding and restated in our own words; no prose was copied, since the repository carries no license. |
| ZK Communication Protocol Manual (vendor PDF) | vendor | Command tables, cross-reference. |
| [ZKTeco/Standalone-SDK](https://github.com/ZKTeco/Standalone-SDK) | none | Lookup only. No code taken. |
| [Securelist analysis](https://securelist.com/biometric-terminal-vulnerabilities/112800/) | article | Packet structure from a security-research perspective, used to cross-check. |
| [zkteco-js](https://github.com/coding-libs/zkteco-js) | MIT | Oracle, and code-level reference. Attributed in the README. |
| [pyzk](https://github.com/fananimi/pyzk) | **GPL-2.0** | **Black-box execution only.** See below. |

## The pyzk boundary

`pyzk` is GPL-2.0. **No file of its source has been opened, read, translated,
or paraphrased.** None of its function structure, naming, or control flow
appears here. It is not a dependency of this package in any form and is never
distributed with it.

It was used in exactly one way: executed as a separate process against the test
emulator in `test/emulator/`, with the bytes it put on the socket recorded as
fixtures under `test/fixtures/oracle/`.

That is observation, not copying. GPL-2.0 §0 restricts copying, distribution and
modification — not execution — and covers a program's output only where that
output is itself a work based on the program. Protocol bytes are dictated by the
device manufacturer; any correct implementation emits the same ones.

Copyright protects expression, not facts. Command numbers, byte layouts and
checksum formulas are facts about the protocol. The code and prose expressing
them are not, and none was taken.

## Known divergences

Where the two oracles disagreed about what devices expect, the disagreement is
recorded here rather than silently resolved in favour of one.

*(none recorded yet)*
```

- [ ] **Step 3: Write `CONTRIBUTING.md`**

````markdown
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
````

- [ ] **Step 4: Write `.github/ISSUE_TEMPLATE/device-report.yml`**

```yaml
name: Device report
description: Report how this library behaved against a real ZKTeco device
title: "[device] "
labels: ["device-report"]
body:
  - type: markdown
    attributes:
      value: |
        Thank you. This is the most useful contribution this project can
        receive — the compatibility table is empty until reports like yours
        fill it in.
  - type: input
    id: model
    attributes:
      label: Model
      placeholder: e.g. MB360, iClock260, K40
    validations:
      required: true
  - type: input
    id: firmware
    attributes:
      label: Firmware version
      description: Usually under Menu → System Info on the device.
    validations:
      required: true
  - type: dropdown
    id: transport
    attributes:
      label: Transport that worked
      options: ["tcp", "udp", "both", "neither"]
    validations:
      required: true
  - type: dropdown
    id: record_size
    attributes:
      label: Record size reported
      description: The `recordSize` field on any returned log.
      options: ["8", "16", "40", "it threw ZkFramingError", "did not get that far"]
    validations:
      required: true
  - type: dropdown
    id: comm_key
    attributes:
      label: Did the device require a comm key?
      options: ["no", "yes, and it worked", "yes, and it was rejected"]
    validations:
      required: true
  - type: textarea
    id: raw
    attributes:
      label: Raw hex of one attendance record
      description: >
        The `raw` field from any log entry. Please redact nothing — it contains
        no personal data beyond a user id, and the byte layout is the whole
        point of the report.
      render: text
  - type: textarea
    id: notes
    attributes:
      label: Anything else
      description: Timestamps off? Names garbled? Errors thrown? Paste them here.
```

- [ ] **Step 5: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    # This library sits directly on node:net and node:dgram, whose behaviour
    # differs across platforms in ECONNRESET timing and TCP segmentation, so
    # Windows is tested for real rather than for completeness.
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['20.19', '22', '24']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 6: Add repository metadata to `package.json`**

```json
  "repository": { "type": "git", "url": "git+https://github.com/ChuKhaLi/zkteco-protocol.git" },
  "homepage": "https://github.com/ChuKhaLi/zkteco-protocol#readme",
  "bugs": { "url": "https://github.com/ChuKhaLi/zkteco-protocol/issues" },
  "keywords": ["zkteco", "attendance", "biometric", "protocol", "4370", "time-clock"],
```

- [ ] **Step 7: Verify the package contents**

Run: `pnpm pack --dry-run`
Expected: `dist/`, `README.md`, `LICENSE`, `PROVENANCE.md` — and **nothing** from `tools/`, `test/`, or `docs/`.

- [ ] **Step 8: Run everything once more**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add README.md PROVENANCE.md CONTRIBUTING.md .github package.json
git commit -m "docs: README, provenance, contributing guide, CI, device report template"
```

- [ ] **Step 10: Stop here**

Do **not** run `npm publish`, and do not create the GitHub repository without
being asked. Publication is an outward-facing, effectively irreversible action —
npm restricts unpublishing after 72 hours — and it is a separate decision taken
after this plan completes. Report that the library is built, tested, and ready,
and let the human decide whether it ships now or waits for hardware.
