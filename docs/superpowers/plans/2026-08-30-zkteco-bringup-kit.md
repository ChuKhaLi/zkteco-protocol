# First-Hardware Bring-Up Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tracing decorator and a read-only CLI probe so that the first hour with a real ZKTeco terminal produces a shareable evidence report instead of a hand-correlated Wireshark session.

**Architecture:** A `TracingTransport` decorator wraps the existing `Transport` interface and records every payload. A pure `probe` module walks the 23-item first-hardware checklist using the library's existing reads, isolating each step so one refusal cannot end the run. A pure `report` module renders two artifacts — a redacted shareable report and an opt-in unredacted raw capture. `src/cli.ts` is the only impure module: it owns argument parsing, the clock, and the filesystem.

**Tech Stack:** TypeScript 5.7, Node >= 20.19, ESM, vitest 2.1, tsup 8.3. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md` — read it before starting. Every task below argues from it.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Argument parsing uses `node:util`'s `parseArgs`. Adding any package to `dependencies` fails the task.
- **`Date.now()`, `new Date()`, `process.*` and all filesystem access appear ONLY in `src/cli.ts`.** `probe.ts`, `report.ts`, `TracingTransport.ts` and `types.ts` take clock values as parameters and return data. This is what makes every test below deterministic.
- **The probe may never send a write command.** Allowlist: `CONNECT` 1000, `EXIT` 1001, `AUTH` 1102, `OPTIONS_RRQ` 11, `GET_TIME` 201, `GET_VERSION` 1100, `GET_FREE_SIZES` 50, `USERTEMP_RRQ` 9, `ATTLOG_RRQ` 13, `FREE_DATA` 1502, `PREPARE_BUFFER` 1503, `READ_BUFFER` 1504, `REG_EVENT` 500. `ENABLEDEVICE` 1002 and `DISABLEDEVICE` 1003 are forbidden by name.
- **`src/index.ts` must never import anything under `src/diagnostics/` or `src/cli.ts`.** The library bundle stays free of tool code.
- **Strings decode as `latin1`, never `ascii`.** latin1 is byte-preserving; ascii strips the high bit, which would destroy the item-20 encoding evidence before anyone could look at it.
- **TDD is mandatory.** Write the test, run it, watch it fail *for the reason you intended*, then implement. Where a task adds a guard, break the guard afterwards, confirm the test goes red on the intended assertion, and say so in the commit body.
- **Commits** are conventional-commit style and end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Run the full suite with `npx vitest run` and typecheck with `npx tsc --noEmit` before every commit.

---

### Task 1: Emulator gains a `keywordForm` option

**Why first:** Task 4's request-shape A/B is the highest-value part of this kit, and it cannot be tested without this. The emulator currently strips a trailing NUL before matching — deliberately modelling a device tolerant of either form — so the A/B would always report "both answer" and three of its four outcomes would be untestable.

**Files:**
- Modify: `test/emulator/index.ts` (the `EmulatorOptions` interface, and the `CMD.OPTIONS_RRQ` handler in `terminalHandlers`)
- Test: `test/emulator/emulator.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EmulatorOptions.keywordForm?: 'nul' | 'bare' | 'either'`, default `'either'`.

- [ ] **Step 1: Write the failing test**

Add to `test/emulator/emulator.spec.ts`:

```ts
import { CMD } from '../../src/codec/commands.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'

describe('emulator keywordForm', () => {
  const open = async (port: number): Promise<Session> => {
    const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 2000 })
    await s.open()
    return s
  }

  it("defaults to tolerating either request shape", async () => {
    running = await startEmulator({ transport: 'tcp', params: { '~SerialNumber': 'ABC' } })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).not.toBe(CMD.ACK_ERROR)
    expect(bare.command).not.toBe(CMD.ACK_ERROR)
  })

  it("refuses the bare shape when keywordForm is 'nul'", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'ABC' },
      keywordForm: 'nul',
    })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).not.toBe(CMD.ACK_ERROR)
    expect(bare.command).toBe(CMD.ACK_ERROR)
  })

  it("refuses the NUL-terminated shape when keywordForm is 'bare'", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { '~SerialNumber': 'ABC' },
      keywordForm: 'bare',
    })
    session = await open(running.port)
    const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber\0', 'latin1'))
    const bare = await session.tryExecute(CMD.OPTIONS_RRQ, Buffer.from('~SerialNumber', 'latin1'))
    expect(withNul.command).toBe(CMD.ACK_ERROR)
    expect(bare.command).not.toBe(CMD.ACK_ERROR)
  })
})
```

Reuse the file's existing `running` / `session` variables and `afterEach` teardown; if the file has no `session` variable, add one that mirrors the pattern in `test/commands/info.spec.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emulator/emulator.spec.ts`
Expected: the two `keywordForm` tests FAIL (both shapes answered — the emulator strips the NUL regardless), and a TypeScript error that `keywordForm` is not a known option.

- [ ] **Step 3: Implement**

In `test/emulator/index.ts`, add to `EmulatorOptions`:

```ts
  /**
   * Which CMD_OPTIONS_RRQ request shape this device understands.
   *
   * Defaults to 'either', which models the tolerant device v0.3 §8.1's
   * "they disagree" branch assumed — pyzk sends the keyword NUL-terminated,
   * zkteco-js sends it bare, and the library ships pyzk's form as a guess
   * (first-hardware checklist item 18). 'nul' and 'bare' model a device that
   * understands only one, so the probe's A/B can be tested against all four
   * outcomes instead of only the one the tolerant default produces.
   */
  keywordForm?: 'nul' | 'bare' | 'either'
