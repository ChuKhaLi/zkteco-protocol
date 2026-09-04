# Diagnostics Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every row the bring-up kit prints, every check the release drill runs, and every fixture the capture tool writes claim only what the wire showed.

**Architecture:** Fixes land at each finding's source: the step runner classifies refusals by reply code, the tracer records a send only after the write resolved, each probe derives its findings from the trace, and the renderer derives each checklist state from those findings through one helper. The drill grows three checks and moves into CI; the capture tool stops writing crashed runs. Nothing changes what goes on the wire.

**Tech Stack:** TypeScript, Node ≥ 20.19, `node:net`/`node:dgram` only, vitest against the emulator in `test/emulator/`, tsup, pnpm. The drill is a plain `.mjs` script.

**Spec:** `docs/superpowers/specs/2026-09-03-zkteco-diagnostics-evidence-design.md`

## Global Constraints

- **No runtime dependencies.** `node:net` and `node:dgram` only; never a native module.
- **Nothing here changes what goes on the wire** (spec §2.2). No new command; the allowlist in `test/diagnostics/invariants.spec.ts` is unchanged; `PROVENANCE.md` is unchanged.
- **`src/` outside `src/diagnostics/` and `src/cli.ts` is read, never edited** (spec §2.2). The one message coupling added (spec §4.2) is pinned by a test against the real library.
- **Redaction at the source.** `Findings` carries booleans, counts, and the sanctioned identity strings; user names, ids, attendance rows, the serial value and the comm key never enter it. `TraceEvent` reaches only the opt-in raw capture. `freeSizes.rawHex` is the one bounded exception.
- **`src/cli.ts` is the only impure module.** No `Date.now()`, argless `new Date()`, `process.*`, or filesystem import under `src/diagnostics/`; `test/diagnostics/invariants.spec.ts` enforces it.
- **Run `pnpm build` before `pnpm test`.** Full check: `pnpm build && pnpm typecheck && pnpm test`.
- **Every fix has a test in both directions** (spec §10): the test passes after the fix, and once against the pre-fix code (the named mutation) it fails **for the reason named**. Each task says how.
- **Do not add first-hardware checklist items.** Item 8 changes state; nothing is added.
- **Do not read `pyzk` source.** Task 15 executes it only.
- **Imports use `.js` extensions** even from `.ts` files.
- **Version stays 0.5.0.** The tag is pushed by the controller after the final review (spec §12), never by a task.
- **Commit after every task.** Message style: `type(scope): what, in the project's voice`.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/diagnostics/step.ts` | `declined()`, `replyOutcome()`, `classifyError` with the refused mapping, attribution of the deciding exchange |
| `src/diagnostics/TracingTransport.ts` | records a send after the write; `attemptedCommand` on a failed write; framing prefix hex on a receive error |
| `src/diagnostics/types.ts` | `TraceEvent.attemptedCommand` |
| `src/diagnostics/probe.ts` | `sanitizeDeviceString`, `attendanceRequested`, the host-clock input, the parameter outcome enum, the realtime window, `createTransport` for the second connection |
| `src/diagnostics/report.ts` | `answeredIf`, the item states of spec §6.1, code spans and newline escaping |
| `src/cli.ts` | `--raw-capture=` rejection, `createTransport`, host clock and comm key handed to the probes, no `connected` flag |
| `tools/emulator-serve.ts` | one attendance record |
| `.claude/skills/release-drill/scripts/drill.mjs` | fourteen checks, process-group kill, quoted paths, flushed abort |
| `.claude/skills/release-drill/scripts/consumer-fixture.mjs` | the CommonJS consumer's source and tsconfig, shared with a test |
| `.github/workflows/ci.yml` | the `drill` job |
| `tools/oracle/run-oracle.ts` | `run()` and `runOracleScript()` returning exit codes |
| `tools/oracle/capture.ts` | skips a fixture on a failed run; exits non-zero at the end |
| `test/diagnostics/*.spec.ts`, `test/oracle/run-oracle.spec.ts`, `test/release-drill/consumer-fixture.spec.ts` | the tests named per task |

---

## Phase A — The step runner and the tracer

### Task 1: Refusals by reply code, and the deciding exchange (spec §4.2)

**Files:**
- Modify: `src/diagnostics/step.ts`
- Test: `test/diagnostics/step.spec.ts`

**Interfaces:**
- Consumes: `ZkProtocolError` (`src/errors.ts`), `CMD` (`src/codec/commands.ts`).
- Produces: `declined<T>(outcome: 'refused' | 'unauthorized', value?: T): Declined<T>`; `refused<T>(value?: T)` unchanged in meaning (`declined('refused', value)`); `replyOutcome(command: number): 'refused' | 'unauthorized' | null`; `REJECTED_COMMAND_MESSAGE` (exported regex); `classifyError` returns `'refused'` for a `ZkProtocolError` matching it; on a non-`ok` outcome `StepResult.command`/`ackCode` describe the last send in the span and its reply.

- [ ] **Step 1: Write the failing tests**

Append to `test/diagnostics/step.spec.ts` (inside the file, after the existing `describe('StepRunner with a trace', …)` block; add `ZkProtocolError` and `declined, replyOutcome, REJECTED_COMMAND_MESSAGE` to the imports from `../../src/errors.js` and `../../src/diagnostics/step.js`, and `Session`, `TcpTransport`, `startEmulator`, `reply` imports as shown):

```ts
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

describe('replyOutcome', () => {
  it('maps the two refusal codes and nothing else', () => {
    expect(replyOutcome(CMD.ACK_ERROR)).toBe('refused')
    expect(replyOutcome(CMD.ACK_UNAUTH)).toBe('unauthorized')
    expect(replyOutcome(CMD.ACK_OK)).toBeNull()
    expect(replyOutcome(CMD.ACK_DATA)).toBeNull()
  })
})

describe('declined', () => {
  it("records 'unauthorized' when a callback reports declined('unauthorized')", async () => {
    const runner = new StepRunner()
    await runner.run('clock', async () => declined('unauthorized', null))
    expect(runner.steps[0]).toMatchObject({ name: 'clock', outcome: 'unauthorized' })
    expect(runner.truncated).toBeNull()
  })

  it("keeps refused() as declined('refused')", async () => {
    const runner = new StepRunner()
    await runner.run('firmware', async () => refused(null))
    expect(runner.steps[0]).toMatchObject({ outcome: 'refused' })
  })
})

describe("classifyError maps a device's ACK_ERROR to 'refused'", () => {
  it('recognises the message Session.execute throws for ACK_ERROR', () => {
    expect(classifyError(new ZkProtocolError('device rejected command 9'))).toBe('refused')
  })

  it('leaves every other ZkProtocolError malformed', () => {
    expect(classifyError(new ZkProtocolError('user body of 5 bytes is not a multiple of 72'))).toBe('malformed')
  })

  it('is pinned to what the real Session.execute throws', async () => {
    // A reworded throw site in src/session/Session.ts must redden THIS test,
    // not silently turn every refused read back into 'malformed'.
    let running: Emulator | null = null
    let session: Session | null = null
    try {
      running = await startEmulator({
        transport: 'tcp',
        handlers: { [CMD.USERTEMP_RRQ]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
      })
      session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), { timeoutMs: 1000 })
      await session.open()
      const err = await session.execute(CMD.USERTEMP_RRQ).then(() => null, (e: unknown) => e as Error)
      expect(err).toBeInstanceOf(ZkProtocolError)
      expect(err!.message).toMatch(REJECTED_COMMAND_MESSAGE)
      expect(classifyError(err)).toBe('refused')
    } finally {
      await session?.close().catch(() => {})
      await running?.close()
    }
  })
})

describe('StepRunner attributes the deciding exchange', () => {
  function traced2(): { events: TraceEvent[]; exchange: (command: number, ack: number) => void } {
    const events: TraceEvent[] = []
    const record = (direction: TraceEvent['direction'], command: number): void => {
      const payload = encodePayload({ command, sessionId: 1, replyId: events.length })
      events.push({ seq: events.length, direction, offsetMs: 0, hex: payload.toString('hex'), command, sessionId: 1, replyId: events.length })
    }
    return { events, exchange: (command, ack) => { record('send', command); record('recv', ack) } }
  }

  it('reports the FIRST exchange for a step that ended ok', async () => {
    const t = traced2()
    const runner = new StepRunner(() => t.events)
    await runner.run('attendance', async () => {
      t.exchange(CMD.GET_FREE_SIZES, CMD.ACK_OK)
      t.exchange(CMD.PREPARE_BUFFER, CMD.ACK_OK)
      t.exchange(CMD.GET_FREE_SIZES, CMD.ACK_OK)
      return 'x'
    })
    expect(runner.steps[0]).toMatchObject({ outcome: 'ok', command: CMD.GET_FREE_SIZES, ackCode: CMD.ACK_OK, exchanges: 3 })
  })

  it('reports the LAST exchange for a step that did not end ok, since that is the one that decided it', async () => {
    const t = traced2()
    const runner = new StepRunner(() => t.events)
    await runner.run('attendance', async () => {
      t.exchange(CMD.GET_FREE_SIZES, CMD.ACK_OK)
      t.exchange(CMD.PREPARE_BUFFER, CMD.ACK_OK)
      t.exchange(CMD.ATTLOG_RRQ, CMD.ACK_ERROR)
      throw new ZkProtocolError('device rejected command 13')
    })
    expect(runner.steps[0]).toMatchObject({ outcome: 'refused', command: CMD.ATTLOG_RRQ, ackCode: CMD.ACK_ERROR, exchanges: 3 })
  })

  it('reports the last exchange for a declined() step too', async () => {
    const t = traced2()
    const runner = new StepRunner(() => t.events)
    await runner.run('clock', async () => {
      t.exchange(CMD.GET_TIME, CMD.ACK_UNAUTH)
      return declined('unauthorized', null)
    })
    expect(runner.steps[0]).toMatchObject({ outcome: 'unauthorized', command: CMD.GET_TIME, ackCode: CMD.ACK_UNAUTH })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/step.spec.ts`
Expected: FAIL — `replyOutcome`, `declined`, `REJECTED_COMMAND_MESSAGE` are not exported; the "LAST exchange" test reports `command: 50` and outcome `malformed`.

- [ ] **Step 3: Implement**

In `src/diagnostics/step.ts`:

Replace the `classifyError` function and its docblock's last paragraph with:

```ts
import { ZkAuthError, ZkConnectionError, ZkError, ZkProtocolError, ZkTimeoutError } from '../errors.js'

/**
 * The message `Session.execute` throws when the device answers ACK_ERROR
 * (`src/session/Session.ts`). Matched here so a refused read is reported as
 * `refused`, which is what it is, rather than as `malformed`. A message
 * coupling of the same kind as report.ts's DECLARED_SIZE_CAP_MESSAGE, pinned
 * the same way: test/diagnostics/step.spec.ts drives the real Session against
 * an emulator answering ACK_ERROR, so a reworded throw site reddens that test
 * instead of silently turning refusals back into 'malformed'.
 */
export const REJECTED_COMMAND_MESSAGE = /^device rejected command \d+/

export function classifyError(err: unknown): Exclude<StepOutcome, 'ok'> {
  if (err instanceof ZkAuthError) return 'unauthorized'
  if (err instanceof ZkTimeoutError) return 'silent'
  if (err instanceof ZkConnectionError) return 'dropped'
  if (err instanceof ZkProtocolError && REJECTED_COMMAND_MESSAGE.test(err.message)) return 'refused'
  return 'malformed'
}
```

Add after `classifyError`:

```ts
/**
 * The step outcome a `tryExecute` reply code carries, or null when the reply
 * was an answer. Every step that decodes a reply inline checks this first, so
 * an ACK_UNAUTH body is never decoded as if it were the value it stands in
 * for (an ACK_UNAUTH with four bytes used to become the device clock).
 */
export function replyOutcome(command: number): 'refused' | 'unauthorized' | null {
  if (command === CMD.ACK_ERROR) return 'refused'
  if (command === CMD.ACK_UNAUTH) return 'unauthorized'
  return null
}
```

(add `import { CMD } from '../codec/commands.js'` at the top.)

Replace the `Refused` interface, `refused`, and `isRefused` with:

```ts
export type DeclinedOutcome = 'refused' | 'unauthorized'

/**
 * Returned from a `run()` callback to record `'refused'` or `'unauthorized'`
 * instead of `'ok'`, without throwing. `classifyError` only ever sees thrown
 * errors, but steps that decode a `tryExecute` reply inline see the ack code
 * as a value; this is the value-shaped way to say what it was.
 */
export interface Declined<T> {
  readonly [REFUSED]: DeclinedOutcome
  readonly value: T | undefined
}

export function declined<T>(outcome: DeclinedOutcome, value?: T): Declined<T> {
  return { [REFUSED]: outcome, value }
}

/** `declined('refused', value)`, kept under the name every existing step uses. */
export function refused<T>(value?: T): Declined<T> {
  return declined('refused', value)
}

function isDeclined<T>(x: T | Declined<T>): x is Declined<T> {
  return typeof x === 'object' && x !== null && REFUSED in x
}
```

In `run()`, replace the `isRefused` branch with:

```ts
      if (isDeclined(outcome)) {
        this.results.push({ name, outcome: outcome[REFUSED], value: outcome.value, ...this.attribute(from, false) })
        return outcome.value
      }
      this.results.push({ name, outcome: 'ok', value: outcome, ...this.attribute(from, true) })
      return outcome