```

Replace the `CMD.OPTIONS_RRQ` handler in `terminalHandlers` with:

```ts
  [CMD.OPTIONS_RRQ]: (req, state) => {
    const raw = req.data.toString('latin1')
    const hasNul = raw.endsWith('\0')
    const keyword = hasNul ? raw.slice(0, -1) : raw
    // A device that understands only one request shape refuses the other
    // outright — indistinguishable, from the client's side, from refusing an
    // unknown keyword. That ambiguity is real and is why the probe's A/B has
    // a 'neither' outcome (design spec §4.2).
    const form = state.opts.keywordForm ?? 'either'
    if (form === 'nul' && !hasNul) return [reply(state, req, CMD.ACK_ERROR)]
    if (form === 'bare' && hasNul) return [reply(state, req, CMD.ACK_ERROR)]
    const params = state.opts.params ?? {}
    if (!Object.hasOwn(params, keyword)) return [reply(state, req, CMD.ACK_ERROR)]
    const echoed = state.opts.paramEchoOverride ?? keyword
    const body = Buffer.from(`${echoed}=${params[keyword]}\0`, 'latin1')
    return [reply(state, req, CMD.ACK_OK, body)]
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass. The default `'either'` means every pre-existing test is unaffected — if any v0.3 parameter test now fails, the default was applied wrongly.

- [ ] **Step 5: Commit**

```bash
git add test/emulator/index.ts test/emulator/emulator.spec.ts
git commit -m "test(emulator): model a device that understands only one keyword shape

The OPTIONS_RRQ handler strips a trailing NUL before matching, modelling a
device tolerant of either request form. That is the right default and stays the
default -- but it makes the probe's request-shape A/B untestable, because three
of its four outcomes can never occur against a tolerant device.

keywordForm: 'nul' | 'bare' | 'either' defaults to 'either', so no existing
test changes behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `TracingTransport`

**Files:**
- Create: `src/diagnostics/types.ts`
- Create: `src/diagnostics/TracingTransport.ts`
- Test: `test/diagnostics/tracing.spec.ts`

**Interfaces:**
- Consumes: `Transport` from `src/transport/Transport.ts`.
- Produces:
  - `type TraceDirection = 'send' | 'recv' | 'push' | 'error'`
  - `interface TraceEvent { seq: number; direction: TraceDirection; offsetMs: number; hex?: string; command?: number; checksum?: number; sessionId?: number; replyId?: number; errorClass?: string; errorMessage?: string }`
  - `class TracingTransport implements Transport { constructor(inner: Transport, now: () => number); readonly events: readonly TraceEvent[] }`

`now` is injected rather than read from `Date.now()` so tests are deterministic and the Global Constraint on clock access holds.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/tracing.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import { ZkTimeoutError } from '../../src/errors.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { TracingTransport } from '../../src/diagnostics/TracingTransport.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

/** A clock that advances 1ms per call, so offsets are predictable. */
function fakeClock(): () => number {
  let t = 0
  return () => t++
}

describe('TracingTransport', () => {
  it('records both directions of a request-response exchange', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    session = new Session(traced, { timeoutMs: 2000 })
    await session.open()

    const sends = traced.events.filter((e) => e.direction === 'send')
    const recvs = traced.events.filter((e) => e.direction === 'recv')
    expect(sends[0]?.command).toBe(CMD.CONNECT)
    expect(recvs.length).toBeGreaterThan(0)
    // Every event carries the bytes, because item 2 reconciles a checksum over
    // exact bytes and a decoded header alone cannot be re-checksummed.
    expect(sends[0]?.hex).toMatch(/^[0-9a-f]+$/)
  })

  it('numbers events in order and stamps each from the injected clock', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    session = new Session(traced, { timeoutMs: 2000 })
    await session.open()
    const seqs = traced.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('records a timeout as an error event rather than swallowing it', async () => {
    running = await startEmulator({ transport: 'tcp', behavior: 'silent' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    await traced.connect()
    await traced.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    await expect(traced.receive(60)).rejects.toBeInstanceOf(ZkTimeoutError)
    await traced.close()

    const errors = traced.events.filter((e) => e.direction === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.errorClass).toBe('ZkTimeoutError')
  })

  it('passes pushed packets through to the listener and records them', async () => {
    running = await startEmulator({ transport: 'tcp' })
    const traced = new TracingTransport(
      new TcpTransport({ host: '127.0.0.1', port: running.port }),
      fakeClock(),
    )
    await traced.connect()
    const seen: Buffer[] = []
    traced.listen((p) => seen.push(p), () => {})
    running.pushRaw(encodePayload({ command: CMD.REG_EVENT, sessionId: 1, replyId: 0 }))
    await new Promise((r) => setTimeout(r, 100))
    await traced.close()

    expect(seen).toHaveLength(1)
    expect(traced.events.filter((e) => e.direction === 'push')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/tracing.spec.ts`
Expected: FAIL — cannot resolve `src/diagnostics/TracingTransport.js`.

- [ ] **Step 3: Implement**

Create `src/diagnostics/types.ts`:

```ts
/** Which way a traced payload moved, or that no payload moved at all. */
export type TraceDirection = 'send' | 'recv' | 'push' | 'error'

/**
 * One observation from the wire.
 *
 * `hex` carries the whole payload because first-hardware checklist item 2
 * reconciles a checksum over exact bytes; a decoded header alone cannot be
 * re-checksummed, so recording only the parsed fields would answer none of the
 * questions this trace exists for.
 */
export interface TraceEvent {
  seq: number
  direction: TraceDirection
  offsetMs: number
  hex?: string
  command?: number
  checksum?: number
  sessionId?: number
  replyId?: number
  errorClass?: string
  errorMessage?: string
}
```

Create `src/diagnostics/TracingTransport.ts`:

```ts
import { decodePayload } from '../codec/packet.js'
import type { Transport } from '../transport/Transport.js'
import type { TraceDirection, TraceEvent } from './types.js'

/**
 * Records every payload this library sends and receives.
 *
 * A decorator over `Transport` rather than a hook inside the transports: it
 * changes neither the published surface nor the two most delicate files in
 * this repository (design spec §3.3). It observes payloads, not wire bytes —
 * TCP framing is applied inside TcpTransport.send — which costs nothing,
 * because checksums are computed over payloads and both throw sites in
 * tryUnframeTcp already attach the rejected 8-byte prefix as the error's raw
 * hex.
 *
 * It holds no policy. It records; deciding what is interesting is the probe's
 * job.
 *
 * `now` is injected rather than read from Date.now() so that offsets are
 * deterministic under test and so that clock access stays confined to
 * src/cli.ts.
 */
export class TracingTransport implements Transport {
  private readonly log: TraceEvent[] = []
  private seq = 0
  private readonly start: number

  constructor(
    private readonly inner: Transport,
    private readonly now: () => number,
  ) {
    this.start = now()
  }

  get events(): readonly TraceEvent[] {
    return this.log
  }

  private record(direction: TraceDirection, payload?: Buffer, err?: Error): void {
    const event: TraceEvent = {
      seq: this.seq++,
      direction,
      offsetMs: this.now() - this.start,
    }
    if (payload) {
      event.hex = payload.toString('hex')
      // A payload too short or malformed to decode is still evidence, so a
      // decode failure must not lose the bytes or throw out of a socket
      // handler. The hex above is already recorded either way.
      try {
        const pkt = decodePayload(payload)
        event.command = pkt.command
        event.sessionId = pkt.sessionId
        event.replyId = pkt.replyId
      } catch {
        // Intentionally empty: hex is the record that matters.
      }
    }
    if (err) {
      event.errorClass = err.constructor.name
      event.errorMessage = err.message
    }
    this.log.push(event)
  }

  async connect(): Promise<void> {
    try {
      await this.inner.connect()
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  async send(payload: Buffer): Promise<void> {
    this.record('send', payload)
    try {
      await this.inner.send(payload)
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  async receive(timeoutMs: number): Promise<Buffer> {
    try {
      const payload = await this.inner.receive(timeoutMs)
      this.record('recv', payload)
      return payload
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    this.inner.listen(
      (payload) => {
        this.record('push', payload)
        onPacket(payload)
      },
      (err) => {
        this.record('error', undefined, err)
        onError(err)
      },
    )
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/tracing.spec.ts && npx tsc --noEmit`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/ test/diagnostics/tracing.spec.ts
git commit -m "feat(diagnostics): record every payload with a Transport decorator

Checklist item 1 is 'capture a raw byte dump of a full handshake and one
attendance read', and this library could not do it: no tracing hook, no
logging, not one process.env reference in src/.

A decorator over the five-method Transport interface, so neither the published
surface nor the transports change. It records payloads rather than wire bytes;
that limitation is documented on the class, and costs nothing because
checksums are over payloads and framing errors already carry their prefix.

The clock is injected so offsets are deterministic and clock access stays
confined to src/cli.ts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Step outcomes and the truncation rule

**Files:**
- Modify: `src/diagnostics/types.ts`
- Create: `src/diagnostics/step.ts`
- Test: `test/diagnostics/step.spec.ts`

**Interfaces:**
- Consumes: the error classes from `src/errors.ts`.
- Produces:
  - `type StepOutcome = 'ok' | 'refused' | 'unauthorized' | 'malformed' | 'silent' | 'dropped'`
  - `interface StepResult<T> { name: string; outcome: StepOutcome; value?: T; errorClass?: string; errorMessage?: string; raw?: string }`
  - `function classifyError(err: unknown): Exclude<StepOutcome, 'ok'>`
  - `function stopsTheRun(outcome: StepOutcome): boolean`
  - `class StepRunner { constructor(); readonly steps: readonly StepResult<unknown>[]; readonly truncated: { after: string; reason: string } | null; run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> }`

`run()` returns `undefined` when the step did not produce a value, so callers use the return value rather than re-reading the step list.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/step.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ZkAuthError, ZkConnectionError, ZkFramingError, ZkProtocolError, ZkTimeoutError,
} from '../../src/errors.js'
import { StepRunner, classifyError, stopsTheRun } from '../../src/diagnostics/step.js'

describe('classifyError', () => {
  it('maps each error class to its outcome', () => {
    expect(classifyError(new ZkAuthError('x'))).toBe('unauthorized')
    expect(classifyError(new ZkTimeoutError('x'))).toBe('silent')
    expect(classifyError(new ZkConnectionError('x'))).toBe('dropped')
    expect(classifyError(new ZkProtocolError('x'))).toBe('malformed')
    expect(classifyError(new ZkFramingError('x'))).toBe('malformed')
    expect(classifyError(new Error('x'))).toBe('malformed')
  })

  it('classifies ZkAuthError before ZkProtocolError, which are siblings', () => {
    // Both extend ZkError, neither extends the other. An ordering bug here
    // would silently report every unauthorized device as malformed, and the
    // report would answer the wrong checklist item.
    expect(classifyError(new ZkAuthError('unauthorized'))).not.toBe('malformed')
  })
})

describe('stopsTheRun', () => {
  it('continues whenever the device answered, and stops when it did not', () => {
    expect(stopsTheRun('ok')).toBe(false)
    expect(stopsTheRun('refused')).toBe(false)
    expect(stopsTheRun('unauthorized')).toBe(false)
    expect(stopsTheRun('malformed')).toBe(false)
    expect(stopsTheRun('silent')).toBe(true)
    expect(stopsTheRun('dropped')).toBe(true)
  })
})

describe('StepRunner', () => {
  it('records a value and keeps going', async () => {
    const runner = new StepRunner()
    const value = await runner.run('first', async () => 42)
    expect(value).toBe(42)
    expect(runner.steps[0]).toMatchObject({ name: 'first', outcome: 'ok' })
    expect(runner.truncated).toBeNull()
  })

  it('keeps running after a step the device answered with a refusal', async () => {
    const runner = new StepRunner()
    await runner.run('bad', async () => { throw new ZkProtocolError('nope') })
    const after = await runner.run('good', async () => 7)
    expect(after).toBe(7)
    expect(runner.steps.map((s) => s.outcome)).toEqual(['malformed', 'ok'])
    expect(runner.truncated).toBeNull()
  })

  it('stops the run at a timeout and refuses to execute later steps', async () => {
    // Item 22: a late reply is collected by the NEXT request, so anything
    // after a timeout would be a real answer attributed to the wrong question.
    const runner = new StepRunner()
    await runner.run('quiet', async () => { throw new ZkTimeoutError('no reply within 60ms') })
    let ran = false
    const after = await runner.run('never', async () => { ran = true; return 1 })
    expect(ran).toBe(false)
    expect(after).toBeUndefined()
    expect(runner.truncated).toEqual({ after: 'quiet', reason: 'silent' })
    expect(runner.steps).toHaveLength(1)
  })

  it('keeps the raw hex an error already carries', async () => {
    const runner = new StepRunner()
    await runner.run('framed', async () => {
      throw new ZkProtocolError('TCP start marker mismatch', Buffer.from([1, 2, 3]))
    })
    expect(runner.steps[0]?.raw).toBe('010203')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/step.spec.ts`
Expected: FAIL — cannot resolve `src/diagnostics/step.js`.

- [ ] **Step 3: Implement**

Append to `src/diagnostics/types.ts`:

```ts
/**
 * What one probe step observed.
 *
 * The outcome and the decision to continue are two independent axes, and
 * conflating them is the mistake this type exists to prevent — see
 * `stopsTheRun`. A reader must be able to tell "the device rejected this" from
 * "the device sent something we could not parse" without inferring it from a
 * message string, because those answer different checklist items.
 */
export type StepOutcome =
  | 'ok'
  | 'refused'
  | 'unauthorized'
  | 'malformed'
  | 'silent'
  | 'dropped'

export interface StepResult<T = unknown> {
  name: string
  outcome: StepOutcome
  value?: T
  errorClass?: string
  errorMessage?: string
  /** Hex the error already carried, when it carried any. */
  raw?: string
}
```

Create `src/diagnostics/step.ts`:

```ts
import { ZkAuthError, ZkConnectionError, ZkError, ZkTimeoutError } from '../errors.js'
import type { StepOutcome, StepResult } from './types.js'

/**
 * Classifies a thrown error into the outcome the report records.
 *
 * ZkAuthError is tested FIRST and this ordering is load-bearing: it and
 * ZkProtocolError are siblings under ZkError, neither extending the other, so
 * a `ZkError` catch-all placed earlier would report every unauthorized device
 * as malformed and answer the wrong checklist item.
 *
 * Anything unrecognised is 'malformed' rather than a stop condition. A bug in
 * this tool must not masquerade as a device that went silent.
 */
export function classifyError(err: unknown): Exclude<StepOutcome, 'ok'> {
  if (err instanceof ZkAuthError) return 'unauthorized'
  if (err instanceof ZkTimeoutError) return 'silent'
  if (err instanceof ZkConnectionError) return 'dropped'
  return 'malformed'
}

/**
 * Whether an outcome ends the run.
 *
 * The predicate is the one `freeBuffer` already established: an answer proves
 * the reply was consumed and the session is still in sync. A refusal, an
 * unauthorized reply and a malformed body are all answers, so the probe
 * continues and records them as data.
 *
 * A timeout is not an answer, and continuing past one is the failure this rule
 * exists to prevent. TcpTransport.receive clears its waiter on timeout, so a
 * late reply queues and the NEXT request collects it as its own (first-hardware
 * checklist item 22). Pressing on would produce a report full of real answers
 * attributed to the wrong questions — invisible to the reader, and the worst
 * possible outcome for a tool whose only product is evidence.
 */
export function stopsTheRun(outcome: StepOutcome): boolean {
  return outcome === 'silent' || outcome === 'dropped'
}

/** Runs probe steps, isolating each and stopping only when the device stops answering. */
export class StepRunner {
  private readonly results: StepResult<unknown>[] = []
  private stopped: { after: string; reason: StepOutcome } | null = null

  get steps(): readonly StepResult<unknown>[] {
    return this.results
  }

  get truncated(): { after: string; reason: string } | null {
    return this.stopped
  }

  /**
   * Runs one step. Returns its value, or undefined if it did not produce one.
   *
   * Once the run is truncated, later steps are NOT executed — returning
   * undefined without touching the socket. Recording them as skipped would be
   * a lie by omission; they are simply absent, and `truncated` says why.
   */
  async run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.stopped) return undefined
    try {
      const value = await fn()
      this.results.push({ name, outcome: 'ok', value })
      return value
    } catch (err) {
      const outcome = classifyError(err)
      const result: StepResult<unknown> = { name, outcome }
      if (err instanceof Error) {
        result.errorClass = err.constructor.name
        result.errorMessage = err.message
      }
      if (err instanceof ZkError && err.raw) result.raw = err.raw
      this.results.push(result)
      if (stopsTheRun(outcome)) this.stopped = { after: name, reason: outcome }
      return undefined
    }
  }

  /** Records a step the device answered with a refusal rather than an error. */
  refused(name: string): void {
    if (this.stopped) return
    this.results.push({ name, outcome: 'refused' })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/step.spec.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Verify the guard, then commit**

Temporarily reorder `classifyError` so `ZkProtocolError` is tested before `ZkAuthError` (or add an `err instanceof ZkError` branch first). Run the suite and confirm the "classifies ZkAuthError before ZkProtocolError" test goes red on that assertion. Restore.

```bash
git add src/diagnostics/ test/diagnostics/step.spec.ts
git commit -m "feat(diagnostics): step outcomes, and the rule that a timeout truncates

Six outcomes on two independent axes: what the step observed, and whether the
run continues. Conflating them would let a reader mistake 'the device rejected
this' for 'we could not parse this', which answer different checklist items.

Continue whenever the device ANSWERED -- refusal, unauthorized, malformed body
all prove the reply was consumed and the session is in sync, the same predicate
freeBuffer uses. Stop when it did not: item 22 means a late reply is collected
by the next request, so continuing past a timeout produces real answers
attributed to the wrong questions.

classifyError tests ZkAuthError before the fallback because the two are
siblings under ZkError; verified by reordering the branches and watching the
ordering test go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Probe — handshake, firmware control read, and the request-shape A/B

**Files:**
- Create: `src/diagnostics/probe.ts`
- Test: `test/diagnostics/probe.identity.spec.ts`

**Interfaces:**
- Consumes: `StepRunner` (Task 3), `TracingTransport` (Task 2), `Session`, `CMD`, `DEVICE_PARAM`.
- Produces:
  - `type KeywordFormVerdict = 'both' | 'nul-only' | 'bare-only' | 'neither'`
  - `interface ProbeOptions { transport: 'tcp' | 'udp'; attendance: 'auto' | 'always' | 'never'; realtimeSeconds: number; concurrent: boolean }`
  - `interface Findings { identity: {...}; keywordForm: KeywordFormVerdict | null; parameters: ParameterFinding[]; ... }` (grown by Tasks 5 and 6)
  - `async function probeIdentity(session: Session, runner: StepRunner, findings: Findings): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/probe.identity.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { emptyFindings, probeIdentity } from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const PARAMS = {
  '~SerialNumber': 'SN-123',
  '~DeviceName': 'MB360',
  '~Platform': 'ZMM220_TFT',
  '~OS': 'Linux',
}

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 1000 })
  await s.open()
  return s
}

describe('probeIdentity', () => {
  it("reports 'both' when the device tolerates either keyword shape", async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('both')
  })

  it("reports 'nul-only' when the device refuses the bare shape", async () => {
    running = await startEmulator({
      transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60', keywordForm: 'nul',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('nul-only')
  })

  it("reports 'bare-only' when the device refuses the NUL-terminated shape", async () => {
    // This is the outcome that would refute encodeParamRequest. It is the whole
    // reason the A/B exists, and the emulator's tolerant default cannot produce it.
    running = await startEmulator({
      transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60', keywordForm: 'bare',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('bare-only')
  })

  it("reports 'neither' when the keyword itself is unsupported", async () => {
    running = await startEmulator({ transport: 'tcp', params: {}, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.keywordForm).toBe('neither')
  })

  it('records the firmware control read before any parameter read', async () => {
    // GET_VERSION carries an empty payload and so is untouched by the keyword
    // shape question. If it answers and every parameter refuses, that is the
    // item-18 signature rather than an item-16 answer.
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const names = runner.steps.map((s) => s.name)
    expect(names[0]).toBe('firmware')
    expect(names.indexOf('firmware')).toBeLessThan(names.indexOf('keyword-shape-ab'))
    expect(findings.identity.firmwareVersion).toBe('Ver 6.60')
  })

  it('records each parameter as answered, empty, or refused', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { ...PARAMS, '~OS': '' },
      firmware: 'Ver 6.60',
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    const os = findings.parameters.find((p) => p.key === '~OS')
    expect(os).toMatchObject({ answered: true, empty: true })
    const missing = findings.parameters.find((p) => !PARAMS[p.key as keyof typeof PARAMS] && p.key !== '~OS')
    expect(missing?.answered).toBe(false)
  })

  it('keeps the serial number value out of findings, recording only presence', async () => {
    running = await startEmulator({ transport: 'tcp', params: PARAMS, firmware: 'Ver 6.60' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.identity.serialNumberPresent).toBe(true)
    expect(JSON.stringify(findings)).not.toContain('SN-123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/probe.identity.spec.ts`
Expected: FAIL — cannot resolve `src/diagnostics/probe.js`.

- [ ] **Step 3: Implement**

Create `src/diagnostics/probe.ts`:

```ts
import { CMD } from '../codec/commands.js'
import { DEVICE_PARAM } from '../codec/params.js'
import { readNulTerminated } from '../codec/records/shared.js'
import type { Session } from '../session/Session.js'
import type { StepRunner } from './step.js'

/** Which CMD_OPTIONS_RRQ request shapes the device accepted. */
export type KeywordFormVerdict = 'both' | 'nul-only' | 'bare-only' | 'neither'

export interface ParameterFinding {
  key: string
  /** The device answered rather than refusing with ACK_ERROR. */
  answered: boolean
  /** It answered with an empty value. Distinct from not answering — item 16. */
  empty: boolean
}

export interface Findings {
  identity: {
    deviceName: string | null
    platform: string | null
    os: string | null
    firmwareVersion: string | null
    /**
     * Presence only, never the value. The serial identifies one unit and no
     * checklist item needs it — item 17 needs only that the key answered.
     */
    serialNumberPresent: boolean
  }
  keywordForm: KeywordFormVerdict | null
  parameters: ParameterFinding[]
}

export function emptyFindings(): Findings {
  return {
    identity: {
      deviceName: null,
      platform: null,
      os: null,
      firmwareVersion: null,
      serialNumberPresent: false,
    },
    keywordForm: null,
    parameters: [],
  }
}

/** The keyword used for the A/B. Any exposed key would do; this one is near-universal. */
const AB_KEYWORD = DEVICE_PARAM.SERIAL_NUMBER

const nulTerminated = (keyword: string): Buffer => Buffer.from(`${keyword}\0`, 'latin1')
const bare = (keyword: string): Buffer => Buffer.from(keyword, 'latin1')

/**
 * Did this reply answer the keyword, as opposed to refusing it?
 *
 * Deliberately does NOT reuse decodeParamReply: that throws on an echo
 * mismatch, and here a mismatched echo is an observation to record rather than
 * an error to raise. The test is only "did the device come back with this
 * keyword and an '='".
 */
function answeredKeyword(command: number, body: Buffer, keyword: string): boolean {
  if (command === CMD.ACK_ERROR || command === CMD.ACK_UNAUTH) return false
  return body.toString('latin1').startsWith(`${keyword}=`)
}

/**
 * Resolves first-hardware checklist item 18 — the library's one shipped
 * protocol guess.
 *
 * pyzk sends the CMD_OPTIONS_RRQ keyword NUL-terminated; zkteco-js sends it
 * bare; encodeParamRequest ships pyzk's form because a device tolerating
 * either would accept it. PROVENANCE.md records that superset-ness rests on
 * parser speculation and that the losing case is real. Two round trips settle
 * it.
 *
 * 'neither' is a keyword question, not a shape question — the key may simply
 * be unsupported. The report must say so, or the first real result will be
 * logged as an item-18 answer when it is an item-17 one.
 */
async function requestShapeAb(session: Session, keyword: string): Promise<KeywordFormVerdict> {
  const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(keyword))
  const nulOk = answeredKeyword(withNul.command, withNul.data, keyword)
  const without = await session.tryExecute(CMD.OPTIONS_RRQ, bare(keyword))
  const bareOk = answeredKeyword(without.command, without.data, keyword)
  if (nulOk && bareOk) return 'both'
  if (nulOk) return 'nul-only'
  if (bareOk) return 'bare-only'
  return 'neither'
}

/** Splits a parameter body at the first '=', stopping at the first NUL. */
function paramValue(body: Buffer): string | null {
  const text = readNulTerminated(body, 0, body.length)
  const eq = text.indexOf('=')
  return eq === -1 ? null : text.slice(eq + 1)
}

/**
 * Steps 2 to 4 of the probe: the firmware control read, the request-shape A/B,
 * then a parameter sweep one key at a time.
 *
 * Per key rather than a single getParameters call: that function abandons the
 * remaining reads on a hard failure, which is right for the library and wrong
 * for a diagnostic. One refusal must not end the sweep.
 */
export async function probeIdentity(
  session: Session,
  runner: StepRunner,
  findings: Findings,
): Promise<void> {
  // FIRST, deliberately. CMD_GET_VERSION carries an empty payload and so is
  // untouched by the keyword-shape question below. If it answers and every
  // parameter refuses, that is item 18's signature — which handoff §3.1 warns
  // is otherwise indistinguishable from the answer item 16 exists to collect.
  await runner.run('firmware', async () => {
    const res = await session.tryExecute(CMD.GET_VERSION)
    if (res.command === CMD.ACK_ERROR) return null
    const value = readNulTerminated(res.data, 0, res.data.length)
    findings.identity.firmwareVersion = value
    return value
  })

  await runner.run('keyword-shape-ab', async () => {
    const verdict = await requestShapeAb(session, AB_KEYWORD)
    findings.keywordForm = verdict
    return verdict
  })

  for (const key of Object.values(DEVICE_PARAM)) {
    await runner.run(`param:${key}`, async () => {
      const res = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(key))
      if (!answeredKeyword(res.command, res.data, key)) {
        findings.parameters.push({ key, answered: false, empty: false })
        return null
      }
      const value = paramValue(res.data) ?? ''
      findings.parameters.push({ key, answered: true, empty: value === '' })
      // The serial is recorded as presence only; every other identity field
      // carries its value, because item 7 cannot build a compatibility table
      // without the model, platform, OS and firmware.
      if (key === DEVICE_PARAM.SERIAL_NUMBER) findings.identity.serialNumberPresent = true
      else if (key === DEVICE_PARAM.DEVICE_NAME) findings.identity.deviceName = value
      else if (key === DEVICE_PARAM.PLATFORM) findings.identity.platform = value
      else if (key === DEVICE_PARAM.OS) findings.identity.os = value
      return value
    })
  }
}
```

If `DEVICE_PARAM` does not export `SERIAL_NUMBER`, `DEVICE_NAME`, `PLATFORM` and `OS` under exactly those names, read `src/codec/params.ts` and use the real ones — do not invent them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/probe.identity.spec.ts && npx tsc --noEmit`
Expected: 7 passed.

- [ ] **Step 5: Verify the redaction guard, then commit**

Temporarily change the `SERIAL_NUMBER` branch to `findings.identity.deviceName = value` so the serial leaks into findings. Confirm the "keeps the serial number value out of findings" test goes red on the `not.toContain('SN-123')` assertion. Restore.

```bash
git add src/diagnostics/probe.ts test/diagnostics/probe.identity.spec.ts
git commit -m "feat(diagnostics): firmware control read, request-shape A/B, parameter sweep

The A/B is the point of the kit. Item 18 is the library's one shipped protocol
guess -- pyzk sends the OPTIONS_RRQ keyword NUL-terminated, zkteco-js sends it
bare, and encodeParamRequest picked pyzk's on a superset argument PROVENANCE
records as parser speculation. Two round trips settle it, across all four
outcomes.

GET_VERSION runs first and deliberately: its payload is empty, so it is
untouched by the shape question. If it answers and every parameter refuses,
that is item 18's signature -- which handoff 3.1 warns is otherwise
indistinguishable from the answer item 16 exists to collect.

The sweep runs one key at a time rather than through getParameters, because
that function abandons its remaining reads on a hard failure. Right for the
library, wrong for a diagnostic.

The serial number is recorded as presence only. Verified by leaking it
deliberately and watching the redaction test go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Probe — clock, storage counters, and checksum audit

**Files:**
- Modify: `src/diagnostics/probe.ts`
- Test: `test/diagnostics/probe.state.spec.ts`

**Interfaces:**
- Consumes: `Findings` and `emptyFindings` (Task 4), `TraceEvent` (Task 2).
- Produces:
  - `Findings.clock: { deviceLocal: string; hostLocal: string; skewSeconds: number } | null`
  - `Findings.freeSizes: { userCount: number; recordCount: number; recordCapacity: number; rawHex: string } | null`
  - `Findings.checksum: { packetsChecked: number; mismatches: number }`
  - `async function probeState(session: Session, runner: StepRunner, findings: Findings, hostNowSeconds: number): Promise<void>`
  - `function auditChecksums(events: readonly TraceEvent[]): { packetsChecked: number; mismatches: number }`

`hostNowSeconds` is a parameter, not a clock read — Global Constraint.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/probe.state.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { encodePayload } from '../../src/codec/packet.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { auditChecksums, emptyFindings, probeState } from '../../src/diagnostics/probe.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 1000 })
  await s.open()
  return s
}

describe('probeState', () => {
  it('records the storage counters and keeps the raw body for item 4', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 42, recordCount: 1337, recordCapacity: 100_000 },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.freeSizes).toMatchObject({ userCount: 42, recordCount: 1337 })
    // FREE_SIZES_OFFSET is documentation-derived and unverified. The raw body
    // is what lets a reader check the offsets against a real reply.
    expect(findings.freeSizes?.rawHex).toMatch(/^[0-9a-f]+$/)
  })

  it('records device and host clocks side by side without judging the difference', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, 0)
    expect(findings.clock?.deviceLocal).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(typeof findings.clock?.skewSeconds).toBe('number')
  })

  it('keeps going when the device refuses the clock', async () => {
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_TIME]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeState(session, runner, findings, 0)
    expect(findings.clock).toBeNull()
    expect(findings.freeSizes).not.toBeNull()
    expect(runner.truncated).toBeNull()
  })
})

describe('auditChecksums', () => {
  it('counts a good packet as checked with no mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    const events: TraceEvent[] = [
      { seq: 0, direction: 'recv', offsetMs: 0, hex: payload.toString('hex') },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 1, mismatches: 0 })
  })

  it('counts a corrupted checksum as a mismatch', () => {
    const payload = encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 2 })
    payload.writeUInt16LE(0x1234, 2)
    const events: TraceEvent[] = [
      { seq: 0, direction: 'recv', offsetMs: 0, hex: payload.toString('hex') },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 1, mismatches: 1 })
  })

  it('ignores events with no payload', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'error', offsetMs: 0, errorClass: 'ZkTimeoutError' },
    ]
    expect(auditChecksums(events)).toEqual({ packetsChecked: 0, mismatches: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/probe.state.spec.ts`
Expected: FAIL — `probeState` and `auditChecksums` are not exported.

- [ ] **Step 3: Implement**

Add to the `Findings` interface in `src/diagnostics/probe.ts`:

```ts
  clock: { deviceLocal: string; hostLocal: string; skewSeconds: number } | null
  freeSizes: {
    userCount: number
    recordCount: number
    recordCapacity: number
    /** The whole body. FREE_SIZES_OFFSET is unverified; this is how item 4 gets checked. */
    rawHex: string
  } | null
  checksum: { packetsChecked: number; mismatches: number }
```

and to `emptyFindings()`:

```ts
    clock: null,
    freeSizes: null,
    checksum: { packetsChecked: 0, mismatches: 0 },
```

Add these imports at the top of `probe.ts`:

```ts
import { checksum16 } from '../codec/checksum.js'
import { decodeZkTime } from '../codec/time.js'
import { FREE_SIZES_OFFSET } from '../commands/info.js'
import type { TraceEvent } from './types.js'
```

Append to `src/diagnostics/probe.ts`:

```ts
/**
 * Recomputes each captured packet's checksum and compares it to the one on the
 * wire — first-hardware checklist item 2, for the part a tool can do alone.
 *
 * The checksum field itself is zeroed before recomputing, because checksum16
 * is computed over a payload whose checksum slot is zero. Comparing against
 * the packet as captured, slot included, would report every good packet as a
 * mismatch.
 *
 * A payload too short to hold a header is skipped rather than counted. It is
 * still in the raw capture; counting it as a mismatch would inflate the only
 * number a reader uses to judge whether §5's formulation survives contact.
 */
export function auditChecksums(
  events: readonly TraceEvent[],
): { packetsChecked: number; mismatches: number } {
  let packetsChecked = 0
  let mismatches = 0
  for (const event of events) {
    if (!event.hex) continue
    const buf = Buffer.from(event.hex, 'hex')
    if (buf.length < 8) continue
    const transmitted = buf.readUInt16LE(2)
    const zeroed = Buffer.from(buf)
    zeroed.writeUInt16LE(0, 2)
    packetsChecked += 1
    if (checksum16(zeroed) !== transmitted) mismatches += 1
  }
  return { packetsChecked, mismatches }
}

const REQUIRED_FREE_SIZES = FREE_SIZES_OFFSET.recordCapacity + 4

/**
 * Steps 5 and 6 of the probe: the device clock, then its storage counters.
 *
 * `hostNowSeconds` is passed in rather than read here. Clock access lives only
 * in src/cli.ts, which is what keeps every test above deterministic.
 */
export async function probeState(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  hostNowSeconds: number,
): Promise<void> {
  await runner.run('clock', async () => {
    const res = await session.tryExecute(CMD.GET_TIME)
    if (res.command === CMD.ACK_ERROR || res.data.length < 4) return null
    const device = decodeZkTime(res.data.readUInt32LE(0))
    const hostLocal = new Date(hostNowSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
    // Recorded side by side and NOT judged. Device clocks drift and reset; the
    // library returns readings verbatim (v0.1 §3) and so does this. Whether a
    // skew is a problem is a human's call with the specs open.
    findings.clock = {
      deviceLocal: device.local,
      hostLocal,
      skewSeconds: Math.round(Date.parse(`${device.local}Z`) / 1000) - hostNowSeconds,
    }
    return findings.clock
  })

  await runner.run('free-sizes', async () => {
    const res = await session.tryExecute(CMD.GET_FREE_SIZES)
    if (res.command === CMD.ACK_ERROR || res.data.length < REQUIRED_FREE_SIZES) return null
    findings.freeSizes = {
      userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
      recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
      recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
      rawHex: res.data.toString('hex'),
    }
    return findings.freeSizes
  })
}
```

`ZkNaiveTime.local` is the fixed-width naive string; confirm its exact shape in `src/types.ts` before relying on the `Date.parse` above, and if it is not `YYYY-MM-DD HH:MM:SS`, adjust the skew computation rather than the type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/probe.state.spec.ts && npx tsc --noEmit`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/probe.ts test/diagnostics/probe.state.spec.ts
git commit -m "feat(diagnostics): device clock, storage counters, and a checksum audit

The free-sizes body is kept whole, not just its three decoded fields:
FREE_SIZES_OFFSET is documentation-derived and unverified, and item 4 is
checked by reading the raw reply, which a decoded triple cannot support.

Clocks are recorded side by side and not judged. Device clocks drift and reset;
v0.1 section 3 returns readings verbatim and so does this.

auditChecksums zeroes the checksum slot before recomputing, because checksum16
runs over a payload whose slot is zero -- comparing against the captured bytes
with the slot intact would report every good packet as a mismatch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Probe — users, attendance guard, bulk path, and the encoding verdict

**Files:**
- Modify: `src/diagnostics/probe.ts`
- Test: `test/diagnostics/probe.bulk.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5.
- Produces:
  - `Findings.bulkPath: 'buffered' | 'legacy' | null`
  - `Findings.attendance: { read: boolean; skippedReason: string | null; detectedRecordSize: number | null; rowCount: number } | null`
  - `Findings.encoding: { namesInspected: number; withHighBytes: number; validUtf8: boolean | null } | null`
  - `const ATTENDANCE_AUTO_THRESHOLD = 10_000`
  - `async function probeBulk(session, runner, findings, opts: { transport: 'tcp'|'udp'; attendance: 'auto'|'always'|'never' }): Promise<void>`
  - `function encodingVerdict(names: readonly string[]): { namesInspected: number; withHighBytes: number; validUtf8: boolean | null }`

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/probe.bulk.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import {
  ATTENDANCE_AUTO_THRESHOLD, emptyFindings, encodingVerdict, probeBulk,
} from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'latin1')
  b.write(userId, 48, 8, 'latin1')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

function rec40(uid: number, userId: string, t: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'latin1')
  b.writeUInt32LE(t, 27)
  return b
}

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 2000 })
  await s.open()
  return s
}

describe('encodingVerdict', () => {
  it('reports pure ASCII as no high bytes and no UTF-8 verdict', () => {
    expect(encodingVerdict(['Alice', 'Bob'])).toEqual({
      namesInspected: 2, withHighBytes: 0, validUtf8: null,
    })
  })

  it('recognises latin1-carried UTF-8 as valid UTF-8', () => {
    // The name arrives as latin1 (byte-preserving), so re-encoding to latin1
    // recovers the device's exact bytes -- which is what makes this decidable
    // without ever shipping the name.
    const utf8 = Buffer.from('Nguyễn', 'utf8').toString('latin1')
    expect(encodingVerdict([utf8])).toMatchObject({ withHighBytes: 1, validUtf8: true })
  })

  it('recognises a non-UTF-8 high-byte sequence as not valid UTF-8', () => {
    const gb = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]).toString('latin1')
    expect(encodingVerdict([gb])).toMatchObject({ withHighBytes: 1, validUtf8: false })
  })

  it('never returns the names themselves', () => {
    const verdict = encodingVerdict(['Alice'])
    expect(JSON.stringify(verdict)).not.toContain('Alice')
  })
})

describe('probeBulk', () => {
  it('reads users and reports which bulk path the firmware took', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' })
    expect(findings.bulkPath).toBe('buffered')
    expect(findings.attendance).toMatchObject({ read: true, detectedRecordSize: 40 })
  })

  it('skips the attendance read above the threshold and says why', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1_000_000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1_000_000, rawHex: '',
    }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' })
    expect(findings.attendance).toMatchObject({ read: false })
    // A skip must be visible as a skip, naming the count and the override.
    expect(findings.attendance?.skippedReason).toContain('--attendance=always')
  })

  it('reads anyway when attendance is forced', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = {
      userCount: 1, recordCount: ATTENDANCE_AUTO_THRESHOLD + 1, recordCapacity: 1000, rawHex: '',
    }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'always' })
    expect(findings.attendance?.read).toBe(true)
  })

  it('keeps no user names or ids in findings', async () => {
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
      users: [emUser(1, 'EMP-9931', 'Zaphod')],
      records: { size: 40, rows: [rec40(1, 'A', 86_400)] },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 1, recordCapacity: 1000, rawHex: '' }
    await probeBulk(session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' })
    const serialised = JSON.stringify(findings)
    expect(serialised).not.toContain('Zaphod')
    expect(serialised).not.toContain('EMP-9931')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/probe.bulk.spec.ts`
Expected: FAIL — `probeBulk`, `encodingVerdict` and `ATTENDANCE_AUTO_THRESHOLD` are not exported.

- [ ] **Step 3: Implement**

Add to `Findings`:

```ts
  bulkPath: 'buffered' | 'legacy' | null
  attendance: {
    read: boolean
    skippedReason: string | null
    detectedRecordSize: number | null
    rowCount: number
  } | null
  encoding: { namesInspected: number; withHighBytes: number; validUtf8: boolean | null } | null
```

and to `emptyFindings()`: `bulkPath: null, attendance: null, encoding: null,`.

Add imports:

```ts
import { getUsers } from '../commands/users.js'
import { getAttendanceLogs } from '../commands/attendance.js'
```

Append to `src/diagnostics/probe.ts`:

```ts
/**
 * Read the attendance log automatically below this many records.
 *
 * A guess about politeness and nothing more. The protocol has no "read N
 * records" — the device returns its whole buffer — so on a large terminal this
 * is slow and keeps the device busy while people are badging at it. No device
 * has been observed, so no count is KNOWN to be slow. The first real device
 * should be treated as evidence about this number (design spec §8, risk 3).
 */
export const ATTENDANCE_AUTO_THRESHOLD = 10_000

/**
 * Answers first-hardware checklist item 20 without ever shipping a name.
 *
 * The discriminating signal is structural, not semantic: UTF-8 has a strict
 * continuation-byte grammar and GB2312 does not. So the bytes are tested and a
 * verdict is returned; the names never leave this function.
 *
 * Names arrive decoded as latin1, which is byte-preserving, so re-encoding to
 * latin1 recovers exactly what the device sent. Under the `ascii` decoding
 * this library used before v0.3 the high bit was already gone and this
 * question could not have been asked at all.
 *
 * `validUtf8` is null when nothing carried a high byte — that is "no evidence
 * either way", which is a different answer from "not UTF-8" and must not be
 * collapsed into it.
 */
export function encodingVerdict(
  names: readonly string[],
): { namesInspected: number; withHighBytes: number; validUtf8: boolean | null } {
  const high = names.filter((n) => [...n].some((c) => c.charCodeAt(0) >= 0x80))
  if (high.length === 0) {
    return { namesInspected: names.length, withHighBytes: 0, validUtf8: null }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const allValid = high.every((n) => {
    try {
      decoder.decode(Buffer.from(n, 'latin1'))
      return true
    } catch {
      return false
    }
  })
  return { namesInspected: names.length, withHighBytes: high.length, validUtf8: allValid }
}

/**
 * Step 7 of the probe: the user list, then the attendance log.
 *
 * Which bulk path the firmware took is recorded because it answers whether
 * 1503/1504 are implemented, and — since v0.3.1 — checklist item 23 as well.
 * It is inferred from the trace by the caller rather than guessed here.
 */
export async function probeBulk(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  opts: { transport: 'tcp' | 'udp'; attendance: 'auto' | 'always' | 'never' },
): Promise<void> {
  const users = await runner.run('users', async () => getUsers(session, opts.transport))
  if (users) {
    findings.encoding = encodingVerdict(users.map((u) => u.name))
    findings.bulkPath = 'buffered'
  }

  const recordCount = findings.freeSizes?.recordCount ?? 0
  const shouldRead =
    opts.attendance === 'always' ||
    (opts.attendance === 'auto' && recordCount <= ATTENDANCE_AUTO_THRESHOLD)

  if (!shouldRead) {
    // Reported as a skip, naming the count and the override. Omitting it
    // silently would be the "reports success while proving less than it
    // appears to" shape this project keeps catching.
    findings.attendance = {
      read: false,
      skippedReason:
        opts.attendance === 'never'
          ? 'skipped: --attendance=never'
          : `skipped: ${recordCount} records exceeds the ${ATTENDANCE_AUTO_THRESHOLD} auto threshold; pass --attendance=always to read anyway`,
      detectedRecordSize: null,
      rowCount: 0,
    }
    return
  }

  await runner.run('attendance', async () => {
    const logs = await getAttendanceLogs(session, opts.transport, { resolveUserIds: false })
    // Counts and shapes only. Never a row: those are movement records for
    // named people, and no checklist item needs their contents.
    findings.attendance = {
      read: true,
      skippedReason: null,
      detectedRecordSize: logs[0]?.recordSize ?? null,
      rowCount: logs.length,
    }
    return findings.attendance
  })
}
```

`resolveUserIds: false` is deliberate: the user list has already been read, and re-reading it inside the attendance call would double a round trip for data the report discards.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/probe.bulk.spec.ts && npx tsc --noEmit`
Expected: 8 passed.

- [ ] **Step 5: Verify the guard, then commit**

Temporarily add `names: users.map((u) => u.name)` to the `findings.encoding` object. Confirm the "keeps no user names or ids" test goes red on `not.toContain('Zaphod')`. Restore.

```bash
git add src/diagnostics/probe.ts test/diagnostics/probe.bulk.spec.ts
git commit -m "feat(diagnostics): bulk reads, the attendance guard, and an encoding verdict

Item 20 asks what encoding a device uses for strings, which sounds like it
requires the strings. It does not: UTF-8 has a strict continuation-byte grammar
and GB2312 does not, so the bytes are tested and a verdict returned while the
names never leave the function. Possible only because v0.3 moved
readNulTerminated to latin1 -- under ascii the high bit was already gone.

validUtf8 is null when nothing carried a high byte. 'No evidence either way' is
a different answer from 'not UTF-8' and collapsing them would invent a finding.

The attendance guard skips above 10,000 records and reports the skip AS a skip,
naming the count and the override. The threshold is a guess about politeness,
documented as one.

Verified by leaking user names into findings deliberately and watching the
redaction test go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Renderers and the redaction invariant

**Files:**
- Create: `src/diagnostics/report.ts`
- Test: `test/diagnostics/report.spec.ts`

**Interfaces:**
- Consumes: `Findings` (Tasks 4–6), `StepResult` and `TraceEvent` (Tasks 2–3).
- Produces:
  - `interface ProbeResult { libraryVersion: string; host: string; transport: 'tcp'|'udp'; startedAt: string; durationMs: number; truncated: { after: string; reason: string } | null; steps: readonly StepResult[]; findings: Findings }`
  - `function renderJson(result: ProbeResult): object`
  - `function renderMarkdown(result: ProbeResult): string`
  - `function renderRawCapture(events: readonly TraceEvent[]): string`

All three are pure. The CLI writes what they return.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/report.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import type { TraceEvent } from '../../src/diagnostics/types.js'

function sample(): ProbeResult {
  const findings = emptyFindings()
  findings.identity.deviceName = 'MB360'
  findings.identity.firmwareVersion = 'Ver 6.60'
  findings.identity.serialNumberPresent = true
  findings.keywordForm = 'both'
  return {
    libraryVersion: '0.4.0',
    host: '192.168.1.201',
    transport: 'tcp',
    startedAt: '2026-08-30T00:00:00.000Z',
    durationMs: 1234,
    truncated: null,
    steps: [{ name: 'firmware', outcome: 'ok' }],
    findings,
  }
}

describe('renderMarkdown', () => {
  it('is deterministic for the same input', () => {
    expect(renderMarkdown(sample())).toBe(renderMarkdown(sample()))
  })

  it('names the model, which item 7 needs for the compatibility table', () => {
    const md = renderMarkdown(sample())
    expect(md).toContain('MB360')
    expect(md).toContain('Ver 6.60')
  })

  it('states that item 22 is not testable by this tool rather than omitting it', () => {
    // An absence must be visible as an absence at the point a reader would
    // otherwise assume presence.
    expect(renderMarkdown(sample())).toMatch(/22[^\n]*not testable/i)
  })

  it('says the run was truncated, and where', () => {
    const result = { ...sample(), truncated: { after: 'clock', reason: 'silent' } }
    const md = renderMarkdown(result)
    expect(md).toMatch(/truncated/i)
    expect(md).toContain('clock')
  })

  it('spells out what a bare-only verdict means for the library', () => {
    const result = sample()
    result.findings.keywordForm = 'bare-only'
    expect(renderMarkdown(result)).toMatch(/encodeParamRequest/)
  })

  it("warns that a 'neither' verdict is a keyword question, not a shape question", () => {
    const result = sample()
    result.findings.keywordForm = 'neither'
    expect(renderMarkdown(result)).toMatch(/item 17/i)
  })
})

describe('renderRawCapture', () => {
  it('emits one JSON object per line, after a header line', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'send', offsetMs: 0, hex: 'aabb' },
      { seq: 1, direction: 'recv', offsetMs: 1, hex: 'ccdd' },
    ]
    const lines = renderRawCapture(events).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    const header = JSON.parse(lines[0]!)
    // The header must say what is in the file, in words, before anyone
    // attaches it to a public issue.
    expect(header.warning).toMatch(/comm key/i)
    expect(JSON.parse(lines[1]!).hex).toBe('aabb')
  })
})