```

and in the catch: `const result: StepResult<unknown> = { name, outcome, ...this.attribute(from, false) }`.

Replace `attribute` with:

```ts
  /**
   * Attributes the trace span a step produced back to that step.
   *
   * The span is everything appended from `from` onward, which is exactly what
   * this step's callback caused: `run` is not re-entrant and the probe awaits
   * each step before starting the next.
   *
   * WHICH exchange depends on how the step ended. A step that ended `ok` is
   * named for the command it is about, which is its first send (readBulk's
   * buffered path ends on FREE_DATA, so the last would print the cleanup). A
   * step that did not end `ok` is decided by its last exchange — the request
   * the device refused, or the one that never came back — and that is the one
   * a reader needs to see beside the outcome: the attendance step used to
   * print `50 x4 | 2000 | refused | device rejected command 13`, attributing a
   * refusal of 13 to a 50 the device had answered. `exchanges` counts every
   * send either way.
   *
   * The reply taken is the first `recv` after the chosen send; a 'push' is
   * skipped, since an unsolicited realtime event acknowledges nothing.
   */
  private attribute(from: number, endedOk: boolean): Pick<StepResult, 'command' | 'ackCode' | 'exchanges'> {
    const span = (this.trace?.() ?? []).slice(from)
    const sends = span.filter((e) => e.direction === 'send')
    const chosen = endedOk ? sends[0] : sends[sends.length - 1]
    if (!chosen) return {}
    const ack = span.slice(span.indexOf(chosen) + 1).find((e) => e.direction === 'recv')
    const attributed: Pick<StepResult, 'command' | 'ackCode' | 'exchanges'> = {
      exchanges: sends.length,
    }
    if (chosen.command !== undefined) attributed.command = chosen.command
    if (ack?.command !== undefined) attributed.ackCode = ack.command
    return attributed
  }
```

Update `run()`'s docblock sentence "including the value inside a `refused(value)`" to "including the value inside a `declined(outcome, value)`".

- [ ] **Step 4: Run to see them pass, then the diagnostics suite**

Run: `npx vitest run test/diagnostics`
Expected: PASS. The existing "records the command even when the step then threw" test still passes (a single-exchange step's first and last send are the same).

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/step.ts test/diagnostics/step.spec.ts
git commit -m "fix(diagnostics): a refusal is refused, not malformed, and the row names the exchange that decided it"
```

---

### Task 2: A send is recorded after the write, and the rejected prefix reaches the capture (spec §5)

**Files:**
- Modify: `src/diagnostics/TracingTransport.ts`, `src/diagnostics/types.ts`
- Test: `test/diagnostics/tracing.spec.ts`

**Interfaces:**
- Produces: `TraceEvent.attemptedCommand?: number` on an `error` event from a failed `send`; `TraceEvent.hex` on an `error` event from a `receive` that threw a `ZkError` carrying `raw`.

- [ ] **Step 1: Write the failing tests**

Append to `test/diagnostics/tracing.spec.ts` (add `ZkConnectionError, ZkFramingError` to the errors import and `import type { Transport } from '../../src/transport/Transport.js'`):

```ts
/** A transport whose send always fails, to see what the tracer records for it. */
function refusingSend(): Transport {
  return {
    connect: async () => {},
    send: async () => { throw new ZkConnectionError('socket refused the write') },
    receive: async () => { throw new ZkTimeoutError('never') },
    listen: () => {},
    close: async () => {},
  }
}

describe('TracingTransport records what actually moved', () => {
  it('does not record a send the socket refused, but says what was attempted', async () => {
    const traced = new TracingTransport(refusingSend(), fakeClock())
    const payload = encodePayload({ command: CMD.PREPARE_BUFFER, sessionId: 1, replyId: 1 })
    await expect(traced.send(payload)).rejects.toBeInstanceOf(ZkConnectionError)
    expect(traced.events.filter((e) => e.direction === 'send')).toHaveLength(0)
    const errors = traced.events.filter((e) => e.direction === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ errorClass: 'ZkConnectionError', attemptedCommand: CMD.PREPARE_BUFFER })
  })

  it('records the rejected framing prefix on the error event, for item 5', async () => {
    running = await startEmulator({ transport: 'tcp', handlers: { [CMD.GET_FREE_SIZES]: () => null } })
    const traced = new TracingTransport(new TcpTransport({ host: '127.0.0.1', port: running.port }), fakeClock())
    await traced.connect(2_000)
    await traced.send(encodePayload({ command: CMD.GET_FREE_SIZES, sessionId: 1, replyId: 1 }))
    const pending = traced.receive(2_000)
    await new Promise((r) => setTimeout(r, 50))
    for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
    await expect(pending).rejects.toBeInstanceOf(ZkFramingError)
    await traced.close()

    const errors = traced.events.filter((e) => e.direction === 'error')
    expect(errors[errors.length - 1]).toMatchObject({ errorClass: 'ZkFramingError', hex: 'deadbeefdeadbeef' })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/tracing.spec.ts`
Expected: FAIL — one `send` event is recorded for the refused write (`toHaveLength(0)` fails), and the framing error event has no `hex`.

- [ ] **Step 3: Implement**

In `src/diagnostics/types.ts`, add to `TraceEvent` after `errorMessage?: string`:

```ts
  /**
   * The command a `send` was carrying when the write failed. Present only on
   * an `error` event that replaced a `send` — the send itself is NOT recorded,
   * because nothing moved. Item 19 used to answer on a PREPARE_BUFFER the
   * socket refused; a reader of the capture still needs to see what was tried.
   */
  attemptedCommand?: number
```

In `src/diagnostics/TracingTransport.ts`, replace `record`'s `if (err)` block and `send`/`receive`:

```ts
    if (err) {
      event.errorClass = err.constructor.name
      event.errorMessage = err.message
      // A framing failure attaches the rejected 8-byte prefix as err.raw. The
      // raw capture is unredacted by contract (kit spec §5.4) and TraceEvent
      // reaches nothing else, so the prefix goes into the record here — this
      // is the file item 5's observation points the operator at.
      if (err instanceof ZkError && err.raw) event.hex = err.raw
    }
```

```ts
  async send(payload: Buffer): Promise<void> {
    try {
      await this.inner.send(payload)
    } catch (err) {
      // Recorded as an error and NOT as a send: nothing moved. bulkPrepareAttempted
      // (item 19) reads `send` events, and a write the socket refused is not
      // evidence the device saw an odd-length payload.
      const event = this.errorEvent(err as Error)
      try {
        event.attemptedCommand = decodePayload(payload).command
      } catch {
        // an undecodable payload is still an attempt; the class and message say so
      }
      this.log.push(event)
      throw err
    }
    this.record('send', payload)
  }
```