describe('renderJson', () => {
  it('carries the same findings as the markdown', () => {
    const json = renderJson(sample()) as { findings: { identity: { deviceName: string } } }
    expect(json.findings.identity.deviceName).toBe('MB360')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/report.spec.ts`
Expected: FAIL — cannot resolve `src/diagnostics/report.js`.

- [ ] **Step 3: Implement**

Create `src/diagnostics/report.ts`. Requirements the tests above pin, and which the implementation must satisfy:

- `renderJson` returns the result as a plain object; no filtering is needed, because nothing sensitive was ever put into `Findings` (Tasks 4 and 6 enforce that at the source, which is the right place — a renderer that stripped secrets would be one edit away from leaking them).
- `renderMarkdown` emits, in order: a header (library version, host, transport, `startedAt`, duration); a truncation notice when `truncated` is non-null, naming the step; a device section printing `deviceName`, `platform`, `os`, `firmwareVersion` and serial *presence*; a checklist table covering items 1–23, each marked answered / not answered / not testable; and a per-step table.
- Item 22's row must read *not testable by this tool*.
- Items 8, 9, 10, 12, 13 and 14 need a **fourth** state: *not requested*, used when `findings.realtime` / `findings.concurrent` are null because the operator did not pass `--realtime` / `--concurrent` (Task 10). This must not be rendered as *not answered* — the device was never asked, which is a different claim from the device declining to say. Add a `renderMarkdown` test pinning it:

```ts
  it("marks the one-way probes 'not requested' when they were not run", () => {
    const md = renderMarkdown(sample())   // findings.realtime and .concurrent are null
    expect(md).toMatch(/not requested/i)
    expect(md).not.toMatch(/item 10[^\n]*not answered/i)
  })
```
- The keyword-form row must expand the verdict into its consequence, using this exact mapping:

```ts
const KEYWORD_FORM_NOTE: Record<KeywordFormVerdict, string> = {
  both: 'Device tolerates either request shape. The assumption encodeParamRequest rests on is confirmed.',
  'nul-only': 'Device requires the trailing NUL. encodeParamRequest is correct and item 18 is settled.',
  'bare-only': 'Device REFUSES the trailing NUL. encodeParamRequest is wrong: send the bare keyword. One line in src/codec/params.ts plus two dependent test edits.',
  neither: 'The keyword was refused in BOTH shapes, so this is a keyword question (item 17), not a shape question. Re-run the A/B against a keyword this firmware exposes before recording any item-18 answer.',
}
```

- `renderRawCapture` emits a first line of
  `{"kind":"header","warning":"UNREDACTED. Contains the mixed comm key from CMD_AUTH, employee names and user ids. Review before sharing.","events":<n>}`
  then one `JSON.stringify(event)` per line, each newline-terminated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/diagnostics/report.spec.ts && npx tsc --noEmit`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/report.ts test/diagnostics/report.spec.ts
git commit -m "feat(diagnostics): render the shareable report and the raw capture

Three pure functions; the CLI writes what they return. Nothing sensitive is
filtered here because nothing sensitive was ever put into Findings -- redaction
belongs at the source, and a renderer that stripped secrets would be one edit
away from leaking them.

The keyword-form row expands each verdict into its consequence, including that
'neither' is a keyword question (item 17) rather than a shape question. Without
that sentence the first real result gets logged against the wrong item.

Item 22 is printed as 'not testable by this tool' rather than omitted: an
absence must be visible as an absence where a reader would assume presence.

The raw capture's first line says in words that the file holds the comm key and
employee names, because it is read by someone deciding whether to attach it to
an issue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CLI and packaging

**Files:**
- Create: `src/cli.ts`
- Modify: `tsup.config.ts`, `package.json`
- Test: `test/diagnostics/cli.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `parseCliArgs(argv: string[]): CliOptions` (exported for test), and a `main()` that is invoked only when the module is the entry point.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/cli.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli.js'

describe('parseCliArgs', () => {
  it('takes the host as a positional and defaults everything else', () => {
    const opts = parseCliArgs(['192.168.1.201'])
    expect(opts).toMatchObject({
      host: '192.168.1.201', port: 4370, transport: 'tcp',
      attendance: 'auto', commKey: 0, rawCapture: null,
    })
  })

  it('accepts the documented flags', () => {
    const opts = parseCliArgs([
      '10.0.0.5', '--transport=udp', '--port=5000', '--comm-key=1234',
      '--attendance=always', '--raw-capture=trace.jsonl', '--timeout=9000',
      '--realtime=30', '--concurrent',
    ])
    expect(opts).toMatchObject({
      host: '10.0.0.5', port: 5000, transport: 'udp', commKey: 1234,
      attendance: 'always', rawCapture: 'trace.jsonl', timeoutMs: 9000,
      realtimeSeconds: 30, concurrent: true,
    })
  })

  it('leaves the one-way probes off unless asked', () => {
    // Subscribing flips the transport irreversibly (Transport.listen is
    // one-way, once per socket). That must not happen to someone who typed
    // the bare command.
    const opts = parseCliArgs(['192.168.1.201'])
    expect(opts.realtimeSeconds).toBe(0)
    expect(opts.concurrent).toBe(false)
  })

  it('rejects an unknown attendance mode rather than silently defaulting', () => {
    expect(() => parseCliArgs(['h', '--attendance=sometimes'])).toThrow(/attendance/)
  })

  it('rejects a missing host', () => {
    expect(() => parseCliArgs([])).toThrow(/host/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/cli.spec.ts`
Expected: FAIL — cannot resolve `src/cli.js`.

- [ ] **Step 3: Implement**

Create `src/cli.ts` beginning with `#!/usr/bin/env node`. It must:

- export `interface CliOptions { host: string; port: number; transport: 'tcp'|'udp'; commKey: number; timeoutMs: number; attendance: 'auto'|'always'|'never'; rawCapture: string | null; out: string | null; realtimeSeconds: number; concurrent: boolean }`, with `realtimeSeconds` defaulting to `0` (off) and `concurrent` to `false`
- export `parseCliArgs(argv: string[]): CliOptions` using `parseArgs` from `node:util` with `allowPositionals: true`, validating `transport` and `attendance` against their literal sets and throwing an `Error` naming the offending option. A missing positional throws `new Error('a host is required: zkteco-protocol <host>')`.
- define `main()` which: builds the transport, wraps it in `TracingTransport` with `() => Date.now()`, opens a `Session`, runs `probeIdentity` → `probeState` → `probeBulk` under one `StepRunner`, then — **in this order, and only when asked** — `probeConcurrent` and finally `probeRealtime` (Task 10). Order is not cosmetic: `probeConcurrent` needs the first session still usable, and `probeRealtime` flips the transport one-way, so nothing can follow it. Then sets `findings.checksum = auditChecksums(traced.events)`, closes the session in a `finally`, and writes the Markdown to stdout (or `--out`), the JSON sidecar next to it, and the raw capture only when `--raw-capture` was given.
- exit `0` whenever the probe ran, **even if every step failed**, and non-zero only when `connect()` threw or a file write threw. Spec §5.5.
- invoke `main()` only when run as the entry point, so importing the module in tests does not start a probe:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
```

Update `tsup.config.ts`:

```ts
  entry: ['src/index.ts', 'src/cli.ts'],
```

Update `package.json`: add `"bin": { "zkteco-protocol": "./dist/cli.js" }` and set `"version": "0.4.0"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass; `dist/cli.js` exists and starts with the shebang.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/diagnostics/cli.spec.ts tsup.config.ts package.json
git commit -m "feat(cli): npx zkteco-protocol <host>

The one impure module: argument parsing, the clock, the filesystem and exit
codes live here and nowhere else, which is what keeps probe and report
deterministic under test.

Exit 0 whenever the probe RAN, even if the device refused everything. A
terminal that says no to twenty reads is a successful diagnostic and the report
is the deliverable; the reverse would make the tool look broken exactly when it
is working.

Zero runtime dependencies preserved -- parseArgs and fs are built-ins.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The two invariants, the bundle assertion, and the docs

**Files:**
- Create: `test/diagnostics/invariants.spec.ts`
- Modify: `test/smoke.spec.ts`, `README.md`, `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md`

**Interfaces:** consumes everything; produces nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/invariants.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { CMD } from '../../src/codec/commands.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { TracingTransport } from '../../src/diagnostics/TracingTransport.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { auditChecksums, emptyFindings, probeBulk, probeIdentity, probeState } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import { startEmulator, type Emulator } from '../emulator/index.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import type { ZkUser } from '../../src/types.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

const ALLOWED = new Set([
  CMD.CONNECT, CMD.EXIT, CMD.AUTH, CMD.OPTIONS_RRQ, CMD.GET_TIME, CMD.GET_VERSION,
  CMD.GET_FREE_SIZES, CMD.USERTEMP_RRQ, CMD.ATTLOG_RRQ, CMD.FREE_DATA,
  CMD.PREPARE_BUFFER, CMD.READ_BUFFER, CMD.REG_EVENT,
])

const SERIAL = 'SN-DO-NOT-LEAK'
const NAME = 'Zaphod Beeblebrox'
const USER_ID = 'EMP-9931'

function emUser(): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(1, 0)
  b.write(NAME, 11, 24, 'latin1')
  b.write(USER_ID, 48, 8, 'latin1')
  return { uid: 1, userId: USER_ID, name: NAME, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

async function runProbe() {
  running = await startEmulator({
    transport: 'tcp',
    params: { '~SerialNumber': SERIAL, '~DeviceName': 'MB360' },
    firmware: 'Ver 6.60',
    info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
    users: [emUser()],
  })
  const traced = new TracingTransport(
    new TcpTransport({ host: '127.0.0.1', port: running.port }),
    () => 0,
  )
  session = new Session(traced, { timeoutMs: 2000 })
  await session.open()
  const runner = new StepRunner()
  const findings = emptyFindings()
  await probeIdentity(session, runner, findings)
  await probeState(session, runner, findings, 0)
  await probeBulk(session, runner, findings, { transport: 'tcp', attendance: 'auto' })
  findings.checksum = auditChecksums(traced.events)
  return { traced, runner, findings }
}

describe('probe invariants', () => {
  it('never sends a command outside the allowlist', async () => {
    await runProbe()
    const sent = running!.received.map((p) => p.command)
    expect(sent.length).toBeGreaterThan(0)
    for (const command of sent) expect(ALLOWED.has(command)).toBe(true)
    // Named explicitly: v0.1 §6 ruled that disabling the device locks
    // employees out every poll cycle. A diagnostic must not reintroduce it.
    expect(sent).not.toContain(CMD.DISABLEDEVICE)
    expect(sent).not.toContain(CMD.ENABLEDEVICE)
  })

  it('keeps the serial, user names and ids out of both shareable artifacts', async () => {
    const { runner, findings, traced } = await runProbe()
    const result = {
      libraryVersion: '0.4.0', host: '127.0.0.1', transport: 'tcp' as const,
      startedAt: '2026-08-30T00:00:00.000Z', durationMs: 0,
      truncated: runner.truncated, steps: runner.steps, findings,
    }
    const md = renderMarkdown(result)
    const json = JSON.stringify(renderJson(result))
    for (const secret of [SERIAL, NAME, USER_ID]) {
      expect(md).not.toContain(secret)
      expect(json).not.toContain(secret)
    }

    // THE CONTROL. Without this the test above passes when the probe captured
    // nothing at all -- which is exactly the defect shape this project has
    // caught in every cycle so far.
    const raw = renderRawCapture(traced.events)
    expect(raw).toContain(Buffer.from(SERIAL, 'latin1').toString('hex'))
  })
})
```

Add to `test/smoke.spec.ts`:

```ts
  it('keeps diagnostics and CLI code out of the library bundle', async () => {
    const { readFileSync } = await import('node:fs')
    const bundle = readFileSync('dist/index.js', 'utf8')
    expect(bundle).not.toContain('TracingTransport')
    expect(bundle).not.toContain('ATTENDANCE_AUTO_THRESHOLD')
  })
```

and update the version assertion to `'0.4.0'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run test/diagnostics/invariants.spec.ts test/smoke.spec.ts`
Expected: the smoke version test FAILS on `'0.3.2'` vs `'0.4.0'` until Task 8's `package.json` change is paired with `src/index.ts`. The bundle test requires `npm run build` first — if `dist/` is stale it proves nothing.

- [ ] **Step 3: Implement**

Set `export const VERSION = '0.4.0'` in `src/index.ts`.

Add a **Diagnostics** section to `README.md` documenting `npx zkteco-protocol <host>`, every flag, the two artifacts, and — prominently — that the raw capture is unredacted and contains the comm key and employee data.

Add to the v0.1 spec's §12, item 22, a final sentence: *"Not testable by the bring-up kit (`npx zkteco-protocol`); it is reported there as such rather than omitted."*

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: everything green.

- [ ] **Step 5: Verify both invariants, then commit**

Break each and confirm the intended test reddens, separately:
1. Add `await session.execute(CMD.DISABLEDEVICE)` to `probeBulk`. The allowlist test must go red. Remove it.
2. Add the serial value to `findings.identity` under a new key. The redaction test must go red on the Markdown assertion. Remove it.
3. Make `renderRawCapture` return only its header line. The **control** assertion must go red. Restore.

Step 3 is the one that matters most: it is what proves the redaction test cannot pass vacuously.

```bash
git add test/diagnostics/invariants.spec.ts test/smoke.spec.ts src/index.ts README.md docs/
git commit -m "test(diagnostics): the write allowlist and the redaction control

Two invariants, both enforced rather than intended.

The allowlist test fails the day someone adds a convenient DISABLEDEVICE. v0.1
section 6 ruled that disabling locks employees out every poll cycle and accepted
the interleaved-write risk instead; a diagnostic must not quietly reverse that.

The redaction test asserts the serial and employee data appear in neither
shareable artifact AND that they DO appear in the raw capture. The second half
is the control: without it the test passes when the probe captured nothing at
all, which is the exact defect shape this project has caught in every cycle.
Verified by stubbing renderRawCapture down to its header and watching the
control assertion go red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The opt-in one-way probes — realtime and second connection

**Ordering:** this task depends on Tasks 3–8 and must be implemented last. `probeRealtime` is the only part of the probe that cannot be undone: `Transport.listen` is one-way, once per socket, and after it the session can never answer a request again.

**Files:**
- Modify: `src/diagnostics/probe.ts`, `src/cli.ts`
- Test: `test/diagnostics/probe.realtime.spec.ts`

**Interfaces:**
- Consumes: `StepRunner`, `Findings`, `Session.subscribe`.
- Produces:
  - `Findings.concurrent: { attempted: boolean; accepted: boolean; error: string | null } | null`
  - `Findings.realtime: { windowSeconds: number; registered: boolean; eventsObserved: number; eventTypes: number[]; desyncOnRegister: boolean; error: string | null } | null`
  - `async function probeConcurrent(runner, findings, opts: { host: string; port: number; transport: 'tcp'|'udp'; timeoutMs: number }): Promise<void>`
  - `async function probeRealtime(session, runner, findings, opts: { windowSeconds: number; sleep: (ms: number) => Promise<void> }): Promise<void>`

`sleep` is injected so the test does not wait real seconds — the same purity discipline as the injected clocks.

- [ ] **Step 1: Write the failing test**

Create `test/diagnostics/probe.realtime.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_FLAG } from '../../src/codec/events.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import { emptyFindings, probeConcurrent, probeRealtime } from '../../src/diagnostics/probe.js'
import { startEmulator, type Emulator } from '../emulator/index.js'

let running: Emulator | null = null
let session: Session | null = null
afterEach(async () => {
  await session?.close().catch(() => {}); session = null
  await running?.close(); running = null
})

async function open(port: number): Promise<Session> {
  const s = new Session(new TcpTransport({ host: '127.0.0.1', port }), { timeoutMs: 1000 })
  await s.open()
  return s
}

function attendancePayload(userId: string): Buffer {
  const buf = Buffer.alloc(32)
  buf.write(userId, 0, 9, 'latin1')
  buf.set([26, 8, 27, 8, 1, 30], 26)
  return buf
}

describe('probeConcurrent', () => {
  it('records that a second connection was accepted', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeConcurrent(new StepRunner(), findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000,
    })
    expect(findings.concurrent).toMatchObject({ attempted: true, accepted: true, error: null })
  })

  it('records a refused second connection as data rather than throwing', async () => {
    // Item 10 is answered by either outcome. A device that refuses is a real
    // finding, not a failure of the probe.
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeConcurrent(runner, findings, {
      host: '127.0.0.1', port: 1, transport: 'tcp', timeoutMs: 300,
    })
    expect(findings.concurrent?.accepted).toBe(false)
    expect(findings.concurrent?.error).toBeTruthy()
    // It must not truncate the run: this probe opens its OWN socket, so its
    // failure says nothing about the session the rest of the probe is using.
    expect(runner.truncated).toBeNull()
  })
})

describe('probeRealtime', () => {
  it('registers and counts the events that arrive in the window', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('A1'))
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('B2'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 5, sleep })
    expect(findings.realtime).toMatchObject({ registered: true, windowSeconds: 5 })
    expect(findings.realtime!.eventsObserved).toBe(2)
    expect(findings.realtime!.eventTypes).toContain(EVENT_FLAG.ATTENDANCE)
    session = null // the transport is one-way now; teardown happens below
  })

  it('records a refused registration without ending the run', async () => {
    running = await startEmulator({ transport: 'tcp', refuseRegEvent: true })
    session = await open(running.port)
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeRealtime(session, runner, findings, {
      windowSeconds: 1, sleep: async () => {},
    })
    expect(findings.realtime).toMatchObject({ registered: false })
    expect(findings.realtime?.error).toBeTruthy()
  })

  it('never records event payload contents, only types and a count', async () => {
    running = await startEmulator({ transport: 'tcp' })
    session = await open(running.port)
    const findings = emptyFindings()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('SECRET99'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 1, sleep })
    expect(JSON.stringify(findings)).not.toContain('SECRET99')
    session = null
  })
})
```

If `startEmulator` has no `refuseRegEvent` option, add one in this task the same way Task 1 added `keywordForm`: an option defaulting to `false`, with the `CMD.REG_EVENT` handler replying `CMD.ACK_ERROR` when it is set. Do not fake the refusal by other means — the point is to exercise the real refusal path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/diagnostics/probe.realtime.spec.ts`
Expected: FAIL — `probeConcurrent` and `probeRealtime` are not exported.

- [ ] **Step 3: Implement**

Add to `Findings` and `emptyFindings()`:

```ts
  concurrent: { attempted: boolean; accepted: boolean; error: string | null } | null
  realtime: {
    windowSeconds: number
    registered: boolean
    eventsObserved: number
    eventTypes: number[]
    desyncOnRegister: boolean
    error: string | null
  } | null
```

Append to `src/diagnostics/probe.ts`:

```ts
/**
 * Checklist item 10: does the device accept a second concurrent connection?
 *
 * This decides whether a consumer can poll and subscribe at the same time
 * (v0.2 §3.1), which is why ZkDevice makes opening a second connection a
 * visible decision rather than an assumption.
 *
 * Runs on its OWN socket and never touches the caller's session, so a refusal
 * here says nothing about the session the rest of the probe is using — which
 * is why a failure records `accepted: false` instead of truncating the run.
 * Both outcomes answer the item.
 */
export async function probeConcurrent(
  runner: StepRunner,
  findings: Findings,
  opts: { host: string; port: number; transport: 'tcp' | 'udp'; timeoutMs: number },
): Promise<void> {
  await runner.run('second-connection', async () => {
    const transport =
      opts.transport === 'tcp'
        ? new TcpTransport({ host: opts.host, port: opts.port })
        : new UdpTransport({ host: opts.host, port: opts.port })
    const second = new Session(transport, { timeoutMs: opts.timeoutMs })
    try {
      await second.open()
      findings.concurrent = { attempted: true, accepted: true, error: null }
      await second.close().catch(() => {})
    } catch (err) {
      findings.concurrent = {
        attempted: true,
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    return findings.concurrent
  })
}

/**
 * Checklist items 8, 9, 12, 13 and 14: what a live subscription actually does.
 *
 * MUST BE LAST. Transport.listen is one-way, once per socket (v0.2 §3.1), so
 * after this the session can never answer a request again. Nothing may follow
 * it, and the CLI runs it only when --realtime is passed.
 *
 * Only event TYPES and a count are recorded. An event payload is a punch by a
 * named person, and no checklist item needs its contents.
 *
 * A desync — the device pushing an event before acknowledging CMD_REG_EVENT —
 * is item 14, and Session.subscribe tears the session down when it happens.
 * That is designed behaviour rather than a bug, so it is recorded as an
 * observation rather than propagated as a failure. If a real terminal does it
 * routinely rather than rarely, v0.2 §3.1's trade-off is worth revisiting with
 * the count this field provides.
 */
export async function probeRealtime(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  opts: { windowSeconds: number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  await runner.run('realtime', async () => {
    const types = new Set<number>()
    let observed = 0
    findings.realtime = {
      windowSeconds: opts.windowSeconds,
      registered: false,
      eventsObserved: 0,
      eventTypes: [],
      desyncOnRegister: false,
      error: null,
    }
    try {
      await session.subscribe(
        EVENT_FLAG.ATTENDANCE,
        (pkt) => {
          observed += 1
          // The event type occupies the session-id slot (v0.2 §5.1) — itself a
          // checklist item, which is why the raw type is recorded rather than a
          // decoded name.
          types.add(pkt.sessionId)
        },
        () => {},
      )
      findings.realtime.registered = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      findings.realtime.error = message
      findings.realtime.desyncOnRegister = /out of step/.test(message)
      return findings.realtime
    }
    await opts.sleep(opts.windowSeconds * 1000)
    findings.realtime.eventsObserved = observed
    findings.realtime.eventTypes = [...types].sort((a, b) => a - b)
    return findings.realtime
  })
}
```

Add the imports these need at the top of `probe.ts`: `Session`, `TcpTransport`, `UdpTransport`, `EVENT_FLAG`.

In `src/cli.ts`, wire the two probes in `main()` in the order given in Task 8, guarded by `opts.concurrent` and `opts.realtimeSeconds > 0`, passing `sleep: (ms) => new Promise((r) => setTimeout(r, ms))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: everything green. Task 9's allowlist test must still pass — `REG_EVENT` is on the allowlist, and the second connection sends only `CONNECT`/`EXIT`.

- [ ] **Step 5: Verify the guard, then commit**

Add the event payload to `findings.realtime` under a new key and confirm the "never records event payload contents" test goes red on `not.toContain('SECRET99')`. Restore.

```bash
git add src/diagnostics/probe.ts src/cli.ts test/diagnostics/probe.realtime.spec.ts test/emulator/index.ts
git commit -m "feat(diagnostics): opt-in realtime and second-connection probes

The last five checklist items a tool can reach: 8, 9, 12, 13 and 14 from a live
subscription, and 10 from a second connection.

Both are opt-in and realtime runs last, because Transport.listen is one-way and
once per socket -- after it the session can never answer a request again. That
must not happen to someone who typed the bare command, so --realtime and
--concurrent default to off.

probeConcurrent uses its own socket and records a refusal as data rather than
truncating: a device refusing a second connection is the answer to item 10, and
says nothing about the session the rest of the probe is using.

A desync on registration is item 14 and is recorded as an observation, not
propagated as a failure -- Session.subscribe tearing the session down there is
designed behaviour (v0.2 RULING R11), and what is missing is the frequency,
which this field supplies.

Only event types and a count are recorded; an event payload is a punch by a
named person. Verified by recording one deliberately and watching the test go
red.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** §3.1 modules → Tasks 2, 3, 4–6, 7, 8. §3.2 per-step isolation → Task 3, and the per-key sweep in Task 4. §3.3 decorator → Task 2. §3.4 packaging → Task 8. §4.1 sequence → Tasks 4–6 in order. §4.2 A/B → Task 4. §4.3 attendance guard → Task 6. §4.4 allowlist → Task 9. §4.5 coverage map → Task 7's checklist table. §4.6 item 22 → Task 7 and Task 9's doc edit. §5.1–5.4 artifacts → Task 7. §5.5 exit codes → Task 8. §6 error isolation → Task 3. §7.1 scenarios → Tasks 2, 3, 5, 6; scenario 5 → Tasks 1 and 4. §7.2 invariants → Task 9. §7.3 purity → Global Constraints, enforced by injected clocks in Tasks 2 and 5. §7.4 countermeasure → the verification steps in Tasks 3, 4, 6, 9.

**Gap found and closed:** §4.1 step 8 — the opt-in realtime and second-connection probes — initially had no task. It is now **Task 10**, so the plan covers the spec completely and a first-hardware session can reach every item a tool can reach in one run.

Task 10 carries two constraints that ripple backwards, and both are already reflected above:
- **Ordering is load-bearing, not cosmetic.** `probeConcurrent` needs the first session still usable, and `probeRealtime` flips the transport one-way — `Transport.listen` is one-way, once per socket (v0.2 §3.1) — so nothing can follow it. Task 8's `main()` spells out the sequence.
- **Both default to off.** Subscribing cannot be undone, so it must never happen to someone who typed the bare command. Task 8's parse test pins `realtimeSeconds: 0` and `concurrent: false` for the bare invocation.

Task 7's checklist table therefore marks items 8, 9, 10, 12, 13 and 14 as *answered when the probe was run, not requested otherwise* — which is a third state, distinct from both *not answered* and *not testable*, and the renderer must not collapse it into either.

**Type consistency:** `Findings` is defined once in Task 4 and extended in Tasks 5 and 6; `emptyFindings()` is updated alongside each extension. `StepRunner.run` returns `T | undefined` in Task 3 and every call site treats it as optional. `ProbeResult` is defined in Task 7 and constructed identically in Tasks 8 and 9.