Refactor `record` so that the error path is reusable: extract `private errorEvent(err: Error): TraceEvent` that builds the event with `seq`, `direction: 'error'`, `offsetMs`, `errorClass`, `errorMessage`, and `hex` from `err.raw` as above; `record(direction, payload, err)` calls it when `err` is given. Import `ZkError` from `../errors.js`.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run test/diagnostics/tracing.spec.ts test/diagnostics/probe.bulk.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/TracingTransport.ts src/diagnostics/types.ts test/diagnostics/tracing.spec.ts
git commit -m "fix(diagnostics): the trace records a send only after the write, and keeps the rejected prefix for item 5"
```

---

## Phase B — The probes

### Task 3: The clock and free-sizes steps refuse to decode a refusal, and skew separates zone from drift (spec §4.2, §4.5)

**Files:**
- Modify: `src/diagnostics/probe.ts` (`Findings.clock`, `probeState`, `deviceEpochSeconds` callers)
- Test: `test/diagnostics/probe.state.spec.ts`

**Interfaces:**
- Consumes: `declined`, `replyOutcome` (Task 1).
- Produces: `probeState(session, runner, findings, host: HostClock)` with `export interface HostClock { epochSeconds: number; utcOffsetMinutes: number }`; `Findings.clock` gains `hostUtcOffsetMinutes: number`; `hostLocal` is the host's naive local time; `skewSeconds` is device-naive minus host-naive-local.

- [ ] **Step 1: Write the failing tests**

In `test/diagnostics/probe.state.spec.ts`, change every existing `probeState(session, new StepRunner(), findings, 0)` call to `probeState(session, new StepRunner(), findings, { epochSeconds: 0, utcOffsetMinutes: 0 })`, and the `1_756_000_000` call to `{ epochSeconds: 1_756_000_000, utcOffsetMinutes: 0 }`. Then add inside `describe('probeState', …)`:

```ts
  it("records 'unauthorized' and no clock when GET_TIME answers ACK_UNAUTH with a body", async () => {
    // Four bytes of ACK_UNAUTH used to decode as the device clock and answer item 21.
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_TIME]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH, Buffer.alloc(4))] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeState(session, runner, findings, { epochSeconds: 0, utcOffsetMinutes: 0 })
    expect(findings.clock).toBeNull()
    expect(runner.steps.find((s) => s.name === 'clock')).toMatchObject({ outcome: 'unauthorized' })
    expect(runner.truncated).toBeNull()
  })

  it("records 'refused', not ok, when the device refuses the clock", async () => {
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_TIME]: (req, state) => [reply(state, req, CMD.ACK_ERROR)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    await probeState(session, runner, emptyFindings(), { epochSeconds: 0, utcOffsetMinutes: 0 })
    expect(runner.steps.find((s) => s.name === 'clock')).toMatchObject({ outcome: 'refused' })
  })

  it("records 'unauthorized' when GET_FREE_SIZES answers ACK_UNAUTH", async () => {
    running = await startEmulator({
      transport: 'tcp',
      handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeState(session, runner, findings, { epochSeconds: 0, utcOffsetMinutes: 0 })
    expect(findings.freeSizes).toBeNull()
    expect(runner.steps.find((s) => s.name === 'free-sizes')).toMatchObject({ outcome: 'unauthorized' })
  })

  it('compares the device clock with the host LOCAL clock, and records the zone beside it', async () => {
    // deviceTimeRaw 0 is 2000-01-01T00:00:00 naive. A host at UTC+7 whose
    // local wall clock reads the same instant is 1999-12-31T17:00:00Z, i.e.
    // epoch 946659600. Comparing naive-to-UTC used to report the whole zone
    // offset (25200 s) as drift.
    running = await startEmulator({ transport: 'tcp', deviceTimeRaw: 0 })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeState(session, new StepRunner(), findings, { epochSeconds: 946_659_600, utcOffsetMinutes: 420 })
    expect(findings.clock).toMatchObject({
      deviceLocal: '2000-01-01T00:00:00',
      hostLocal: '2000-01-01T00:00:00',
      hostUtcOffsetMinutes: 420,
      skewSeconds: 0,
    })
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/probe.state.spec.ts`
Expected: FAIL — typecheck of the new fourth argument, then: the ACK_UNAUTH clock test finds `findings.clock` populated and outcome `ok`; the zone test reports `skewSeconds: 25200` and `hostLocal: '1999-12-31T17:00:00'`.

- [ ] **Step 3: Implement**

In `src/diagnostics/probe.ts`:

Change the `clock` member of `Findings` to:

```ts
  clock: {
    deviceLocal: string
    /** The host's naive LOCAL wall-clock time, formatted exactly as deviceLocal. */
    hostLocal: string
    /** The host's UTC offset when it read its clock, so a reader can separate zone from drift. */
    hostUtcOffsetMinutes: number
    /**
     * Device naive time minus host naive local time, in seconds. Null when the
     * device's packed timestamp decoded to a day that does not exist on a real
     * calendar (decodeZkTime's pseudo-calendar allows e.g. 2026-02-31);
     * deviceLocal and hostLocal are still recorded verbatim in that case.
     */
    skewSeconds: number | null
  } | null
```

Add before `probeState`:

```ts
/** The host clock as the CLI read it: the only module allowed to read one. */
export interface HostClock {
  epochSeconds: number
  /** `-new Date().getTimezoneOffset()` — positive east of UTC. */
  utcOffsetMinutes: number
}

/** The host's naive local time, formatted like decodeZkTime's `local` (a `T` separator). */
function hostLocalString(host: HostClock): string {
  return new Date((host.epochSeconds + host.utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 19)
}
```

Replace `probeState`:

```ts
export async function probeState(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  host: HostClock,
): Promise<void> {
  await runner.run('clock', async () => {
    const res = await session.tryExecute(CMD.GET_TIME)
    // Checked BEFORE the length: an ACK_UNAUTH carrying four bytes is not a
    // clock, and decoding it as one answered item 21 from a reply that
    // acknowledged nothing.
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    if (res.data.length < 4) throw new ZkProtocolError(`CMD_GET_TIME answered with ${res.data.length} byte(s), not a packed time`)
    const device = decodeZkTime(res.data.readUInt32LE(0))
    // Naive against naive. The device stores wall-clock time with no zone
    // (ZkNaiveTime), so the only like-for-like comparison is the host's own
    // wall clock; the host's UTC offset is recorded so a reader can tell a
    // zone difference from drift. Recorded side by side and NOT judged.
    const hostLocal = hostLocalString(host)
    const deviceEpoch = deviceEpochSeconds(device)
    findings.clock = {
      deviceLocal: device.local,
      hostLocal,
      hostUtcOffsetMinutes: host.utcOffsetMinutes,
      skewSeconds: deviceEpoch === null ? null : deviceEpoch - (host.epochSeconds + host.utcOffsetMinutes * 60),
    }
    return findings.clock
  })

  await runner.run('free-sizes', async () => {
    const res = await session.tryExecute(CMD.GET_FREE_SIZES)
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    if (res.data.length < REQUIRED_FREE_SIZES) {
      throw new ZkProtocolError(`CMD_GET_FREE_SIZES answered with ${res.data.length} byte(s); ${REQUIRED_FREE_SIZES} are needed for the offsets`)
    }
    findings.freeSizes = {
      userCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.userCount),
      recordCount: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCount),
      recordCapacity: res.data.readUInt32LE(FREE_SIZES_OFFSET.recordCapacity),
      rawHex: res.data.subarray(0, FREE_SIZES_RAW_MAX_BYTES).toString('hex'),
    }
    return findings.freeSizes
  })
}
```

Imports: `import { ZkAuthError, ZkProtocolError } from '../errors.js'` and `import { declined, refused, replyOutcome, type StepRunner } from './step.js'`. `deviceEpochSeconds` is unchanged (it computes the device's naive time as if UTC, which is exactly the naive-to-naive arithmetic needed once the host side is shifted by its offset).

Update the callers that still pass a number: `src/cli.ts` (Task 10 finishes it; for now change `Math.floor(Date.now() / 1000)` to `{ epochSeconds: Math.floor(Date.now() / 1000), utcOffsetMinutes: -new Date().getTimezoneOffset() }`) and `test/diagnostics/invariants.spec.ts`'s `probeState(session, runner, findings, 0)` to `{ epochSeconds: 0, utcOffsetMinutes: 0 }`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm typecheck && npx vitest run test/diagnostics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/probe.ts src/cli.ts test/diagnostics/probe.state.spec.ts test/diagnostics/invariants.spec.ts
git commit -m "fix(diagnostics): the clock and free-sizes steps record a refusal as one, and skew is measured against the host's local clock"
```

---

### Task 4: The attendance read is a wire fact (spec §4.1)

**Files:**
- Modify: `src/diagnostics/probe.ts` (`probeBulk`, new export)
- Test: `test/diagnostics/probe.bulk.spec.ts`

**Interfaces:**
- Produces: `attendanceRequested(events: readonly TraceEvent[]): boolean` — true when a send in `events` is a direct `CMD.ATTLOG_RRQ` or a `CMD.PREPARE_BUFFER` whose body wraps it. `findings.attendance.read` is set from it.

- [ ] **Step 1: Write the failing tests**

Add to `test/diagnostics/probe.bulk.spec.ts` (add `attendanceRequested` to the probe import):

```ts
describe('attendanceRequested', () => {
  it('is true for a direct ATTLOG_RRQ send', () => {
    expect(attendanceRequested([directSend(CMD.ATTLOG_RRQ)])).toBe(true)
  })

  it('is true for a PREPARE_BUFFER wrapping ATTLOG_RRQ', () => {
    expect(attendanceRequested([bufferedSend(CMD.ATTLOG_RRQ)])).toBe(true)
  })

  it('is false for a user-list read, which also goes out wrapped', () => {
    expect(attendanceRequested([bufferedSend(CMD.USERTEMP_RRQ), directSend(CMD.GET_FREE_SIZES)])).toBe(false)
  })

  it('does not count an ATTLOG_RRQ we merely received', () => {
    const recv = { ...directSend(CMD.ATTLOG_RRQ), direction: 'recv' as const }
    expect(attendanceRequested([recv])).toBe(false)
  })
})

describe('probeBulk on a device with no records', () => {
  it('records read: false and says no request was issued, so item 1 cannot claim one', async () => {
    // getAttendanceLogs returns [] without reading when the device reports 0
    // records (src/commands/attendance.ts). `read: true` here was item 1's
    // "answered" on a capture holding no attendance request at all.
    running = await startEmulator({
      transport: 'tcp',
      info: { userCount: 1, recordCount: 0, recordCapacity: 1000 },
      users: [emUser(1, '000123', 'Alice')],
    })
    const opened = await open(running.port)
    session = opened.session
    const findings = emptyFindings()
    findings.freeSizes = { userCount: 1, recordCount: 0, recordCapacity: 1000, rawHex: '' }
    await probeBulk(
      session, new StepRunner(), findings, { transport: 'tcp', attendance: 'auto' }, opened.traced.events,
    )
    expect(findings.attendance).toMatchObject({
      read: false,
      skippedReason: 'the device reported 0 records; no read was issued',
      detectedRecordSize: null,
      rowCount: 0,
    })
    // The positive control: the step itself completed, so this is not a
    // failure being reported as an absence.
    expect(running.received.map((p) => p.command)).not.toContain(CMD.ATTLOG_RRQ)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/probe.bulk.spec.ts`
Expected: FAIL — `attendanceRequested` is not exported; the zero-record test finds `read: true` with `skippedReason: null`.

- [ ] **Step 3: Implement**

In `src/diagnostics/probe.ts`, add beside `sentPrepareBuffer`:

```ts
/**
 * Did a request for the attendance log leave the socket?
 *
 * `getAttendanceLogs` returns an empty list WITHOUT issuing a read when the
 * device reports zero records (`src/commands/attendance.ts`), so "the call
 * returned" is not evidence that anything was asked. Item 1's question has two
 * halves — a full handshake AND one attendance read — and this is the half a
 * returned value cannot supply. Recognises both shapes the read can take: the
 * legacy `CMD_ATTLOG_RRQ`, and the buffered `CMD_PREPARE_BUFFER` whose body
 * carries the target command as a uint16 at offset 1.
 */
export function attendanceRequested(events: readonly TraceEvent[]): boolean {
  return events.some((e) => {
    if (e.direction !== 'send') return false
    if (e.command === CMD.ATTLOG_RRQ) return true
    if (e.command !== CMD.PREPARE_BUFFER || !e.hex) return false
    const { data } = decodePayload(Buffer.from(e.hex, 'hex'))
    return data.length >= 3 && data.readUInt16LE(1) === CMD.ATTLOG_RRQ
  })
}
```

Replace `probeBulk`'s attendance step with:

```ts
  await runner.run('attendance', async () => {
    const before = events.length
    const logs = await getAttendanceLogs(session, opts.transport, { resolveUserIds: false })
    // Counts and shapes only. Never a row: those are movement records for
    // named people, and no checklist item needs their contents.
    findings.attendance = attendanceRequested(events.slice(before))
      ? {
          read: true,
          skippedReason: null,
          detectedRecordSize: logs[0]?.recordSize ?? null,
          rowCount: logs.length,
        }
      : {
          read: false,
          skippedReason: 'the device reported 0 records; no read was issued',
          detectedRecordSize: null,
          rowCount: 0,
        }
    return findings.attendance
  })
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run test/diagnostics`
Expected: PASS, including the existing "reads users and reports the buffered path" test, whose emulator serves one record and so still records `read: true`.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/probe.ts test/diagnostics/probe.bulk.spec.ts
git commit -m "fix(diagnostics): attendance was read only if a request left the socket"
```

---

### Task 5: Parameter outcomes, and device strings sanitised where they are produced (spec §4.6, §6.2)

**Files:**
- Modify: `src/diagnostics/probe.ts` (`ParameterFinding`, `probeIdentity`)
- Test: `test/diagnostics/probe.identity.spec.ts`

**Interfaces:**
- Consumes: `declined`, `replyOutcome` (Task 1).
- Produces: `ParameterFinding = { key: string; outcome: 'answered' | 'refused' | 'mismatched-echo'; empty: boolean }`; `sanitizeDeviceString(value: string): string`. A keyword answering `ACK_UNAUTH` stays out of `findings.parameters`, as today, and is counted from the step outcomes by `parameterSummary`.

- [ ] **Step 1: Write the failing tests**

Add to `test/diagnostics/probe.identity.spec.ts` (import `sanitizeDeviceString` from the probe module):

```ts
describe('sanitizeDeviceString', () => {
  it('replaces control characters, which is what lets a name forge a table row', () => {
    expect(sanitizeDeviceString('MB360\n| 3 | x |')).toBe('MB360�| 3 | x |')
    expect(sanitizeDeviceString('a\r\tb')).toBe('a��b')
  })

  it('keeps bytes above 0x9F, which item 20 needs and item 7 prints', () => {
    expect(sanitizeDeviceString('Ünïcode')).toBe('Ünïcode')
  })
})

describe('probeIdentity records what the device answered with', () => {
  it("distinguishes a device that answers without echoing the keyword from one that refuses", async () => {
    // A firmware replying `DeviceName=MB360` to `~DeviceName` used to land as
    // answered: false — indistinguishable from ACK_ERROR, on item 15, whose
    // question is precisely whether the device echoes.
    running = await startEmulator({ transport: 'tcp', params: PARAMS, paramEchoOverride: 'DeviceName' })
    session = await open(running.port)
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeIdentity(session, runner, findings)
    const name = findings.parameters.find((p) => p.key === '~DeviceName')
    expect(name).toMatchObject({ outcome: 'mismatched-echo' })
    // The device answered, so the step is not a refusal.
    expect(runner.steps.find((s) => s.name === 'param:~DeviceName')).toMatchObject({ outcome: 'ok' })
    // And a key this emulator does not carry is still a refusal.
    expect(findings.parameters.find((p) => p.key === 'MAC')).toMatchObject({ outcome: 'refused' })
  })

  it('records an answered keyword as answered, with empty separate', async () => {
    running = await startEmulator({ transport: 'tcp', params: { ...PARAMS, MAC: '' } })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.parameters.find((p) => p.key === '~DeviceName')).toMatchObject({ outcome: 'answered', empty: false })
    expect(findings.parameters.find((p) => p.key === 'MAC')).toMatchObject({ outcome: 'answered', empty: true })
  })

  it('sanitises the identity values it records, at the source', async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: { ...PARAMS, '~DeviceName': 'MB360\n| 3 | forged |' },
    })
    session = await open(running.port)
    const findings = emptyFindings()
    await probeIdentity(session, new StepRunner(), findings)
    expect(findings.identity.deviceName).toBe('MB360�| 3 | forged |')
    expect(findings.identity.deviceName).not.toContain('\n')
  })

  it("records 'unauthorized' without throwing when a parameter answers ACK_UNAUTH", async () => {
    running = await startEmulator({
      transport: 'tcp',
      params: PARAMS,
      handlers: { [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
    })
    session = await open(running.port)
    const runner = new StepRunner()
    const findings = emptyFindings()
    await probeIdentity(session, runner, findings)
    const steps = runner.steps.filter((s) => s.name.startsWith('param:'))
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) expect(step.outcome).toBe('unauthorized')
    // Unauthorized keys stay out of the array, as before: parameterSummary
    // counts them from the steps, so "tried" stays honest.
    expect(findings.parameters).toEqual([])
  })
})
```

Replace the existing test `'records each parameter as answered, empty, or refused'` body's assertions on `answered`/`empty` with the `outcome` field, and the existing `'does not fabricate a firmware value from an ACK_UNAUTH reply, and records unauthorized'` / `'records unauthorized, not ok, when a parameter read answers ACK_UNAUTH'` tests keep their `outcome: 'unauthorized'` expectations (they pass either way; the mechanism changes from a throw to `declined`).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/probe.identity.spec.ts`
Expected: FAIL — `sanitizeDeviceString` is not exported; `outcome` is not a field on `ParameterFinding`; the mismatched-echo key comes back `answered: false` and the sanitise test finds a literal newline.

- [ ] **Step 3: Implement**

In `src/diagnostics/probe.ts`:

```ts
export interface ParameterFinding {
  key: string
  /**
   * What the device did with this keyword.
   *
   * 'mismatched-echo' is its own outcome because item 15 asks whether the
   * device echoes the keyword it was asked for. Collapsing it into "not
   * answered" made a device that answers without echoing indistinguishable
   * from one that refuses — on the row whose whole subject is the difference.
   * ACK_UNAUTH is not here: the step records it as `unauthorized` and the key
   * stays out of this array, so `parameterSummary`'s "tried" count comes from
   * the steps.
   */
  outcome: 'answered' | 'refused' | 'mismatched-echo'
  /** It answered with an empty value. Distinct from not answering — item 16. */
  empty: boolean
}

/**
 * Strips control characters from a string the DEVICE chose.
 *
 * Device name, platform, OS and firmware are latin1-decoded device bytes that
 * stop only at NUL, so a name carrying a newline and pipes inserts a fabricated
 * row into the checklist table of a report meant to be pasted into a public
 * issue. Redaction and sanitisation both happen where the value is produced,
 * so every renderer can trust `Findings` (CLAUDE.md).
 *
 * C0 (0x00-0x1F), DEL and C1 (0x7F-0x9F) become U+FFFD. Everything at 0xA0 and
 * above is KEPT: item 7 needs the model name as the device spells it, and item
 * 20's evidence is exactly those high bytes.
 */
export function sanitizeDeviceString(value: string): string {
  return value.replaceAll(/[ --]/g, '�')
}
```

In `probeIdentity`'s firmware step, replace the `ACK_UNAUTH` throw and the value assignment:

```ts
    const outcome = replyOutcome(res.command)
    if (outcome) return declined(outcome, null)
    const value = sanitizeDeviceString(readNulTerminated(res.data, 0, res.data.length))
    findings.identity.firmwareVersion = value
    return value
```

In the parameter sweep step:

```ts
    await runner.run(`param:${key}`, async () => {
      const res = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(key))
      const outcome = replyOutcome(res.command)
      if (outcome === 'unauthorized') return declined('unauthorized', null)
      if (outcome === 'refused') {
        findings.parameters.push({ key, outcome: 'refused', empty: false })
        return declined('refused', null)
      }
      if (!answeredKeyword(res.command, res.data, key)) {
        // The device answered — it simply did not echo the keyword. Item 15's
        // whole question. The step stays 'ok' because a reply arrived.
        findings.parameters.push({ key, outcome: 'mismatched-echo', empty: false })
        return null
      }
      const value = sanitizeDeviceString(paramValue(res.data) ?? '')
      findings.parameters.push({ key, outcome: 'answered', empty: value === '' })
      if (key === DEVICE_PARAM.SERIAL_NUMBER) findings.identity.serialNumberPresent = true
      else if (key === DEVICE_PARAM.DEVICE_NAME) findings.identity.deviceName = value
      else if (key === DEVICE_PARAM.PLATFORM) findings.identity.platform = value
      else if (key === DEVICE_PARAM.OS) findings.identity.os = value
      // Never the raw value: StepRunner.run stores whatever is returned here
      // as StepResult.value, which flows into the report independently of
      // `findings`.
      return null
    })
```

`answeredKeyword` loses its `ACK_ERROR`/`ACK_UNAUTH` guard (the caller now checks first) and becomes:

```ts
/** Did the reply echo this keyword back with an '='? Item 15's test, and only that. */
function answeredKeyword(body: Buffer, keyword: string): boolean {
  return body.toString('latin1').startsWith(`${keyword}=`)
}
```

Update `requestShapeAb` to call `replyOutcome` first and treat a refusal as "this shape did not answer":

```ts
async function requestShapeAb(session: Session, keyword: string): Promise<KeywordFormVerdict> {
  const withNul = await session.tryExecute(CMD.OPTIONS_RRQ, nulTerminated(keyword))
  const nulOk = replyOutcome(withNul.command) === null && answeredKeyword(withNul.data, keyword)
  const without = await session.tryExecute(CMD.OPTIONS_RRQ, bare(keyword))
  const bareOk = replyOutcome(without.command) === null && answeredKeyword(without.data, keyword)
  if (nulOk && bareOk) return 'both'
  if (nulOk) return 'nul-only'
  if (bareOk) return 'bare-only'
  return 'neither'
}
```

`ZkAuthError` is no longer imported by `probe.ts` if nothing else uses it; remove the import if `pnpm typecheck` flags it.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm typecheck && npx vitest run test/diagnostics`
Expected: PASS. `report.ts`'s `parameterSummary` still compiles: it reads `p.answered`, so change those two lines now to `p.outcome === 'answered'` and `p.outcome === 'answered' && p.empty` (Task 8 rewrites the sentence itself).

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/probe.ts src/diagnostics/report.ts test/diagnostics/probe.identity.spec.ts
git commit -m "fix(diagnostics): a device that answers without echoing is not a refusal, and device strings are sanitised where they are produced"
```

---

### Task 6: A realtime window that ends when the subscription does (spec §4.4)

**Files:**
- Modify: `src/diagnostics/probe.ts` (`Findings.realtime`, `emptyFindings`, `probeRealtime`), `src/cli.ts` (the call)
- Test: `test/diagnostics/probe.realtime.spec.ts`, `test/emulator/index.ts` (two knobs)

**Interfaces:**
- Produces: `Findings.realtime` gains `heldOpen: boolean`, `endedAfterMs: number`, `nonEventPackets: number`; `probeRealtime(session, runner, findings, { windowSeconds, sleep, now })` where `now: () => number` is injected exactly as `TracingTransport`'s is.
- Emulator knobs: `pushNonEvent?: Buffer[]` (pushed as raw packets alongside the acknowledgment) and `dropAfterRegisterMs?: number` (destroy the socket this long after the REG_EVENT acknowledgment).

- [ ] **Step 1: Add the emulator knobs**

In `test/emulator/index.ts`, add to `EmulatorOptions`:

```ts
  /**
   * Packets pushed to a subscribed client that are NOT realtime events —
   * a stray acknowledgment interleaved into a listening connection. The probe
   * must count these separately from events (checklist item 13).
   */
  pushNonEvent?: Buffer[]
  /**
   * Destroys the client socket this many milliseconds after acknowledging
   * CMD_REG_EVENT: a subscription that dies mid-window. TCP only.
   */
  dropAfterRegisterMs?: number
```

In the `[CMD.REG_EVENT]` handler, after building `ack`, append the non-events and schedule the drop:

```ts
  [CMD.REG_EVENT]: (req, state) => {
    if (state.opts.refuseRegEvent) return [reply(state, req, CMD.ACK_ERROR)]
    state.eventMask = req.data.length >= 4 ? req.data.readUInt32LE(0) : 0
    const ack = reply(state, req, CMD.ACK_OK)
    const early = (state.opts.pushBeforeAck ?? []).map((p) => eventPacket(p.eventType, p.data))
    const pushes = state.opts.pushWithAck ?? []
    const strays = state.opts.pushNonEvent ?? []
    return [
      ...early,
      ack,
      ...pushes.map((p) => eventPacket(p.eventType, p.data)),
      ...strays,
    ]
  },
```

In `startEmulator`'s TCP `sock.on('data')` handler, after the `write()` call, add:

```ts
          if (opts.dropAfterRegisterMs !== undefined && req0?.command === CMD.REG_EVENT) {
            setTimeout(() => { if (!sock.destroyed) sock.destroy() }, opts.dropAfterRegisterMs)
          }
```

`respond` decodes the payload internally, so lift that decode into the loop and pass it in. Change
`respond`'s signature to `(raw: Buffer, payload: Buffer, req: DecodedPacket)` and delete its own
`const req = decodePayload(payload)` line, keeping everything else identical. In the TCP `'data'`
handler's loop, decode once and use it for both:

```ts
          const raw = acc.subarray(0, framed.consumed)
          acc = acc.subarray(framed.consumed)
          const req = decodePayload(framed.payload)
          const out = respond(Buffer.from(raw), framed.payload, req)
          if (out) {
            const write = (): void => { if (!sock.destroyed) for (const p of out) sock.write(frameTcp(p)) }
            if (opts.replyDelayMs) setTimeout(write, opts.replyDelayMs)
            else write()
          }
          // A subscription the device kills mid-window: the probe must notice
          // rather than sleep out the rest of it.
          if (opts.dropAfterRegisterMs !== undefined && req.command === CMD.REG_EVENT) {
            setTimeout(() => { if (!sock.destroyed) sock.destroy() }, opts.dropAfterRegisterMs)
          }
```

The UDP branch's call site passes `decodePayload(payload)` the same way; `dropAfterRegisterMs` is
TCP-only, so nothing else changes there.

- [ ] **Step 2: Write the failing tests**

Replace the body of `describe('probeRealtime', …)` in `test/diagnostics/probe.realtime.spec.ts`'s existing tests' `probeRealtime(...)` calls to include `now`, and add:

```ts
/** A monotonic fake clock: 10ms per read, so endedAfterMs is deterministic. */
function fakeNow(): () => number {
  let t = 0
  return () => (t += 10)
}

describe('probeRealtime counts only events, and ends when the subscription does', () => {
  it('counts a stray non-event packet separately from events', async () => {
    running = await startEmulator({
      transport: 'tcp',
      pushNonEvent: [encodePayload({ command: CMD.ACK_OK, sessionId: 1, replyId: 9 })],
    })
    session = await open(running.port)
    const findings = emptyFindings()
    const sleep = async (): Promise<void> => {
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('A1'))
      running!.pushEvent(EVENT_FLAG.ATTENDANCE, attendancePayload('B2'))
      await new Promise((r) => setTimeout(r, 80))
    }
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 5, sleep, now: fakeNow() })
    expect(findings.realtime).toMatchObject({ registered: true, heldOpen: true, eventsObserved: 2, nonEventPackets: 1 })
    await session.close().catch(() => {}); session = null
  })

  it('ends the window when the device drops the connection, and says it did not hold open', async () => {
    running = await startEmulator({ transport: 'tcp', dropAfterRegisterMs: 30 })
    session = await open(running.port)
    const findings = emptyFindings()
    // A 60s window the test must NOT wait out: the drop ends it.
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    await probeRealtime(session, new StepRunner(), findings, { windowSeconds: 60, sleep, now: fakeNow() })
    expect(findings.realtime).toMatchObject({ registered: true, heldOpen: false })
    expect(findings.realtime!.error).toBeTruthy()
    session = null
  }, 10_000)
})
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run test/diagnostics/probe.realtime.spec.ts`
Expected: FAIL — `now` is not an option and `heldOpen`/`nonEventPackets` do not exist; without the fix the drop test times out at 10 s because the probe sleeps the whole 60-second window (the failure the fix exists to prevent).

- [ ] **Step 4: Implement**

In `src/diagnostics/probe.ts`, replace the `realtime` member of `Findings`:

```ts
  realtime: {
    windowSeconds: number
    /** CMD_REG_EVENT was acknowledged. */
    registered: boolean
    /** The window elapsed with the subscription still alive. */
    heldOpen: boolean
    /** How long the window actually lasted, by the injected clock. */
    endedAfterMs: number
    eventsObserved: number
    /**
     * Packets pushed on the listening connection that were not events.
     * Counted apart because item 13 asks whether a device interleaves a
     * request-response packet into a subscription — and because counting them
     * as events reported a stray acknowledgment as an event type.
     */
    nonEventPackets: number
    eventTypes: number[]
    desyncOnRegister: boolean
    error: string | null
  } | null
```

Update `emptyFindings` — no change needed (`realtime: null`).

Replace `probeRealtime`:

```ts
export async function probeRealtime(
  session: Session,
  runner: StepRunner,
  findings: Findings,
  opts: { windowSeconds: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
  await runner.run('realtime', async () => {
    const types = new Set<number>()
    let observed = 0
    let strays = 0
    findings.realtime = {
      windowSeconds: opts.windowSeconds,
      registered: false,
      heldOpen: false,
      endedAfterMs: 0,
      eventsObserved: 0,
      nonEventPackets: 0,
      eventTypes: [],
      desyncOnRegister: false,
      error: null,
    }
    // The subscription's own failure, if it has one. A no-op error handler
    // meant a connection that died one second into a sixty-second window was
    // reported as held open for sixty.
    let markFailed: (err: Error) => void = () => {}
    const died = new Promise<Error>((resolve) => { markFailed = resolve })
    try {
      await session.subscribe(
        EVENT_FLAG.ATTENDANCE,
        (pkt) => {
          if (isEventPacket(pkt)) {
            observed += 1
            // The event type occupies the session-id slot (v0.2 §5.1) — itself
            // a checklist item, which is why the raw type is recorded.
            types.add(readEventType(pkt))
          } else {
            strays += 1
          }
        },
        (err) => markFailed(err),
      )
      findings.realtime.registered = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      findings.realtime.error = message
      findings.realtime.desyncOnRegister = /out of step/.test(message)
      // A refused registration or a desync is the device declining, which is
      // the data the checklist items want — not this probe failing.
      return declined('refused', findings.realtime)
    }

    const startedAt = opts.now()
    const ended = await Promise.race([
      opts.sleep(opts.windowSeconds * 1000).then(() => null),
      died.then((err) => err),
    ])
    findings.realtime.endedAfterMs = opts.now() - startedAt
    findings.realtime.heldOpen = ended === null
    if (ended !== null) findings.realtime.error = ended.message
    findings.realtime.eventsObserved = observed
    findings.realtime.nonEventPackets = strays
    findings.realtime.eventTypes = [...types].sort((a, b) => a - b)
    // The step stays 'ok': the probe registered and produced its observation.
    // WHAT it observed — held open, or dropped after endedAfterMs — is the
    // finding, and items 9 and 13 read it from there.
    return findings.realtime
  })
}
```

Add `isEventPacket, readEventType` to the `../codec/events.js` import.

In `src/cli.ts`, pass the clock: `await probeRealtime(session, runner, findings, { windowSeconds: opts.realtimeSeconds, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() })`.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm typecheck && npx vitest run test/diagnostics test/emulator`
Expected: PASS; the drop test finishes in well under a second of window time.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/probe.ts src/cli.ts test/emulator/index.ts test/diagnostics/probe.realtime.spec.ts
git commit -m "fix(diagnostics): the realtime window counts events and ends when the subscription dies"
```

---

### Task 7: The second connection carries the comm key (spec §4.3)

**Files:**
- Modify: `src/diagnostics/probe.ts` (`probeConcurrent`), `src/cli.ts` (the call)
- Test: `test/diagnostics/probe.realtime.spec.ts`

**Interfaces:**
- Consumes: `createTransport(kind, opts)` from `src/transport/createTransport.js` (shipped in v0.5).
- Produces: `probeConcurrent(runner, findings, { host, port, transport, timeoutMs, commKey })`; `Findings.concurrent` loses `attempted`.

- [ ] **Step 1: Write the failing tests**

In `test/diagnostics/probe.realtime.spec.ts`, add `commKey: 0` to the two existing `probeConcurrent` calls and replace the accepted-case assertion's `attempted: true,` with nothing. Add:

```ts
  it('opens the second connection with the comm key the first one used', async () => {
    // Against a keyed device the probe used to report "a second connection was
    // refused: device requires a comm key" — item 10 answered with this tool's
    // omission rather than with the device's behaviour.
    const COMM_KEY = 483927
    running = await startEmulator({ transport: 'tcp', commKey: COMM_KEY })
    const findings = emptyFindings()
    await probeConcurrent(new StepRunner(), findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000, commKey: COMM_KEY,
    })
    expect(findings.concurrent).toMatchObject({ accepted: true, error: null })
  })

  it('still reports a refusal as a refusal when the key is wrong', async () => {
    running = await startEmulator({ transport: 'tcp', commKey: 483927 })
    const findings = emptyFindings()
    const runner = new StepRunner()
    await probeConcurrent(runner, findings, {
      host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 1000, commKey: 1,
    })
    expect(findings.concurrent?.accepted).toBe(false)
    expect(runner.truncated).toBeNull()
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/probe.realtime.spec.ts`
Expected: FAIL — `commKey` is not an option (typecheck), and with it ignored the keyed test reports `accepted: false`.

- [ ] **Step 3: Implement**

In `src/diagnostics/probe.ts`, change `Findings.concurrent` to `{ accepted: boolean; error: string | null } | null` and replace `probeConcurrent`:

```ts
export async function probeConcurrent(
  runner: StepRunner,
  findings: Findings,
  opts: { host: string; port: number; transport: 'tcp' | 'udp'; timeoutMs: number; commKey: number },
): Promise<void> {
  await runner.run('second-connection', async () => {
    // The SAME credentials the first session used: without the comm key, a
    // keyed device refuses this connection and item 10 reports the tool's
    // omission as the device's answer.
    const second = new Session(
      createTransport(opts.transport, { host: opts.host, port: opts.port }),
      { timeoutMs: opts.timeoutMs, commKey: opts.commKey },
    )
    try {
      await second.open()
      findings.concurrent = { accepted: true, error: null }
      await second.close().catch(() => {})
      return findings.concurrent
    } catch (err) {
      findings.concurrent = {
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      }
      // The device (or the network) declined a second connection, which is the
      // checklist item's answer, not a failure of this probe.
      return declined('refused', findings.concurrent)
    }
  })
}
```

Replace the `TcpTransport`/`UdpTransport` imports with `import { createTransport } from '../transport/createTransport.js'`.

In `src/cli.ts`, pass `commKey: opts.commKey` to `probeConcurrent`.

In `test/diagnostics/report.spec.ts`, `withConcurrent` drops `attempted: true`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm typecheck && npx vitest run test/diagnostics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/probe.ts src/cli.ts test/diagnostics/probe.realtime.spec.ts test/diagnostics/report.spec.ts
git commit -m "fix(diagnostics): the second-connection probe presents the comm key the device demanded"
```

---

## Phase C — The report

### Task 8: Every checklist state follows its own evidence (spec §6.1)

**Files:**
- Modify: `src/diagnostics/report.ts`
- Test: `test/diagnostics/report.spec.ts`

**Interfaces:**
- Consumes: `Findings.realtime` with `heldOpen`/`endedAfterMs`/`nonEventPackets` (Task 6); `Findings.concurrent` without `attempted` (Task 7); `ParameterFinding.outcome` (Task 5); `Findings.attendance.read` as a wire fact (Task 4).
- Produces: `answeredIf(ok: boolean): ChecklistState`; item 8 is always `'not testable by this tool'`; items 9, 13, 15, 16, 17, 20 follow the rules below.

**A deviation this task takes deliberately.** Spec §4.8 says the `(no message)` fallbacks go. The
producer does set `error` on every path that clears the flag beside it, but the field's type allows
null, so one fallback must exist for the code to compile. The three duplicated inline strings
collapse into ONE named helper, `reason()`, whose docblock says it is unreachable and why it is
there. If a reviewer prefers the alternative — a discriminated union on `Findings.realtime` and
`Findings.concurrent` that makes the null impossible — that is a bigger change to Task 6's shape and
its tests, and it belongs in its own task rather than here.

- [ ] **Step 1: Write the failing tests**

In `test/diagnostics/report.spec.ts`, update the two helpers and add the state tests:

```ts
function withRealtime(overrides: Partial<NonNullable<Findings['realtime']>>): ProbeResult {
  const result = sample()
  result.findings.realtime = {
    windowSeconds: 5,
    registered: false,
    heldOpen: false,
    endedAfterMs: 0,
    eventsObserved: 0,
    nonEventPackets: 0,
    eventTypes: [],
    desyncOnRegister: false,
    error: null,
    ...overrides,
  }
  return result
}

function withConcurrent(overrides: Partial<NonNullable<Findings['concurrent']>>): ProbeResult {
  const result = sample()
  result.findings.concurrent = { accepted: false, error: null, ...overrides }
  return result
}

describe('item 8 — the acknowledgment question this tool cannot ask', () => {
  it('is not testable by this tool, even after a full window', () => {
    // This library never sends ackEvent (v0.2 §9), so a completed window says
    // nothing about whether the device requires one. It used to read
    // 'answered' beside a sentence describing a window.
    const md = renderMarkdown(withRealtime({ registered: true, heldOpen: true, eventsObserved: 3 }))
    expect(checklistState(md, 8)).toBe('not testable by this tool')
    expect(md).toMatch(/8 \|[^\n]*never acknowledges/i)
  })

  it('names the symptom a reader should watch for', () => {
    const md = renderMarkdown(withRealtime({ registered: true, heldOpen: true, eventsObserved: 1 }))
    expect(md).toMatch(/8 \|[^\n]*one event and then goes silent/i)
  })
})

describe('items 9 and 13 — what a window actually showed', () => {
  it('answers 9 when the subscription held open, and 13 only if an event arrived', () => {
    const md = renderMarkdown(withRealtime({ registered: true, heldOpen: true, eventsObserved: 0 }))
    expect(checklistState(md, 9)).toBe('answered')
    expect(checklistState(md, 13)).toBe('not answered')
  })

  it('answers 9 when the device dropped the subscription, naming when', () => {
    const md = renderMarkdown(withRealtime({
      registered: true, heldOpen: false, endedAfterMs: 1200, error: 'connection closed by peer',
    }))
    expect(checklistState(md, 9)).toBe('answered')
    expect(md).toMatch(/9 \|[^\n]*dropped it after 1200ms/)
  })

  it('answers 13 when events arrived, listing types and non-event packets', () => {
    const md = renderMarkdown(withRealtime({
      registered: true, heldOpen: true, eventsObserved: 2, eventTypes: [1], nonEventPackets: 1,
    }))
    expect(checklistState(md, 13)).toBe('answered')
    expect(md).toMatch(/13 \|[^\n]*1 non-event packet/)
  })

  it('leaves 9 and 13 not answered when the registration was refused', () => {
    const md = renderMarkdown(withRealtime({ registered: false, error: 'device refused' }))
    expect(checklistState(md, 9)).toBe('not answered')
    expect(checklistState(md, 13)).toBe('not answered')
    expect(md).not.toMatch(/no message/)
  })
})

describe('item 20 — an encoding verdict, or none', () => {
  it('is not answered when no name carried a high byte', () => {
    const result = sample()
    result.findings.encoding = { namesInspected: 2, withHighBytes: 0, validUtf8: null }
    const md = renderMarkdown(result)
    expect(checklistState(md, 20)).toBe('not answered')
    expect(md).toMatch(/20 \|[^\n]*no evidence either way/)
  })

  it('is answered when a verdict exists', () => {
    const result = sample()
    result.findings.encoding = { namesInspected: 2, withHighBytes: 1, validUtf8: true }
    expect(checklistState(renderMarkdown(result), 20)).toBe('answered')
  })
})

describe('items 15-17 — three outcomes, not one boolean', () => {
  function withParams(parameters: Findings['parameters']): ProbeResult {
    const result = sample()
    result.findings.parameters = parameters
    result.steps = parameters.map((p) => ({ name: `param:${p.key}`, outcome: 'ok' as const }))
    return result
  }

  it('answers 15 when a device answered without echoing, and says so', () => {
    const md = renderMarkdown(withParams([{ key: '~DeviceName', outcome: 'mismatched-echo', empty: false }]))
    expect(checklistState(md, 15)).toBe('answered')
    expect(md).toMatch(/answered WITHOUT echoing/)
  })

  it('answers 16 on a refusal, and 17 lists the keys that answered', () => {
    const md = renderMarkdown(withParams([
      { key: '~DeviceName', outcome: 'answered', empty: false },
      { key: 'MAC', outcome: 'refused', empty: false },
    ]))
    expect(checklistState(md, 16)).toBe('answered')
    expect(md).toMatch(/17 \|[^\n]*~DeviceName/)
  })

  it('leaves 16 not answered when every key echoed a value', () => {
    const md = renderMarkdown(withParams([{ key: '~DeviceName', outcome: 'answered', empty: false }]))
    expect(checklistState(md, 16)).toBe('not answered')
  })
})

describe('item 4 names the second free-sizes read', () => {
  it('says why the attendance step shows an extra exchange', () => {
    const result = sample()
    result.findings.freeSizes = { userCount: 1, recordCount: 2, recordCapacity: 10, rawHex: 'ab' }
    expect(renderMarkdown(result)).toMatch(/4 \|[^\n]*bracket/i)
  })
})
```

Also update the existing `'a completed subscription answers 8/9/13…'`, `'a refused registration…'` and `'a desync answers item 14 alone…'` tests to the states above (8 becomes not testable; 13 keys off events).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/report.spec.ts`
Expected: FAIL — item 8 reads `answered`; item 13 reads `answered` on a zero-event window; item 20 reads `answered` with `validUtf8: null`; items 15–17 do not compile against `outcome`.

- [ ] **Step 3: Implement**

In `src/diagnostics/report.ts`:

```ts
/** `answered` when the evidence is there, `not answered` when it is not. */
function answeredIf(ok: boolean): ChecklistState {
  return ok ? 'answered' : 'not answered'
}

/**
 * The message behind a failure the producer always records.
 *
 * Unreachable through `probeRealtime` and `probeConcurrent` — both set `error`
 * on every path that clears the flag beside it — and present only because the
 * field's type allows null. One named helper rather than three inline
 * `(no message)` strings, so a reader meets it once.
 */
function reason(message: string | null): string {
  return message ?? 'no message was recorded'
}

/** 'not requested' when the probe never ran, otherwise `ok`'s verdict. */
function realtimeState(f: Findings, ok: (r: NonNullable<Findings['realtime']>) => boolean): ChecklistState {
  if (f.realtime === null) return 'not requested'
  return answeredIf(ok(f.realtime))
}

const REALTIME_NOT_REQUESTED = 'the realtime probe was not requested (pass --realtime=<seconds> to run it).'

/**
 * Item 8: does the device require an acknowledgment for each realtime event?
 *
 * Always 'not testable by this tool', like items 12 and 22. This library never
 * sends one — `ackEvent` (src/codec/events.ts) is implemented, tested, and
 * called from nowhere, by the v0.2 design's ruling — so no run of this probe
 * can distinguish a device that requires an acknowledgment from one that does
 * not. A completed window used to read 'answered' here, which was the window's
 * evidence borrowed for a question it cannot address. The symptom is named
 * instead, because a reader with hardware in front of them can recognise it.
 */
function item8Observation(f: Findings): string {
  const r = f.realtime
  const symptom =
    'if a terminal delivers one event and then goes silent, that is the symptom of a device waiting for one — record it by hand.'
  if (r === null) return `this library never acknowledges an event, so this cannot be answered here; ${symptom} The realtime probe was not requested on this run.`
  return `this library never acknowledges an event: none was sent for any of the ${r.eventsObserved} event(s) observed, so a device that requires one would look exactly like a quiet device. ${symptom}`
}

/** Item 9: does a subscription survive an idle period, or does the device drop it? */
function item9Observation(f: Findings): string {
  const r = f.realtime
  if (r === null) return REALTIME_NOT_REQUESTED
  if (!r.registered) return `the subscription did not complete: ${reason(r.error)}.`
  return r.heldOpen
    ? `registered and still alive when the ${r.windowSeconds}s window ended.`
    : `registered, then the device dropped it after ${r.endedAfterMs}ms of a ${r.windowSeconds}s window: ${reason(r.error)}. A drop answers this item as decisively as surviving does.`
}

/** Item 13: event types outside the mask, or a request-response packet interleaved. */
function item13Observation(f: Findings): string {
  const r = f.realtime
  if (r === null) return REALTIME_NOT_REQUESTED
  if (!r.registered) return `the subscription did not complete: ${reason(r.error)}.`
  if (r.eventsObserved === 0) {
    return `no event arrived in the ${r.windowSeconds}s window, so nothing can be said about which types this device emits; ${r.nonEventPackets} non-event packet(s) arrived on the listening connection.`
  }
  return `${r.eventsObserved} event(s) observed, type(s) seen: ${r.eventTypes.join(', ')}; ${r.nonEventPackets} non-event packet(s) arrived on the listening connection.`
}
```

Delete `realtimeGeneralState` and `realtimeGeneralObservation`. `realtimeDesyncState`/`realtimeDesyncObservation` keep their behaviour, with `reason(r.error)` replacing the inline fallback. `concurrentObservation` uses `reason(c.error)`.

Rewrite `parameterSummary` and add item 17's observation:

```ts
function parameterSummary(f: Findings, steps: readonly StepResult[]): string {
  const paramSteps = steps.filter((s) => s.name.startsWith(PARAM_STEP_PREFIX))
  if (paramSteps.length === 0) return 'the parameter sweep did not run.'
  const unauthorized = paramSteps.filter((s) => s.outcome === 'unauthorized').length
  const echoed = f.parameters.filter((p) => p.outcome === 'answered').length
  const mismatched = f.parameters.filter((p) => p.outcome === 'mismatched-echo').length
  const refusedCount = f.parameters.filter((p) => p.outcome === 'refused').length
  const empty = f.parameters.filter((p) => p.outcome === 'answered' && p.empty).length
  if (echoed === 0 && mismatched === 0) {
    return `the sweep ran: ${paramSteps.length} keyword(s) tried, ${refusedCount} refused (ACK_ERROR), ${unauthorized} refused authorization (ACK_UNAUTH), and none returned a value to inspect. That is a device profile finding, not an absence — a session holding the device's comm key would see different answers.`
  }
  return `${paramSteps.length} keyword(s) tried; ${echoed} echoed the keyword back (${empty} of those empty), ${mismatched} answered WITHOUT echoing it, ${refusedCount} refused (ACK_ERROR), ${unauthorized} refused authorization (ACK_UNAUTH).`
}

/** Item 17 lists the keys, which are this library's own constants, never device data. */
function item17Observation(f: Findings, steps: readonly StepResult[]): string {
  const answered = f.parameters
    .filter((p) => p.outcome === 'answered' || p.outcome === 'mismatched-echo')
    .map((p) => p.key)
  const summary = parameterSummary(f, steps)
  return answered.length === 0 ? summary : `keyword(s) that answered: ${answered.join(', ')}. ${summary}`
}
```

In `buildChecklist`, replace the affected rows:

```ts
  const answeredKeys = f.parameters.filter((p) => p.outcome === 'answered' || p.outcome === 'mismatched-echo').length
  const refusedOrEmpty =
    f.parameters.some((p) => p.outcome === 'refused') || f.parameters.some((p) => p.outcome === 'answered' && p.empty)
  const encodingDecided = f.encoding !== null && f.encoding.validUtf8 !== null

  push(8, 'Does the device require an acknowledgment for each realtime event?', 'not testable by this tool', item8Observation(f))
  push(9, 'Does a subscription survive an idle period, or does the device drop it?', realtimeState(f, (r) => r.registered), item9Observation(f))
  push(10, 'Does the device accept a second concurrent connection on 4370?', concurrentState(f), concurrentObservation(f))
  push(12, 'Is there a way to cancel a subscription without dropping the connection?', 'not testable by this tool', REALTIME_CANCEL_OBSERVATION)
  push(13, 'Does the device emit event types outside the requested mask, or interleave a request-response packet into a listening connection?', realtimeState(f, (r) => r.eventsObserved > 0), item13Observation(f))
  push(15, 'Does the device echo the requested keyword in a CMD_OPTIONS_RRQ reply?', answeredIf(answeredKeys > 0), parameterSummary(f, steps))
  push(16, 'Does an unsupported parameter answer ACK_ERROR or an empty value?', answeredIf(refusedOrEmpty), parameterSummary(f, steps))
  push(17, 'Which parameter keywords does this firmware actually expose?', answeredIf(answeredKeys > 0), item17Observation(f, steps))
  push(
    20,
    'What character encoding does the device use for strings — device name and user name alike?',
    answeredIf(encodingDecided),
    f.encoding !== null
      ? `of ${f.encoding.namesInspected} name(s) inspected, ${f.encoding.withHighBytes} carried a byte above 0x7F` +
        (f.encoding.withHighBytes === 0
          ? ' (no evidence either way).'
          : `; those bytes ${f.encoding.validUtf8 ? 'ARE' : 'are NOT'} valid UTF-8.`)
      : 'the user list was not read, so no names were available to inspect.',
  )
```

Delete `realtimeCancelState` (item 12 is now written inline, the way item 22 already is) and keep `REALTIME_CANCEL_OBSERVATION`. Replace every remaining `x ? 'answered' : 'not answered'` in `buildChecklist` with `answeredIf(x)`.

Item 4's observation gains one sentence before the closing backtick-free text:

```ts
      ? `userCount=${f.freeSizes.userCount} recordCount=${f.freeSizes.recordCount} recordCapacity=${f.freeSizes.recordCapacity}; the first ${f.freeSizes.rawHex.length / 2} byte(s) of the raw body are in the JSON sidecar (findings.freeSizes.rawHex) for manual offset review — capped at ${FREE_SIZES_RAW_MAX_BYTES}, with the full reply in the raw capture if one was requested. CMD_GET_FREE_SIZES is also sent a second time after the attendance read, to bracket the record count (v0.5 §7.2), which is why the attendance step counts more exchanges than its command suggests.`
```

Item 19's and item 23's observations, updated for the v0.5 library:

```ts
  if (f.bulkPath === 'legacy') {
    return "CMD_PREPARE_BUFFER's 11-byte payload was sent and the device answered ACK_ERROR, which is the only reply that now produces the legacy fallback (v0.5 §6.2). A refusal may be about the command rather than the checksum — see the per-step table for the exact reply."
  }
  return "CMD_PREPARE_BUFFER's 11-byte payload was sent, but the read did not complete, so which path served it is unknown. Since v0.5 a framing failure on the buffered path ends the read as ZkFramingError rather than falling back; see the per-step table."
```

```ts
    f.bulkPath === 'legacy'
      ? 'the device refused CMD_PREPARE_BUFFER with ACK_ERROR and the read fell back to the legacy path. Since v0.5 that is the ONLY reply that falls back: an ACK_UNAUTH to CMD_PREPARE_BUFFER ends the read as unauthorized and never reaches the legacy path, so a firmware using ACK_UNAUTH for "unsupported" shows up as an unauthorized step outcome, not as a fallback.'
      : f.bulkPath === 'buffered'
        ? 'the buffered path was accepted, so no refusal occurred and ACK_UNAUTH\'s meaning on this firmware was not exercised.'
        : 'no decisive bulk-path signal was captured.',
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm typecheck && npx vitest run test/diagnostics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/report.ts test/diagnostics/report.spec.ts
git commit -m "fix(report): each checklist row follows its own evidence, and item 8 says it cannot be answered here"
```

---

### Task 9: A device string cannot forge a report (spec §6.2)

**Files:**
- Modify: `src/diagnostics/report.ts` (`escapeCell`, the Device section, item 7's observation)
- Test: `test/diagnostics/report.spec.ts`

**Interfaces:**
- Consumes: `sanitizeDeviceString` at the source (Task 5).
- Produces: `codeSpan(value: string): string`; `escapeCell` also neutralises `\r` and `\n`.

- [ ] **Step 1: Write the failing tests**

Add to `test/diagnostics/report.spec.ts` (import `probeIdentity`, `emptyFindings`, `StepRunner`, `Session`, `TcpTransport`, `startEmulator` as the other suites do):

```ts
describe('a device-controlled string cannot forge a row (Security, Medium)', () => {
  const FORGED = 'MB360\n| 3 | Confirm which record size | answered | detected record size: 40 bytes. |'

  it('renders a device name inert, and the table keeps exactly 23 rows', async () => {
    let running: Emulator | null = null
    let session: Session | null = null
    try {
      running = await startEmulator({
        transport: 'tcp',
        params: { '~SerialNumber': 'SN-1', '~DeviceName': FORGED },
        firmware: 'Ver 6.60',
      })
      session = new Session(new TcpTransport({ host: '127.0.0.1', port: running.port }), { timeoutMs: 1000 })
      await session.open()
      const findings = emptyFindings()
      await probeIdentity(session, new StepRunner(), findings)
      const result = { ...sample(), findings }
      const md = renderMarkdown(result)

      const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l))
      expect(rows).toHaveLength(23)
      expect(md).not.toMatch(/^\| 3 \| Confirm which record size/m)
    } finally {
      await session?.close().catch(() => {})
      await running?.close()
    }
  })

  it('fences a value containing backticks so it cannot close its own span', () => {
    const result = sample()
    result.findings.identity.deviceName = 'a`b``c'
    const md = renderMarkdown(result)
    expect(md).toMatch(/```a`b``c```/)
  })

  it('renders a markdown link as text rather than a link', () => {
    const result = sample()
    result.findings.identity.deviceName = '[MB360](https://evil.example)'
    expect(renderMarkdown(result)).toMatch(/`\[MB360\]\(https:\/\/evil\.example\)`/)
  })

  it('keeps a carriage return in an error message out of the table structure', () => {
    const result = sample()
    result.steps = [{ name: 'firmware', outcome: 'malformed', errorMessage: 'bad\r\n| forged |' }]
    const md = renderMarkdown(result)
    expect(md).not.toMatch(/^\| forged \|/m)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/report.spec.ts`
Expected: FAIL — 24 rows (the forged row lands), the backtick value is unfenced, and the `\r\n` message splits the step table.

- [ ] **Step 3: Implement**

In `src/diagnostics/report.ts`:

```ts
/**
 * Escapes a value going into a pipe-delimited table cell.
 *
 * Two characters break a Markdown table: `|` shifts every cell after it, and a
 * newline ends the row, so text after it is parsed as a new row — a device
 * name of `MB360\n| 3 | … | answered |` inserted a fabricated checklist row
 * into a report meant to be pasted into a public issue. Device strings are
 * sanitised at the source (`sanitizeDeviceString`), which is where redaction
 * belongs; this covers `errorMessage`, the one column fed from an `Error` whose
 * text can originate outside this codebase (`ZkConnectionError(err.message)`
 * wraps the OS's).
 */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ')
}

/**
 * Renders a device-controlled value as an inert Markdown code span.
 *
 * The device chooses these bytes; a report reader must see them as text, not
 * as markup — `[MB360](https://evil.example)` renders as a link otherwise. The
 * fence is one backtick longer than the longest backtick run inside the value,
 * and a value that starts or ends with a backtick gets a padding space, which
 * is CommonMark's own rule for exactly this.
 */
function codeSpan(value: string): string {
  const longest = (value.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

/** A device-sourced value for a report line: inert, or a plain marker when absent. */
function deviceValue(value: string | null): string {
  return value === null ? '(not reported)' : codeSpan(value)
}
```

In `renderMarkdown`'s Device section, use `deviceValue(f.identity.deviceName)` and the same for platform, OS and firmware. In item 7's observation:

```ts
    identityComplete
      ? `deviceName=${deviceValue(f.identity.deviceName)} firmwareVersion=${deviceValue(f.identity.firmwareVersion)} platform=${deviceValue(f.identity.platform)} os=${deviceValue(f.identity.os)}.`
      : 'the device name and firmware version were not both recovered.',
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run test/diagnostics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/report.ts test/diagnostics/report.spec.ts
git commit -m "fix(report): device strings render as inert code spans, and a newline cannot open a row"
```

---

## Phase D — The CLI

### Task 10: An empty capture path is rejected, and the plumbing says what it means (spec §7)

**Files:**
- Modify: `src/cli.ts`
- Test: `test/diagnostics/cli.spec.ts`

**Interfaces:**
- Consumes: `HostClock` (Task 3), `probeConcurrent`'s `commKey` (Task 7), `probeRealtime`'s `now` (Task 6).
- Produces: `parseCliArgs` throws on `--raw-capture=`; `makeTransport` is replaced by `createTransport`; `main()` has no `connected` flag.

- [ ] **Step 1: Write the failing tests**

Add to `test/diagnostics/cli.spec.ts` in `describe('parseCliArgs', …)`:

```ts
  it('rejects an empty --raw-capture rather than reporting a capture written to nowhere', () => {
    // `--raw-capture=` parsed as '' survived the null check, wrote nothing,
    // and item 1 reported a capture at the path ','.
    expect(() => parseCliArgs(['h', '--raw-capture='])).toThrow(/--raw-capture/)
  })

  it('still accepts a real capture path', () => {
    expect(parseCliArgs(['h', '--raw-capture=trace.jsonl']).rawCapture).toBe('trace.jsonl')
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/diagnostics/cli.spec.ts`
Expected: FAIL — `parseCliArgs(['h', '--raw-capture='])` returns `rawCapture: ''` and throws nothing.

- [ ] **Step 3: Implement**

In `src/cli.ts`'s `parseCliArgs`, before the return:

```ts
  const rawCapture = values['raw-capture'] ?? null
  if (rawCapture === '') {
    throw new Error("--raw-capture needs a path, got ''. The raw capture is UNREDACTED; give it a path of its own.")
  }
```

and use `rawCapture` in the returned object.

Replace `makeTransport`:

```ts
import { createTransport } from './transport/createTransport.js'
```

with `const traced = new TracingTransport(createTransport(opts.transport, { host: opts.host, port: opts.port }), () => Date.now())` in `main()`, and delete the `makeTransport` function and the now-unused `TcpTransport`/`UdpTransport`/`Transport` imports.

Replace `main()`'s connect block:

```ts
  try {
    await session.open()
  } catch (err) {
    process.stderr.write(`could not connect to ${opts.host}:${opts.port}: ${(err as Error).message}\n`)
    process.exitCode = exitCodeFor({ connected: false, wroteOutput: false })
    return
  }

  const result = await runProbe(session, traced, opts)

  let wroteOutput = true
  try {
    await writeOutputs(result, traced.events, opts)
  } catch (err) {
    wroteOutput = false
    process.stderr.write(`could not write report output: ${(err as Error).message}\n`)
  }

  process.exitCode = exitCodeFor({ connected: true, wroteOutput })
```

In `runProbe`, pass the host clock and the comm key:

```ts
    await probeState(session, runner, findings, {
      epochSeconds: Math.floor(Date.now() / 1000),
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    })
```

```ts
      await probeConcurrent(runner, findings, {
        host: opts.host, port: opts.port, transport: opts.transport, timeoutMs: opts.timeoutMs, commKey: opts.commKey,
      })
```

- [ ] **Step 4: Run to see them pass, and the whole suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/diagnostics/cli.spec.ts
git commit -m "fix(cli): an empty --raw-capture is refused, and the transport comes from createTransport"
```

---

## Phase E — The release drill

### Task 11: The drill's device has a record, and the capture must show the request (spec §8.1)

**Files:**
- Modify: `tools/emulator-serve.ts`, `.claude/skills/release-drill/scripts/drill.mjs`

**Interfaces:**
- Produces: the drill emulator serves `info.recordCount: 1` and one 40-byte attendance record; the drill gains a check reading the capture for an attendance request.

- [ ] **Step 1: Serve a record**

In `tools/emulator-serve.ts`, add beside `emUser`:

```ts
/**
 * One 40-byte attendance record: uid, the printed id, then the packed time.
 *
 * The drill's device used to report zero records, so `getAttendanceLogs`
 * returned without issuing a read and checklist item 1 was answered by a
 * capture containing no attendance request at all. The drill now checks the
 * capture for that request, which needs a device that has one to give.
 */
function rec40(uid: number, userId: string, seconds: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'latin1')
  b.writeUInt32LE(seconds, 27)
  return b
}
```

and change the `startEmulator` call's `info` and add `records`:

```ts
  info: { userCount: 1, recordCount: 1, recordCapacity: 100_000 },
  users: [emUser(1, '000123', 'Alice')],
  records: { size: 40, rows: [rec40(1, '000123', 86_400)] },
```

- [ ] **Step 2: Add the drill check**

In `.claude/skills/release-drill/scripts/drill.mjs`, after the existing `item 1 flips to "answered"` check:

```js
// The positive control for the check above. Without it, "item 1 flips to
// answered" is a claim about the renderer; with it, the row rests on a
// request that actually went out. Item 1 asks for a handshake AND an
// attendance read, and the drill's device reported zero records until now.
const captureEvents = readFileSync(capturePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const askedForAttendance = captureEvents.some((e) => {
  if (e.direction !== 'send' || typeof e.hex !== 'string') return false
  if (e.command === 13) return true                    // CMD_ATTLOG_RRQ, sent directly
  if (e.command !== 1503) return false                 // CMD_PREPARE_BUFFER wrapping it:
  const payload = Buffer.from(e.hex, 'hex')            // header is 8 bytes, then
  return payload.length >= 11 && payload.readUInt16LE(9) === 13  // <int8 1><int16 command>
})
check('the capture holds an attendance request, so item 1 rests on the wire', askedForAttendance)
```

(the existing `const captureHex = readFileSync(capturePath, 'utf8')` line stays; both read the same file.)

- [ ] **Step 3: Run the drill**

Run: `pnpm release:drill`
Expected: 13/13 checks pass, including the new one.

- [ ] **Step 4: Verify the check can fail**

Temporarily set `records: undefined` and `recordCount: 0` in `tools/emulator-serve.ts` and re-run `pnpm release:drill`.
Expected: FAIL on `item 1 flips to "answered"` **and** on the new check — the two together are the evidence the row and the wire now agree. Restore the file afterwards and re-run to confirm 13/13.

- [ ] **Step 5: Commit**

```bash
git add tools/emulator-serve.ts .claude/skills/release-drill/scripts/drill.mjs
git commit -m "test(drill): the packed device has a record, and the capture must contain the request item 1 claims"
```

---

### Task 12: The drill cleans up, quotes its paths, and flushes its abort (spec §8.2, §8.3, §8.4)

**Files:**
- Modify: `.claude/skills/release-drill/scripts/drill.mjs`

**Interfaces:**
- Produces: `killEmulator()` kills the process group on POSIX; `shellArgs(args)` quotes arguments when a shell interprets them; `must()` exits from the write callback.

- [ ] **Step 1: Implement the three fixes**

```js
/**
 * Kills the emulator and the process it spawned.
 *
 * `tsx` spawns a child of its own, so signalling the npx wrapper left the
 * socket bound after every POSIX run — the comment here described that and
 * fixed it only for Windows. The emulator is spawned detached on POSIX, which
 * makes it a process-group leader, so a negative pid signals the whole group.
 */
function killEmulator() {
  if (!emulator || emulator.killed) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(emulator.pid), '/T', '/F'], { shell: true })
  } else {
    try {
      process.kill(-emulator.pid, 'SIGTERM')
    } catch {
      // Already gone, or never became a group leader: fall back to the child.
      try { emulator.kill('SIGTERM') } catch { /* nothing left to kill */ }
    }
  }
  emulator = null
}

/**
 * Quotes arguments that a shell would otherwise split.
 *
 * `run()` passes `shell: true` on Windows (npm and npx are batch files there),
 * and every path here goes through `mkdtempSync(join(tmpdir(), …))` — which on
 * Windows contains the user's name, so an account named "Ada Lovelace" split
 * the argument in two and the drill failed on a path it had constructed
 * itself.
 */
function shellArgs(args) {
  if (!IS_WINDOWS) return args
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, IS_WINDOWS ? shellArgs(args) : args, {
    encoding: 'utf8', shell: IS_WINDOWS, ...opts,
  })
  if (res.error) throw res.error
  return res
}

/**
 * Aborts, having flushed the reason.
 *
 * `process.exit()` immediately after a `write` truncates it when stderr is a
 * pipe — which is how CI reads it, and the abort message is the only thing
 * that says WHY the drill stopped.
 */
function must(condition, message) {
  if (!condition) {
    cleanup()
    process.stderr.write(`\ndrill aborted: ${message}\n`, () => process.exit(2))
    // A closed pipe never fires the callback; do not hang forever on it.
    setTimeout(() => process.exit(2), 2_000).unref()
  }
}
```

The emulator spawn also gets quoted arguments:

```js
emulator = spawn('npx', shellArgs(['tsx', 'tools/emulator-serve.ts', portFile]), {
  stdio: 'ignore', shell: IS_WINDOWS, detached: !IS_WINDOWS,
})
```

- [ ] **Step 2: Verify the POSIX kill by hand**

There is no automated test for this (the drill is its own test, and CI runs it on both operating systems from Task 14). Verify locally on this Windows machine that the drill still passes, and record in the task report that the POSIX path is exercised by the Linux CI leg:

Run: `pnpm release:drill`
Expected: 13/13.

- [ ] **Step 3: Verify the abort flushes**

Temporarily change the first `must(existsSync('dist/index.cjs'), …)` to `must(false, 'deliberate abort, to check the message survives a pipe')` and run:

Run: `pnpm release:drill 2>&1 | cat`
Expected: the line `drill aborted: deliberate abort, to check the message survives a pipe` is visible, and the exit code is 2. Restore the line afterwards.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/release-drill/scripts/drill.mjs
git commit -m "fix(drill): kill the emulator's process group, quote paths a shell would split, and flush the abort"
```

---

### Task 13: A CommonJS consumer is typechecked, and no CommonJS CLI ships (spec §8.5, §8.6)

**Files:**
- Create: `.claude/skills/release-drill/scripts/consumer-fixture.mjs`
- Modify: `.claude/skills/release-drill/scripts/drill.mjs`
- Test: `test/release-drill/consumer-fixture.spec.ts`

**Interfaces:**
- Produces: `consumerSource(): string` and `consumerTsconfig(repoRoot: string): string` from `consumer-fixture.mjs`; two drill checks.

- [ ] **Step 1: Write the failing test**

Create `test/release-drill/consumer-fixture.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { consumerSource, consumerTsconfig } from '../../.claude/skills/release-drill/scripts/consumer-fixture.mjs'

/**
 * The drill compiles this consumer against the packed tarball. The file is
 * pinned here because its two properties are the whole point of the check and
 * are invisible in the drill's output: it must import the package the way a
 * CommonJS consumer does, and it must be compiled under module: node16, which
 * is the resolution mode that produced TS1479 against a single `types`
 * condition.
 */
describe('the drill consumer fixture', () => {
  it('imports the published entry point and uses a published type', () => {
    const src = consumerSource()
    expect(src).toContain("from 'zkteco-protocol'")
    expect(src).toContain('ZkDevice')
    expect(src).toContain('ZkAttendanceLog')
  })

  it('is not an ES module, so require-condition resolution is what gets tested', () => {
    const cfg = JSON.parse(consumerTsconfig('C:/repo'))
    expect(cfg.compilerOptions.module).toBe('node16')
    expect(cfg.compilerOptions.moduleResolution).toBe('node16')
    expect(cfg.compilerOptions.noEmit).toBe(true)
    expect(cfg.compilerOptions.strict).toBe(true)
  })

  it('points at the repository types rather than expecting a network install', () => {
    const cfg = JSON.parse(consumerTsconfig('C:/repo'))
    expect(cfg.compilerOptions.typeRoots).toEqual(['C:/repo/node_modules/@types'])
    expect(cfg.compilerOptions.types).toEqual(['node'])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/release-drill/consumer-fixture.spec.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the fixture module**

Create `.claude/skills/release-drill/scripts/consumer-fixture.mjs`:

```js
/**
 * The CommonJS consumer the drill typechecks against the packed tarball.
 *
 * Kept beside the drill and exported so test/release-drill/consumer-fixture.spec.ts
 * can pin what it contains: the drill prints "ok" for a check whose subject is
 * a file nobody sees, and a consumer that imported nothing would pass it.
 *
 * The failure this exists to catch: a package with `"type": "module"` and a
 * single top-level `types` condition sends a `require()`-style consumer to the
 * ESM declaration, and `tsc` rejects it with TS1479. Nothing in the suite
 * compiles a consumer, so only this runs the resolution a real consumer uses.
 */

/** The consumer's source: one import of the published entry, one typed use. */
export function consumerSource() {
  return [
    "import { ZkDevice } from 'zkteco-protocol'",
    "import type { ZkAttendanceLog } from 'zkteco-protocol'",
    '',
    'export async function poll(host: string): Promise<ZkAttendanceLog[]> {',
    '  const device = new ZkDevice({ host })',
    '  await device.connect()',
    '  try {',
    '    return await device.getAttendanceLogs()',
    '  } finally {',
    '    await device.disconnect()',
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * The consumer's tsconfig.
 *
 * `module`/`moduleResolution` are `node16`: that is the mode TS1479 appears
 * in, and the consumer directory has no `"type": "module"`, so the file is a
 * CommonJS module and resolution takes the `require` condition.
 *
 * `typeRoots` points back at this repository because the consumer directory
 * holds only the tarball — installing `@types/node` there would need the
 * network, and the drill must run offline.
 */
export function consumerTsconfig(repoRoot) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: 'node16',
        moduleResolution: 'node16',
        target: 'ES2022',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        typeRoots: [`${repoRoot}/node_modules/@types`],
        types: ['node'],
      },
      files: ['consumer.ts'],
    },
    null,
    2,
  )}\n`
}
```

- [ ] **Step 4: Add the two drill checks**

In `drill.mjs`, add the import at the top (`import { consumerSource, consumerTsconfig } from './consumer-fixture.mjs'`) and, after the install check:

```js
// --- 3b. a CommonJS consumer must typecheck against the packed types -------
// The review reproduced TS1479 here on TypeScript 5.9.3 under node16 and
// node18: `exports` carried one top-level `types` pointing at the ESM
// declaration, so a require()-style consumer was sent to a file it cannot use
// while require() itself worked at runtime. dist/index.d.cts existed and was
// referenced by nothing. Nothing in the test suite compiles a consumer.
const repoRoot = process.cwd().replaceAll('\\', '/')
writeFileSync(join(consumer, 'consumer.ts'), consumerSource())
writeFileSync(join(consumer, 'tsconfig.json'), consumerTsconfig(repoRoot))
const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc')
const typecheck = spawnSync(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json')], { encoding: 'utf8' })
check(
  'a CommonJS TypeScript consumer typechecks against the packed declarations',
  typecheck.status === 0,
  typecheck.status === 0 ? 'module: node16' : `${(typecheck.stdout ?? '').trim().split('\n')[0] ?? ''}`,
)
```

and, after the pack step:

```js
// The CJS bundle of the CLI could never run — its import.meta is shimmed to
// {} so the main-module check is always false — so v0.5 stopped building it.
// The tarball is where a consumer would meet it.
const packedFiles = JSON.parse(packed.stdout)[0].files.map((f) => f.path)
check(
  'no CommonJS CLI or CLI declaration is in the tarball',
  !packedFiles.some((p) => /^dist\/cli\.(cjs|d\.[cm]?ts)$/.test(p)),
  packedFiles.filter((p) => p.startsWith('dist/cli')).join(', ') || 'dist/cli.js only',
)
```

`spawnSync` and `writeFileSync` are already imported by the drill.

- [ ] **Step 5: Run both**

Run: `npx vitest run test/release-drill/consumer-fixture.spec.ts` — PASS.
Run: `pnpm release:drill` — 15/15 checks pass.

- [ ] **Step 6: Verify the consumer check can fail**

Temporarily edit `package.json`'s `exports['.']` to the pre-v0.5 shape (`{ "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" }`) and re-run `pnpm release:drill`.
Expected: FAIL on the consumer typecheck, with a TS1479 message in the detail. Restore `package.json` afterwards and re-run to confirm 15/15.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/release-drill/scripts/consumer-fixture.mjs .claude/skills/release-drill/scripts/drill.mjs test/release-drill/consumer-fixture.spec.ts
git commit -m "test(drill): typecheck a CommonJS consumer against the tarball, and refuse a CLI that could never run"
```

---

### Task 14: The drill runs in CI, on both operating systems (spec §8.7)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml`:

```yaml
  drill:
    # The packed-tarball drill, on every push rather than only on a tag. Every
    # defect it has ever caught was a packaging defect -- a CJS pass that
    # silently dropped dist/index.cjs, and a bin entry that did nothing on
    # every platform but Windows -- and both were found by burning a version
    # number. One leg per OS, not the 2x3 matrix above: what this exercises is
    # npm pack, npm install and the installed bin, which vary by platform and
    # not by Node minor.
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm release:drill
```

- [ ] **Step 2: Check the workflow parses**

Run: `node -e "const s=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/^  drill:$/m.test(s)) throw new Error('drill job missing'); if(!/windows-latest/.test(s)) throw new Error('windows leg missing'); process.stdout.write('ok\n')"`
Expected: `ok`. (The real verification is the run on the branch's first push; the final task checks it.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the packed-tarball drill on every push, on Linux and Windows"
```

---

## Phase F — The oracle capture tool

### Task 15: A crashed oracle run is not a fixture (spec §9)

**Files:**
- Create: `tools/oracle/run-oracle.ts`
- Modify: `tools/oracle/capture.ts`
- Test: `test/oracle/run-oracle.spec.ts`

**Interfaces:**
- Produces: `interface OracleRun { spawned: boolean; code: number | null; stderrTail: string }`; `run(cmd: string, args: string[], useShell?: boolean): Promise<OracleRun>`; `runOracleScript(source, pyScript, tsScript, args): Promise<{ run: OracleRun; script: string }>`; `succeeded(run: OracleRun): boolean`; `describeFailure(script: string, run: OracleRun): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/oracle/run-oracle.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { describeFailure, run, succeeded } from '../../tools/oracle/run-oracle.js'

describe('run', () => {
  it('reports a clean exit', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("fine")'])
    expect(r).toMatchObject({ spawned: true, code: 0 })
    expect(succeeded(r)).toBe(true)
  })

  it('reports a non-zero exit and keeps the last stderr line', async () => {
    // The defect: capture.ts resolved on close regardless of the code, so a
    // driver that raised after CMD_CONNECT still had its partial packet list
    // written into test/fixtures/oracle/ and announced as written.
    const r = await run(process.execPath, [
      '-e', 'process.stderr.write("pyzk stopped: boom\\n"); process.exit(2)',
    ])
    expect(r).toMatchObject({ spawned: true, code: 2 })
    expect(succeeded(r)).toBe(false)
    expect(r.stderrTail).toContain('pyzk stopped: boom')
  })

  it('reports a spawn failure as not spawned', async () => {
    const r = await run('definitely-not-a-real-binary-zzz', [])
    expect(r.spawned).toBe(false)
    expect(succeeded(r)).toBe(false)
  })

  it('names the script and what happened', () => {
    expect(describeFailure('tools/oracle/capture_pyzk.py', { spawned: true, code: 2, stderrTail: 'boom' }))
      .toMatch(/capture_pyzk\.py.*exit 2.*boom/)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/oracle/run-oracle.spec.ts`
Expected: FAIL — `tools/oracle/run-oracle.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `tools/oracle/run-oracle.ts`:

```ts
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

/** What one oracle driver did. `code: null` with `spawned: true` means it was killed. */
export interface OracleRun {
  spawned: boolean
  code: number | null
  /** The last line the driver wrote to stderr, for a failure message worth reading. */
  stderrTail: string
}

/** A run that produced evidence. Anything else must not become a fixture. */
export function succeeded(run: OracleRun): boolean {
  return run.spawned && run.code === 0
}

/** One line naming what failed and how, for the summary at the end of a capture. */
export function describeFailure(script: string, run: OracleRun): string {
  const how = run.spawned ? `exit ${String(run.code)}` : 'could not be spawned'
  return `${script}: ${how}${run.stderrTail ? ` — ${run.stderrTail}` : ''}`
}

export function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

/**
 * Runs one oracle driver and reports how it ended.
 *
 * The exit code is the whole point: a driver that raised part-way through a
 * session leaves the emulator holding a partial packet list, and writing that
 * as a fixture files a crash as evidence. stderr is teed rather than
 * inherited so the last line can travel with the failure.
 *
 * `useShell` is set only for `npx`: on Windows it resolves to npx.cmd, a batch
 * file Windows refuses to spawn() directly unless a shell interprets it. The
 * arguments here are fixed literals plus an OS-assigned port, never untrusted
 * input.
 */
export function run(cmd: string, args: string[], useShell = false): Promise<OracleRun> {
  return new Promise((resolve) => {
    let spawned = true
    let stderrTail = ''
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], shell: useShell })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      const lines = chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean)
      if (lines.length > 0) stderrTail = lines[lines.length - 1]!
    })
    child.on('error', (err) => {
      spawned = false
      stderrTail = String(err)
    })
    child.on('close', (code) => resolve({ spawned, code, stderrTail }))
  })
}

/** Runs whichever driver belongs to this oracle, and says which script it was. */
export async function runOracleScript(
  source: 'pyzk' | 'zkteco-js',
  pyScript: string,
  tsScript: string,
  args: string[],
): Promise<{ run: OracleRun; script: string }> {
  if (source === 'pyzk') {
    return { run: await run(pythonPath(), [pyScript, ...args]), script: pyScript }
  }
  return { run: await run('npx', ['tsx', tsScript, ...args], true), script: tsScript }
}
```

- [ ] **Step 4: Use it in the capture tool**

In `tools/oracle/capture.ts`: delete the local `run`, `runOracleScript` and `pythonPath`; import `{ describeFailure, runOracleScript, succeeded }` from `./run-oracle.js`; add near the top:

```ts
/** Runs that produced no evidence. A crashed driver must not leave a fixture behind. */
const failures: string[] = []
```

In each of `capture`, `captureRealtime` and `captureParams`, replace the `await runOracleScript(...)` call with:

```ts
    const { run: oracleRun, script } = await runOracleScript(/* same arguments */)
    if (!succeeded(oracleRun)) {
      failures.push(describeFailure(script, oracleRun))
      process.stderr.write(`skipped ${file}: the oracle run produced no evidence\n`)
      return
    }
```

(`file` is each function's fixture filename; in `capture` it is `${kind}-${transport}-${source}.json`, computed before the guard.)

At the very end of the module, after the last capture loop:

```ts
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} oracle run(s) produced no fixture:\n`)
  for (const line of failures) process.stderr.write(`  ${line}\n`)
  process.exitCode = 1
}
```

- [ ] **Step 5: Regenerate the fixtures and prove the tool changed, not the evidence**

Run: `pnpm oracle:capture`
Then: `git status --porcelain test/fixtures/oracle`
Expected: **no output** — every existing fixture is byte-identical. If any file is modified, STOP: do not commit the change, and report which file moved and how. A changed fixture means this task altered the evidence, which it must not.

Run: `npx vitest run test/oracle`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/oracle/run-oracle.ts tools/oracle/capture.ts test/oracle/run-oracle.spec.ts
git commit -m "fix(oracle): a driver that crashed leaves no fixture, and the capture exits non-zero"
```

---

## Phase G — The invariants

### Task 16: The allowlist covers all five probes (spec §10, Design and conventions)

**Files:**
- Modify: `test/diagnostics/invariants.spec.ts`

**Interfaces:**
- Consumes: every probe's current signature (Tasks 3–7).

- [ ] **Step 1: Extend the harness**

`CLAUDE.md` says the probe enforces the no-write rule mechanically, but the harness drove three of
the five probes, so `REG_EVENT` and the second connection were outside the only allowlist that
exists. Replace `runProbe` in `test/diagnostics/invariants.spec.ts`:

```ts
/** A monotonic fake clock: probes may not read a real one. */
function fakeNow(): () => number {
  let t = 0
  return () => (t += 10)
}

async function runProbe() {
  running = await startEmulator({
    transport: 'tcp',
    params: { '~SerialNumber': SERIAL, '~DeviceName': DEVICE_NAME },
    firmware: 'Ver 6.60',
    info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
    users: [emUser()],
    records: { size: 40, rows: [rec40()] },
  })
  const traced = new TracingTransport(
    new TcpTransport({ host: '127.0.0.1', port: running.port }),
    () => 0,
  )
  session = new Session(traced, { timeoutMs: 2000 })
  await session.open()
  const runner = new StepRunner(() => traced.events)
  const findings = emptyFindings()
  await probeIdentity(session, runner, findings)
  await probeState(session, runner, findings, { epochSeconds: 0, utcOffsetMinutes: 0 })
  await probeBulk(session, runner, findings, { transport: 'tcp', attendance: 'auto' }, traced.events)
  // Both opt-in probes run here even though a default CLI run skips them:
  // this is the only allowlist in the project, and a command sent by a probe
  // it never covered would be exactly the kind of write CLAUDE.md says is
  // enforced mechanically. probeConcurrent opens its own socket; probeRealtime
  // is last, because Transport.listen is one-way, once per socket.
  await probeConcurrent(runner, findings, {
    host: '127.0.0.1', port: running.port, transport: 'tcp', timeoutMs: 2000, commKey: 0,
  })
  await probeRealtime(session, runner, findings, {
    windowSeconds: 1, sleep: async () => {}, now: fakeNow(),
  })
  findings.checksum = auditChecksums(traced.events)
  return { traced, runner, findings }
}
```

Add `rec40` beside `emUser`:

```ts
function rec40(): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(1, 0)
  b.write(USER_ID, 2, 24, 'latin1')
  b.writeUInt32LE(86_400, 27)
  return b
}
```

and import `probeConcurrent, probeRealtime` from the probe module.

Add one assertion to the allowlist test, so the widening is visible:

```ts
    // The two opt-in probes really did run: without this, adding a probe and
    // forgetting to call it here would leave the allowlist passing vacuously.
    expect(sent).toContain(CMD.REG_EVENT)
    expect(sent.filter((c) => c === CMD.CONNECT).length).toBeGreaterThan(1)
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/diagnostics/invariants.spec.ts`
Expected: PASS, including the existing redaction test (`USER_ID` reaches the second connection's session but never a finding).

- [ ] **Step 3: Verify the widening catches something**

Temporarily add `await session.tryExecute(CMD.DISABLEDEVICE)` inside `probeRealtime` before `subscribe`.
Expected: the allowlist test FAILS naming 1003. Remove it afterwards.

- [ ] **Step 4: Commit**

```bash
git add test/diagnostics/invariants.spec.ts
git commit -m "test(diagnostics): the command allowlist covers the realtime and second-connection probes too"
```

---

## Phase H — Documentation and the release

### Task 17: The documents say what the tool now does (spec §11)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md`, `CLAUDE.md`, `README.md`, `docs/RELEASING.md`

- [ ] **Step 1: Amend the kit spec**

Append to `docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md`, before `## 10. Sources`:

```markdown
## 9a. Amendment, 2026-09-04 (v0.5 sub-project B)

Implemented by `2026-09-03-zkteco-diagnostics-evidence-design.md`. Three changes to what this
document says, each because a row claimed more than the wire showed.

- **§4.5, item 8** moves from "answered by `--realtime`" to **not testable by this tool**, joining
  items 12 and 22 in §4.6. This library never acknowledges a realtime event — `ackEvent` is
  implemented, tested and called from nowhere, by the v0.2 design's ruling — so a completed window
  is evidence about whether events arrive, not about whether an acknowledgment is required. The
  report names the symptom (one event, then silence) instead of claiming an answer.
- **§4.5, item 20** is answered only when a name actually carried a byte above 0x7F. `validUtf8:
  null` means no evidence either way, and the row used to read "answered" beside an observation
  saying exactly that.
- **§5.2** gains the one sanctioned exception to the redaction boundary: `findings.freeSizes.rawHex`,
  the head of the `CMD_GET_FREE_SIZES` reply, bounded to `FREE_SIZES_RAW_MAX_BYTES`. Item 4 needs
  real bytes to check `FREE_SIZES_OFFSET` against, and §4.5 names that body as its evidence; the
  boundary table did not record it. Device strings that DO travel (device name, platform, OS,
  firmware) are stripped of control characters where they are produced, so a device cannot forge a
  table row in a report meant to be pasted into a public issue.

§9's count is unchanged: this scope adds no checklist item.
```

- [ ] **Step 2: CLAUDE.md**

Replace the drill sentence at `CLAUDE.md:50-52`:

```markdown
That drill is scripted: `pnpm release:drill` runs all fifteen checks and exits 1 with a named temp
directory on failure. It runs in CI on every push, on Linux and on Windows, and on every tag —
which is the only reason a CLI that had never worked on Linux was found before a consumer met it.
```

and extend the redaction rule at `CLAUDE.md:110-113` with:

```markdown
  The one sanctioned exception is `findings.freeSizes.rawHex`, the head of the `CMD_GET_FREE_SIZES`
  reply, bounded to `FREE_SIZES_RAW_MAX_BYTES` — checklist item 4 has to check unverified offsets
  against real bytes. Strings the device chose that do travel are stripped of control characters
  where they are produced (`sanitizeDeviceString`), so a device name cannot forge a row in the
  Markdown report.
```

- [ ] **Step 3: README**

In the flag table, change the `--raw-capture <path>` row's text to end with: "Must not be the path
of either report artifact, and must not be empty: the run refuses rather than landing unredacted
bytes on top of a shareable one, or reporting a capture it never wrote."

- [ ] **Step 4: `docs/RELEASING.md` §5**

Replace the CommonJS bullet with:

```markdown
- **A CommonJS TypeScript consumer is typechecked, on one TypeScript version.** The drill writes a
  `require()`-style consumer into the installed-tarball directory and compiles it under
  `module: node16` with this repository's own `typescript` — the resolution mode that produced
  TS1479 against a single `types` condition. What that does not cover: other TypeScript versions,
  `nodenext`, and bundler resolution. It runs on both CI operating systems as of 2026-09-04.
```

and add a bullet:

```markdown
- **The drill now runs on every push, not only on a tag.** Both operating systems, Node 24. A
  packaging regression is found on the commit that introduces it rather than by burning a version
  number.
```

- [ ] **Step 5: Verify nothing else contradicts**

Run: `grep -rn "eleven checks\|item 8" CLAUDE.md README.md docs/RELEASING.md docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md`
Expected: no stale "eleven checks"; every remaining "item 8" reference reads as the amendment describes.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/RELEASING.md docs/superpowers/specs/2026-08-30-zkteco-bringup-kit-design.md
git commit -m "docs: item 8 cannot be answered here, the free-sizes exception is recorded, and the drill's remit is stated"
```

---

### Task 18: The full check, the drill, and the handoff (spec §12)

**Files:**
- Create: `docs/superpowers/plans/2026-09-04-continuing-past-v0.5.0-HANDOFF.md`

- [ ] **Step 1: The full check, in the load-bearing order**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS, every suite.

Run: `pnpm release:drill`
Expected: 15/15 checks pass.

- [ ] **Step 2: Write the handoff**

Create `docs/superpowers/plans/2026-09-04-continuing-past-v0.5.0-HANDOFF.md`, continuing the series
(read `2026-09-01-continuing-past-v0.4.3-HANDOFF.md` for the voice). It must say, in the project's
own words:

- What v0.5 was: two sub-projects from one code review — library correctness (merged 2026-09-02,
  commit 30a06d6) and diagnostics evidence (this plan). The tag is `v0.5.0`, pushed after both.
- What the kit now claims, and what it still cannot: item 8 and items 12 and 22 are not testable by
  this tool; item 22's question is still open; no physical device has been tested, so every byte
  layout remains a hypothesis.
- What the drill proves and what it does not: fifteen checks, both operating systems, one
  TypeScript version for the consumer typecheck, and a publish job that rebuilds rather than
  publishing the drilled bytes.
- The open questions this cycle did not close: whether a device answers after the deadline (item
  22), whether `ackEvent` is needed (item 8's symptom), the 28-byte user record dialect over UDP,
  and the unverified `FREE_SIZES_OFFSET` table that experiment E0b's control did not corroborate.
- Where the evidence lives: `test/fixtures/oracle/`, `PROVENANCE.md`, and the two v0.5 specs.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-09-04-continuing-past-v0.5.0-HANDOFF.md
git commit -m "docs: handoff for continuing past v0.5.0"
```

- [ ] **Step 4: Stop here**

Do **not** merge, push, or tag. The controller runs the whole-branch review first, then merges,
pushes, and pushes `v0.5.0`; the publish job waits for the operator's approval of the
`npm-publish` environment (spec §12).

---

## Self-review against the spec

**Spec coverage.** §3.1 item 8 → Task 8. §3.2 the tag → Task 18 Step 4 plus the controller's
merge. §3.3 approach → the task list as a whole. §4.1 → Task 4 (probe) and Task 8 (item 4's
sentence). §4.2 → Task 1 (runner, classification, attribution) and Tasks 3, 5 (the inline-decoding
steps). §4.3 → Task 7. §4.4 → Task 6. §4.5 → Task 3. §4.6 → Task 5 (probe) and Task 8 (rows 15–17).
§4.7 → Task 8. §4.8 → Task 7 (`concurrent.attempted`) and Task 8 (the fallbacks, with the deviation
named). §4.9 → Task 17 (CLAUDE.md, kit spec §5.2). §5.1 → Task 2. §5.2 → Task 2. §6.1 → Task 8.
§6.2 → Task 5 (source) and Task 9 (renderer). §7 → Task 10. §8.1 → Task 11. §8.2–§8.4 → Task 12.
§8.5–§8.6 → Task 13. §8.7 → Task 14. §8.8 → the count reaches fifteen across Tasks 11 and 13.
§9 → Task 15. §10 → each task's own test step; the invariants row → Task 16. §11 → Task 17.
§12 → Task 18. §13 → Task 17's kit-spec amendment.

**Names used across tasks.** `declined(outcome, value)` / `replyOutcome(command)` /
`REJECTED_COMMAND_MESSAGE` (Task 1, used in 3, 5, 6, 7); `attemptedCommand` on `TraceEvent`
(Task 2); `HostClock { epochSeconds, utcOffsetMinutes }` (Task 3, used in 10 and 16);
`attendanceRequested(events)` (Task 4); `sanitizeDeviceString(value)` and `ParameterFinding.outcome`
(Task 5, used in 8); `Findings.realtime.heldOpen/endedAfterMs/nonEventPackets` and `probeRealtime`'s
`now` (Task 6, used in 8, 10, 16); `probeConcurrent`'s `commKey` (Task 7, used in 10, 16);
`answeredIf`, `reason`, `realtimeState`, `codeSpan`, `deviceValue` (Tasks 8 and 9);
`consumerSource()` / `consumerTsconfig(repoRoot)` (Task 13); `OracleRun` / `run` /
`runOracleScript` / `succeeded` / `describeFailure` / `pythonPath` (Task 15).

**Two things this plan deliberately does not do.** It does not turn `Findings.realtime` and
`Findings.concurrent` into discriminated unions (Task 8 names the trade-off and leaves the choice
to a reviewer), and it does not add a `--realtime-ack` probe (spec §3.1 rejected it for this cycle:
it would put a packet on the wire that neither reference implementation sends).

