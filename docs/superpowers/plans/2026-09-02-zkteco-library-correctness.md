# Library Correctness (v0.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the library-side defects of the 2026-09-02 review without adding a wire hypothesis: bounded exchanges, transports that end on failure, a bulk read that follows the readable reference, identities that are never fabricated, and packaging that works for CommonJS consumers.

**Architecture:** A shared `PacketInbox` replaces the state machine both transports duplicate, then each transport fix lands once. The session bounds its own exchanges (one in flight, teardown on timeout or framing failure). The bulk reader's legacy transfer loop becomes `readTransfer`, which the buffered path reuses per chunk, matching zkteco-js. The emulator moves to the same model and gains knobs for the tests and for four black-box pyzk experiments whose results go to `PROVENANCE.md`.

**Tech Stack:** TypeScript 5.7, Node ≥ 20.19, `node:net` / `node:dgram` only, vitest 2 with real localhost sockets against `test/emulator/`, tsup, pnpm. pyzk (GPL-2.0) is executed through `tools/oracle/.venv`, never read.

**Spec:** `docs/superpowers/specs/2026-09-02-zkteco-library-correctness-design.md` — read it first; every task cites the section it implements.

## Global Constraints

- **No runtime dependencies.** `node:net` and `node:dgram` only; never a native module.
- **Never return a `Date`.** Device times stay `ZkNaiveTime`.
- **Never fabricate an identity.** An unresolvable user id is `null`, with `userIdSource: null`.
- **Refuse rather than guess.** Data failing a framing check throws; it is never parsed into plausible garbage.
- **Do not read `pyzk` source.** Execute it as a black box only. `zkteco-js` (MIT, in `node_modules`) may be read.
- **No write paths. Do not add first-hardware checklist items.**
- **No new wire hypothesis without recorded evidence** (spec §1.3). Every byte-layout change here restates `zkteco-js` lines named in the spec's §17.
- **Run `pnpm build` before `pnpm test`.** `test/smoke.spec.ts` reads `dist/`. Full check at any point: `pnpm build && pnpm typecheck && pnpm test`.
- **Every fix has a test in both directions** (spec §13): the test passes after the fix, and you run it once against the pre-fix code (the named mutation) and confirm it fails **for the reason the table names**, not for some other reason. Each task says how.
- **Both transports.** Session-level and transport-level suites loop `for (const kind of ['tcp', 'udp'] as const)`; a new scenario goes inside that loop unless it is TCP-only by nature (then `it.skipIf(kind !== 'tcp')`).
- **Imports use `.js` extensions** (`import { CMD } from '../codec/commands.js'`) even from `.ts` files; this is an ESM package.
- **Version bump is the last task** and moves `package.json` and `src/index.ts` together; no tag (spec §10.3).
- **Commit after every task.** Message style: `type(scope): what, in the project's voice` (see `git log`). No `Co-Authored-By` trailer is required by the repo; add one if your tooling does.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/transport/inbox.ts` (new) | `PacketInbox`: queue, one pending receive, one listener; the state machine both transports shared |
| `src/transport/Transport.ts` | interface; `connect(timeoutMs)` |
| `src/transport/tcp.ts` | socket, framing accumulator, retained-failure policy, connect deadline, terminal framing failure |
| `src/transport/udp.ts` | socket, connected peer, take-and-forget failure policy, connect deadline |
| `src/transport/createTransport.ts` (new) | the one `'tcp' \| 'udp'` factory |
| `src/session/Session.ts` | one exchange at a time; teardown on timeout/framing; subscribe guards; close delegates to abandon |
| `src/session/dataRead.ts` | `readTransfer`; buffered path per reference; fallback on `ACK_ERROR` only |
| `src/codec/commands.ts` | `BUFFER_FCT` |
| `src/codec/framing.ts` | throws `ZkFramingError` |
| `src/codec/records/user.ts` | 9-byte printed id |
| `src/commands/attendance.ts` | count bracket; collision-safe lookup |
| `src/realtime/Subscription.ts` | state union; `start()` |
| `src/ZkDevice.ts` | disconnect awaits connect; uses `createTransport`; calls `start()` |
| `src/diagnostics/report.ts`, `TracingTransport.ts` | only the mechanical edits that keep the kit green (class name of the cap error; `connect(timeoutMs)` passthrough) |
| `test/emulator/index.ts` | reference bulk model; new knobs (spec §11) |
| `tools/emulator-serve.ts` | 9-byte ids |
| `tools/oracle/capture_pyzk.py`, `tools/oracle/experiments.ts` (new) | the four black-box experiments (spec §12) |
| `test/fixtures/oracle/bulk/*.json` (new), `test/oracle/bulk.spec.ts` (new) | experiment results and their presence check |
| `package.json`, `tsup.config.ts`, `test/smoke.spec.ts` | nested `types`; CLI ESM-only; assertions |
| `README.md`, `CLAUDE.md`, `PROVENANCE.md`, v0.1 spec §12 item 22 | documentation (spec §14) |

---

## Phase A — Transport

### Task 1: Extract `PacketInbox` with no behaviour change (spec §4.1)

**Files:**
- Create: `src/transport/inbox.ts`
- Create: `test/transport/inbox.spec.ts`
- Modify: `src/transport/tcp.ts` (whole file), `src/transport/udp.ts` (whole file)

**Interfaces:**
- Produces: `class PacketInbox { deliver(payload: Buffer): void; receive(timeoutMs: number, held: () => Error | null): Promise<Buffer>; listen(onPacket: (p: Buffer) => void, onError: (e: Error) => void, held: () => Error | null): void; notify(err: Error): boolean; settle(err: Error): void; clear(): void; readonly listening: boolean }`. `held` is a thunk so a transport's read-and-clear policy (UDP) runs only at the moment the inbox would use it, after the guards — the same order the two files have today.
- Consumed by: Tasks 2, 4, 5, 6.

- [ ] **Step 1: Write the inbox unit test**

`test/transport/inbox.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PacketInbox } from '../../src/transport/inbox.js'
import { ZkConnectionError, ZkTimeoutError } from '../../src/errors.js'

const none = (): Error | null => null
const a = Buffer.from('aa', 'hex')
const b = Buffer.from('bb', 'hex')

describe('PacketInbox', () => {
  it('queues a payload delivered before anyone asks, in order', async () => {
    const inbox = new PacketInbox()
    inbox.deliver(a)
    inbox.deliver(b)
    expect(await inbox.receive(100, none)).toBe(a)
    expect(await inbox.receive(100, none)).toBe(b)
  })

  it('hands a payload to a pending receive and clears its timer', async () => {
    const inbox = new PacketInbox()
    const pending = inbox.receive(5_000, none)
    inbox.deliver(a)
    expect(await pending).toBe(a)
  })

  it('refuses a second concurrent receive without disturbing the first', async () => {
    const inbox = new PacketInbox()
    const first = inbox.receive(1_000, none)
    await expect(inbox.receive(1_000, none)).rejects.toBeInstanceOf(ZkConnectionError)
    inbox.deliver(a)
    expect(await first).toBe(a)
  })

  it('times out a receive nobody answers', async () => {
    const inbox = new PacketInbox()
    await expect(inbox.receive(20, none)).rejects.toBeInstanceOf(ZkTimeoutError)
  })

  it('rejects with the held failure only when the queue is empty', async () => {
    const inbox = new PacketInbox()
    const held = (): Error | null => new ZkConnectionError('held')
    inbox.deliver(a)
    expect(await inbox.receive(100, held)).toBe(a)
    await expect(inbox.receive(100, held)).rejects.toThrow('held')
  })

  it('does not consult the held failure when a guard refuses first', async () => {
    const inbox = new PacketInbox()
    let consulted = 0
    const held = (): Error | null => { consulted += 1; return null }
    inbox.listen(() => {}, () => {}, none)
    await expect(inbox.receive(100, held)).rejects.toBeInstanceOf(ZkConnectionError)
    expect(consulted).toBe(0)
  })

  it('listen drains the queue, reports a held failure, and is one-way', () => {
    const inbox = new PacketInbox()
    inbox.deliver(a)
    const got: Buffer[] = []
    const errs: Error[] = []
    inbox.listen((p) => got.push(p), (e) => errs.push(e), () => new ZkConnectionError('dead'))
    expect(got).toEqual([a])
    expect(errs[0]?.message).toBe('dead')
    expect(inbox.listening).toBe(true)
    expect(() => inbox.listen(() => {}, () => {}, none)).toThrow(ZkConnectionError)
  })

  it('refuses listen while a receive is pending', async () => {
    const inbox = new PacketInbox()
    const pending = inbox.receive(1_000, none)
    expect(() => inbox.listen(() => {}, () => {}, none)).toThrow(ZkConnectionError)
    inbox.deliver(a)
    await pending
  })

  it('notify tells a pending receive and says so; says not when nobody waits', async () => {
    const inbox = new PacketInbox()
    expect(inbox.notify(new Error('nobody'))).toBe(false)
    const pending = inbox.receive(1_000, none)
    expect(inbox.notify(new ZkConnectionError('gone'))).toBe(true)
    await expect(pending).rejects.toThrow('gone')
  })

  it('notify tells a listener', () => {
    const inbox = new PacketInbox()
    const errs: Error[] = []
    inbox.listen(() => {}, (e) => errs.push(e), none)
    expect(inbox.notify(new Error('x'))).toBe(true)
    expect(errs).toHaveLength(1)
  })

  it('settle rejects a pending receive and is a no-op otherwise', async () => {
    const inbox = new PacketInbox()
    inbox.settle(new Error('nobody'))
    const pending = inbox.receive(1_000, none)
    inbox.settle(new ZkConnectionError('closed'))
    await expect(pending).rejects.toThrow('closed')
  })

  it('clear drops queued payloads', async () => {
    const inbox = new PacketInbox()
    inbox.deliver(a)
    inbox.clear()
    await expect(inbox.receive(20, none)).rejects.toBeInstanceOf(ZkTimeoutError)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/transport/inbox.spec.ts`
Expected: FAIL — cannot resolve `../../src/transport/inbox.js`.

- [ ] **Step 3: Write `src/transport/inbox.ts`**

```ts
import { ZkConnectionError, ZkTimeoutError } from '../errors.js'

interface Pending {
  resolve: (payload: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface Listener {
  onPacket: (payload: Buffer) => void
  onError: (err: Error) => void
}

/**
 * The receive-side state machine both transports share: complete payloads
 * waiting to be claimed, at most one pending `receive()`, and at most one
 * listener once `listen()` has flipped the socket to push mode.
 *
 * `pending` is one object or null, so a resolve without its reject cannot be
 * expressed. Before this class the two callbacks were separate nullable
 * fields set and cleared together at six sites per transport, and the whole
 * forty-five lines existed twice (spec v0.5 §4.1).
 *
 * `held` is a thunk, not a value: UdpTransport reads AND clears its recorded
 * failure in one step, and that must happen only at the point this inbox
 * would use it — after the guards — or a refused receive() would consume a
 * failure meant for the next consumer.
 */
export class PacketInbox {
  private queue: Buffer[] = []
  private pending: Pending | null = null
  private listener: Listener | null = null

  get listening(): boolean {
    return this.listener !== null
  }

  /** A complete payload arrived: listener first, then a pending receive, then the queue. */
  deliver(payload: Buffer): void {
    if (this.listener) {
      this.listener.onPacket(payload)
      return
    }
    const pending = this.takePending()
    if (pending) {
      pending.resolve(payload)
      return
    }
    this.queue.push(payload)
  }

  receive(timeoutMs: number, held: () => Error | null): Promise<Buffer> {
    if (this.listener) {
      return Promise.reject(
        new ZkConnectionError('this transport is listening for events; receive() is not available'),
      )
    }
    if (this.pending) {
      return Promise.reject(
        new ZkConnectionError(
          'a receive() is already pending; this transport does not support concurrent receives',
        ),
      )
    }
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    const failure = held()
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new ZkTimeoutError(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = { resolve, reject, timer }
    })
  }

  listen(
    onPacket: (payload: Buffer) => void,
    onError: (err: Error) => void,
    held: () => Error | null,
  ): void {
    if (this.listener) throw new ZkConnectionError('this transport is already listening')
    if (this.pending) throw new ZkConnectionError('cannot listen while a receive() is pending')
    this.listener = { onPacket, onError }
    const queued = this.queue
    this.queue = []
    for (const payload of queued) onPacket(payload)
    const failure = held()
    if (failure) onError(failure)
  }

  /** Tells whoever is waiting. Returns whether anyone was. */
  notify(err: Error): boolean {
    const pending = this.takePending()
    if (pending) {
      pending.reject(err)
      return true
    }
    if (this.listener) {
      this.listener.onError(err)
      return true
    }
    return false
  }

  /** Rejects a pending receive, if any. For close(). */
  settle(err: Error): void {
    const pending = this.takePending()
    if (pending) pending.reject(err)
  }

  /** Drops queued payloads. For a framing failure, after which nothing queued belongs to a live exchange. */
  clear(): void {
    this.queue = []
  }

  private takePending(): Pending | null {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    return pending
  }
}
```

- [ ] **Step 4: Run the inbox test**

Run: `npx vitest run test/transport/inbox.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Rewrite `src/transport/tcp.ts` over the inbox**

Replace the whole file. Behaviour is identical to today (last failure still wins; that changes in Task 2):

```ts
import net from 'node:net'
import { frameTcp, tryUnframeTcp } from '../codec/framing.js'
import { ZkConnectionError } from '../errors.js'
import { PacketInbox } from './inbox.js'
import type { Transport, TransportOptions } from './Transport.js'

/** Idle milliseconds before the OS probes a listening connection. */
const KEEPALIVE_DELAY_MS = 30_000

export class TcpTransport implements Transport {
  private socket: net.Socket | null = null
  /** Bytes arrived but not yet consumed as complete packets. */
  private buffered = Buffer.alloc(0)
  private readonly inbox = new PacketInbox()
  private failure: Error | null = null

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
        // Release the accumulator along with failing the connection. The
        // bytes cannot be re-parsed — the frame they belong to was rejected —
        // and holding them keeps a rejected oversized length costing memory
        // for the life of the object.
        this.buffered = Buffer.alloc(0)
        this.fail(err as Error)
        return
      }
      if (!framed) return
      this.buffered = this.buffered.subarray(framed.consumed)
      this.inbox.deliver(framed.payload)
    }
  }

  /**
   * Records a socket failure and tells whoever is waiting on this transport.
   *
   * The failure is kept for the life of the object, deliberately, and this is
   * where TcpTransport and UdpTransport part company. A TCP failure means the
   * connection is gone — 'close' and 'error' both route here — so every later
   * receive() on this transport really is doomed, and answering each one with
   * the reason is the most useful thing it can do.
   *
   * UdpTransport forgets a failure once it has been delivered, because a UDP
   * socket has no connection to lose and stays usable after an error about a
   * single datagram. See the decision rule on UdpTransport.fail; the
   * difference is a considered one, not drift.
   */
  private fail(err: Error): void {
    this.failure = err
    this.inbox.notify(err)
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
    return this.inbox.receive(timeoutMs, () => this.failure)
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    this.inbox.listen(onPacket, onError, () => this.failure)
    // A dead peer on a listening connection is otherwise indistinguishable
    // from a quiet one, and a quiet one is normal at 03:00.
    this.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS)
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

- [ ] **Step 6: Rewrite `src/transport/udp.ts` over the inbox**

Replace the whole file. Keep the long docblocks on `connect`'s error handler and on `fail` verbatim from the current file (they are the recorded reasoning); only the bodies change:

```ts
import dgram from 'node:dgram'
import { ZkConnectionError } from '../errors.js'
import { PacketInbox } from './inbox.js'
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
  private readonly inbox = new PacketInbox()
  private failure: Error | null = null

  constructor(private readonly opts: TransportOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      let connectSettled = false
      // (keep the existing docblock on why this handler is durable and branches on connectSettled)
      sock.on('error', (err) => {
        const failure = new ZkConnectionError(err.message)
        if (connectSettled) {
          this.fail(failure)
          return
        }
        connectSettled = true
        sock.close()
        reject(failure)
      })
      sock.on('message', (msg) => this.inbox.deliver(Buffer.from(msg)))
      sock.bind(0, () => { this.socket = sock; connectSettled = true; resolve() })
    })
  }

  // (keep the existing DECISION RULE docblock on fail)
  private fail(err: Error): void {
    if (this.inbox.notify(err)) return
    // Nobody to tell yet, so hold it for whoever arrives next: a consumer
    // that attaches to a dead socket and then waits forever is a hang, not a
    // failure.
    this.failure = err
  }

  // (keep the existing docblock on takeFailure)
  private takeFailure(): Error | null {
    const err = this.failure
    this.failure = null
    return err
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
    return this.inbox.receive(timeoutMs, () => this.takeFailure())
  }

  listen(onPacket: (payload: Buffer) => void, onError: (err: Error) => void): void {
    // (keep the existing comment on what listenerError is for)
    this.inbox.listen(onPacket, onError, () => this.takeFailure())
  }

  close(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (!sock) return Promise.resolve()
    return new Promise((resolve) => { sock.close(() => resolve()) })
  }
}
```

- [ ] **Step 7: Prove no behaviour changed**

Run: `npx vitest run test/transport test/session test/realtime test/scenarios.spec.ts`
Expected: PASS, every test. The listen suite's "reports a recorded failure once and does not replay it" and "does not record a failure that was delivered straight to a pending receive()" are the ones that pin the two policies through the thunk; if either fails, the thunk order in `receive`/`listen` is wrong.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add src/transport/inbox.ts src/transport/tcp.ts src/transport/udp.ts test/transport/inbox.spec.ts
git commit -m "refactor(transport): one PacketInbox for the state machine both transports carried"
```

---

### Task 2: TCP keeps its first failure (spec §4.2)

**Files:**
- Modify: `src/transport/tcp.ts` (`fail`)
- Test: `test/transport/tcp.spec.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('TcpTransport', …)` in `test/transport/tcp.spec.ts`:

```ts
  // A socket 'error' is followed by a 'close'. The first is the informative
  // one; the second is generic. Last-wins overwrote the reason with
  // "connection closed by peer" on every socket error.
  it('keeps the first failure it saw, not the last', async () => {
    running = await startEmulator({ transport: 'tcp' })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect()
    const sock = (transport as unknown as { socket: net.Socket }).socket
    sock.emit('error', new Error('simulated ECONNRESET'))
    sock.emit('close')
    await expect(transport.receive(200)).rejects.toThrow(/simulated ECONNRESET/)
  })
```

- [ ] **Step 2: Run it to see it fail for the intended reason**

Run: `npx vitest run test/transport/tcp.spec.ts -t "keeps the first failure"`
Expected: FAIL with the rejection message `connection closed by peer` (the generic close text). If it fails any other way, the emitted order is not error-then-close; fix the test, not the code.

- [ ] **Step 3: Implement first-wins**

In `src/transport/tcp.ts`, `fail`:

```ts
  private fail(err: Error): void {
    // First failure wins. A socket 'error' is followed by 'close', and a
    // framing failure (Task 5) by the destroy it triggers; the first event
    // is the cause and the second is its consequence.
    this.failure ??= err
    this.inbox.notify(err)
  }
```

Add to the docblock above it: "The failure kept is the FIRST one: a socket 'error' is followed by a 'close', and the close message says nothing the error did not."

- [ ] **Step 4: Run the transport suites**

Run: `npx vitest run test/transport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/tcp.ts test/transport/tcp.spec.ts
git commit -m "fix(transport): a TCP failure keeps its first cause, not the close that follows it"
```

---

### Task 3: `connect(timeoutMs)` bounds connecting (spec §4.3)

**Files:**
- Modify: `src/transport/Transport.ts:19`, `src/transport/tcp.ts` (`connect`), `src/transport/udp.ts` (`connect`), `src/session/Session.ts:52`, `src/diagnostics/TracingTransport.ts:66-73`
- Test: `test/transport/tcp.spec.ts`, `test/transport/udp.spec.ts`

**Interfaces:**
- Produces: `Transport.connect(timeoutMs: number): Promise<void>`. `Session.open` passes `this.opts.timeoutMs`. `ScriptedTransport` in `test/session/session.spec.ts` declares `async connect(): Promise<void> {}`, which remains assignable (fewer parameters); leave it.

- [ ] **Step 1: Write the failing tests**

Append to `describe('TcpTransport', …)` in `test/transport/tcp.spec.ts`:

```ts
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): not routable, so the SYN goes out and
  // nothing answers. Without a deadline this hangs ~21 s on Windows and ~127 s
  // on Linux. On a host with no default route the connect fails fast with
  // ENETUNREACH instead — still a ZkConnectionError, so the assertion below
  // holds either way, but only the hanging case exercises the timer, which is
  // why the elapsed time is asserted too.
  it('rejects a connect that does not complete within the deadline', async () => {
    transport = new TcpTransport({ host: '192.0.2.1', port: 4370 })
    const started = Date.now()
    await expect(transport.connect(200)).rejects.toBeInstanceOf(ZkConnectionError)
    expect(Date.now() - started).toBeLessThan(1_500)
    transport = null
  }, 5_000)

  it('names the deadline in the message when the deadline is what ended it', async () => {
    transport = new TcpTransport({ host: '192.0.2.1', port: 4370 })
    const err = await transport.connect(200).then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(ZkConnectionError)
    // Either the timer fired (the message names it) or the network refused
    // outright (the message names the errno). Never a bare hang.
    expect(err!.message).toMatch(/within 200ms|E[A-Z]+/)
    transport = null
  }, 5_000)
```

Change every existing `await transport.connect()` in `test/transport/tcp.spec.ts`, `test/transport/udp.spec.ts`, `test/transport/listen.spec.ts` and `test/emulator/emulator.spec.ts` to `await transport.connect(2_000)` (and `traced.connect()` in `test/diagnostics/tracing.spec.ts` to `traced.connect(2_000)`).

- [ ] **Step 2: Run to see the failure**

Run: `pnpm typecheck`
Expected: errors — `connect` takes 0 arguments. (The typecheck is the red here; the runtime test would hang for 21 s.)

- [ ] **Step 3: Change the interface and both transports**

`src/transport/Transport.ts`, replace the `connect` line and add its doc:

```ts
  /**
   * Opens the socket. Rejects with ZkConnectionError if that has not
   * completed within `timeoutMs` — the same deadline that bounds every
   * request, because ZkDeviceOptions.timeoutMs promises exactly that.
   */
  connect(timeoutMs: number): Promise<void>
```

`src/transport/tcp.ts`, replace `connect`:

```ts
  connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port })
      const where = `${this.opts.host}:${this.opts.port}`
      const settle = (err: Error): void => {
        sock.destroy()
        reject(err)
      }
      const onError = (err: Error): void =>
        settle(new ZkConnectionError(`cannot connect to ${where}: ${err.message}`))
      const onTimeout = (): void =>
        settle(new ZkConnectionError(`cannot connect to ${where} within ${timeoutMs}ms`))
      // A socket timeout fires after `timeoutMs` of inactivity, and a connect
      // that has not completed is inactivity. Cleared on connect: after that,
      // silence is normal (a listening socket at 03:00) and the per-request
      // deadline lives in receive().
      sock.setTimeout(timeoutMs)
      sock.once('error', onError)
      sock.once('timeout', onTimeout)
      sock.once('connect', () => {
        sock.setTimeout(0)
        sock.off('error', onError)
        sock.off('timeout', onTimeout)
        this.socket = sock
        sock.on('data', (chunk) => this.absorb(chunk))
        sock.on('error', (err) => this.fail(new ZkConnectionError(err.message)))
        sock.on('close', () => this.fail(new ZkConnectionError('connection closed by peer')))
        resolve()
      })
    })
  }
```

`src/transport/udp.ts`, replace `connect` (Task 4 adds the peer connect inside this same shape):

```ts
  connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      let connectSettled = false
      const where = `${this.opts.host}:${this.opts.port}`
      const timer = setTimeout(() => {
        if (connectSettled) return
        connectSettled = true
        sock.close()
        reject(new ZkConnectionError(`cannot connect to ${where} within ${timeoutMs}ms`))
      }, timeoutMs)
      sock.on('error', (err) => {
        const failure = new ZkConnectionError(err.message)
        if (connectSettled) {
          this.fail(failure)
          return
        }
        connectSettled = true
        clearTimeout(timer)
        sock.close()
        reject(failure)
      })
      sock.on('message', (msg) => this.inbox.deliver(Buffer.from(msg)))
      sock.bind(0, () => {
        if (connectSettled) return
        connectSettled = true
        clearTimeout(timer)
        this.socket = sock
        resolve()
      })
    })
  }
```

`src/session/Session.ts:52`: `await this.transport.connect(this.opts.timeoutMs)`.

`src/diagnostics/TracingTransport.ts:66-73`:

```ts
  async connect(timeoutMs: number): Promise<void> {
    try {
      await this.inner.connect(timeoutMs)
    } catch (err) {
      this.record('error', undefined, err as Error)
      throw err
    }
  }
```

- [ ] **Step 4: Typecheck, then run the new tests and the suites that touch connect**

Run: `pnpm typecheck && npx vitest run test/transport test/session test/diagnostics/tracing.spec.ts test/emulator test/scenarios.spec.ts`
Expected: PASS. The two new TCP tests take about 200 ms each.

- [ ] **Step 5: Commit**

```bash
git add src/transport src/session/Session.ts src/diagnostics/TracingTransport.ts test
git commit -m "fix(transport): connect() is bounded by the request deadline it was documented to share"
```

---

### Task 4: The UDP socket is connected to the device (spec §4.4)

**Files:**
- Modify: `src/transport/udp.ts` (`connect`, `send`)
- Test: `test/transport/udp.spec.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe('UdpTransport', …)` in `test/transport/udp.spec.ts` (add `import dgram from 'node:dgram'` and `import { encodePayload } …` if not already imported there):

```ts
  // Any host that could reach the client's ephemeral port used to be the
  // device: the socket was bound on every interface and the message handler
  // never looked at the sender. A connected socket lets the kernel drop the
  // forgery before this library sees it.
  it('ignores a datagram from a peer that is not the device', async () => {
    running = await startEmulator({ transport: 'udp', behavior: 'silent' })
    transport = new UdpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    const clientPort = (transport as unknown as { socket: dgram.Socket }).socket.address().port

    const pending = transport.receive(300)
    const forger = dgram.createSocket('udp4')
    const forged = encodePayload({ command: CMD.ACK_OK, sessionId: 0xbad, replyId: 0 })
    await new Promise<void>((r) => forger.send(forged, clientPort, '127.0.0.1', () => r()))
    try {
      // The emulator is silent, so the ONLY thing that could resolve this is
      // the forgery. A timeout is the pass.
      await expect(pending).rejects.toBeInstanceOf(ZkTimeoutError)
    } finally {
      forger.close()
    }
  })
```

- [ ] **Step 2: Run it to see it fail for the intended reason**

Run: `npx vitest run test/transport/udp.spec.ts -t "ignores a datagram"`
Expected: FAIL — `pending` resolves with the forged payload (the assertion says it expected a rejection and got a resolved promise). That is the defect.

- [ ] **Step 3: Connect the socket and drop the address from send**

In `src/transport/udp.ts`, replace the `sock.bind(0, …)` call inside `connect` with:

```ts
      sock.bind(0, () => {
        if (connectSettled) return
        // Connected, not merely bound: from here the kernel delivers only
        // datagrams from this peer and drops the rest, and send() needs no
        // address. This is the whole of the network-level defence against a
        // forged reply (spec v0.5 §4.4). The name is resolved once, here.
        sock.connect(this.opts.port, this.opts.host, () => {
          if (connectSettled) return
          connectSettled = true
          clearTimeout(timer)
          this.socket = sock
          resolve()
        })
      })
```

A lookup or connect error arrives on the socket's `'error'` event, which the handler above already routes to `reject` while `connectSettled` is false.

Replace `send`:

```ts
  send(payload: Buffer): Promise<void> {
    const sock = this.socket
    if (!sock) return Promise.reject(new ZkConnectionError('transport is not connected'))
    return new Promise((resolve, reject) => {
      sock.send(payload, (err) => (err ? reject(new ZkConnectionError(err.message)) : resolve()))
    })
  }
```

Add one sentence to the `fail` docblock after the Windows ECONNRESET sentence: "With the socket connected (v0.5), an ICMP port-unreachable surfaces as an 'error' on every platform, not only Windows; the rule is unchanged and now applies uniformly."

- [ ] **Step 4: Run the UDP-touching suites**

Run: `npx vitest run test/transport test/session test/realtime test/scenarios.spec.ts test/commands`
Expected: PASS, including the UDP failure-path tests in `listen.spec.ts`, which emit `'error'` directly and are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/transport/udp.ts test/transport/udp.spec.ts
git commit -m "fix(transport): the UDP socket is connected, so only the device can answer"
```

---

### Task 5: A TCP framing failure ends the transport (spec §4.5)

**Files:**
- Modify: `src/codec/framing.ts:1,39,49`, `src/transport/tcp.ts` (`absorb`, `send`), `src/diagnostics/report.ts:168-193`
- Test: `test/transport/tcp.spec.ts`, `test/codec/framing.spec.ts:4,48,60`, `test/diagnostics/report.spec.ts:233-236`

**Interfaces:**
- Produces: `tryUnframeTcp` throws `ZkFramingError`; `TcpTransport` after a framing failure: `receive()` and `send()` reject with that same `ZkFramingError`, `listen()` reports it, the queue is empty, the socket is destroyed. Task 9 keys the session teardown on this class.

- [ ] **Step 1: Write the failing tests**

Append to `describe('TcpTransport', …)` in `test/transport/tcp.spec.ts` (import `ZkFramingError` from `../../src/errors.js`):

```ts
  // After a framing failure the stream is misaligned. A good packet that was
  // queued before the junk is individually valid but belongs to an exchange
  // the session is about to tear down; serving it first is what let seventeen
  // further probe steps run on a broken stream (review R2).
  it('ends the transport on a framing failure: queue dropped, socket gone, send refused', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x11 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(connectPayload())
    await new Promise((r) => setTimeout(r, 100)) // the ACK_OK lands in the queue, unclaimed

    for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
    await new Promise((r) => setTimeout(r, 100))

    await expect(transport.receive(200)).rejects.toBeInstanceOf(ZkFramingError)
    await expect(transport.send(connectPayload())).rejects.toBeInstanceOf(ZkFramingError)
    expect((transport as unknown as { socket: net.Socket | null }).socket).toBeNull()
  })
```

Change the existing "releases the accumulator when a declared length is rejected" test's assertion from `toThrow(ZkProtocolError)` to `toThrow(ZkFramingError)`.

In `test/codec/framing.spec.ts`: import `ZkFramingError` instead of `ZkProtocolError` and change lines 48 and 60 to `toThrow(ZkFramingError)`.

In `test/diagnostics/report.spec.ts:233-236`, change the comment and assertion to:

```ts
    // The premise, asserted rather than assumed: the cap throws
    // ZkFramingError (v0.5), and TcpTransport propagates it unwrapped.
    expect(steps[0]).toMatchObject({ outcome: 'malformed', errorClass: 'ZkFramingError' })
```

- [ ] **Step 2: Run to see the failures for the intended reasons**

Run: `npx vitest run test/transport/tcp.spec.ts test/codec/framing.spec.ts test/diagnostics/report.spec.ts`
Expected: the new TCP test FAILS because `receive()` **resolves with the queued ACK_OK** (the queue was served first); the framing and report tests FAIL on the class name (`ZkProtocolError` received). Any other failure reason means the setup is wrong.

- [ ] **Step 3: Implement**

`src/codec/framing.ts`: change the import to `import { ZkFramingError } from '../errors.js'` and both `throw new ZkProtocolError(` at lines 39 and 49 to `throw new ZkFramingError(`. Update the docblock on `tryUnframeTcp`: add "Throws ZkFramingError: the bytes may be misaligned, and nothing parsed from this stream afterwards can be trusted — the transport ends on it."

`src/transport/tcp.ts`, `absorb`'s catch block:

```ts
      } catch (err) {
        // The frame was rejected, so the stream is misaligned and nothing
        // after it can be trusted: release the accumulator, drop the queue
        // (those packets belong to an exchange the session is about to tear
        // down), keep the failure as the reason, and end the socket.
        this.buffered = Buffer.alloc(0)
        this.inbox.clear()
        this.fail(err as Error)
        const sock = this.socket
        this.socket = null
        if (sock) {
          sock.removeAllListeners('close')
          sock.destroy()
        }
        return
      }
```

`src/transport/tcp.ts`, `send`:

```ts
  send(payload: Buffer): Promise<void> {
    const sock = this.socket
    if (!sock) {
      return Promise.reject(this.failure ?? new ZkConnectionError('transport is not connected'))
    }
    ...
```

`src/diagnostics/report.ts:168-193`: the cap predicate keys on the class name. Change `step.errorClass === 'ZkProtocolError'` to `step.errorClass === 'ZkFramingError'`, and rewrite the docblock's lines 174-180 to:

```ts
 * `src/codec/framing.ts`. Since v0.5 that cap throws `ZkFramingError`
 * (framing.ts:49), the same class the two RECORD parsers throw — so the class
 * alone cannot identify the cap, and the message is matched as well. Both
 * halves are load-bearing: the class keeps a ZkProtocolError whose message
 * happens to mention a size out, and the message keeps a record parser out.
```

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run test/transport test/codec test/diagnostics test/session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codec/framing.ts src/transport/tcp.ts src/diagnostics/report.ts test
git commit -m "fix(transport): a framing failure ends the connection instead of serving what queued before it"
```

---

### Task 6: `close()` settles a pending receive (spec §4.6)

**Files:**
- Modify: `src/transport/tcp.ts` (`close`), `src/transport/udp.ts` (`close`)
- Test: `test/transport/listen.spec.ts` (add a both-transport block at the end)

- [ ] **Step 1: Write the failing test**

Append to `test/transport/listen.spec.ts`:

```ts
for (const kind of ['tcp', 'udp'] as const) {
  describe(`Transport.close over ${kind}`, () => {
    it('rejects a pending receive() at once rather than leaving it to its timer', async () => {
      running = await startEmulator({ transport: kind, behavior: 'silent' })
      transport = kind === 'tcp'
        ? new TcpTransport({ host: '127.0.0.1', port: running.port })
        : new UdpTransport({ host: '127.0.0.1', port: running.port })
      await transport.connect(2_000)
      // 30 s: a receive() that ends through its own timer blows this test's
      // budget, so passing means close() is what ended it.
      const pending = transport.receive(30_000)
      await transport.close()
      const err = await pending.then(() => null, (e: unknown) => e as Error)
      expect(err).toBeInstanceOf(ZkConnectionError)
      expect(err!.message).toMatch(/closed while a receive was pending/)
      transport = null
    }, 5_000)
  })
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/transport/listen.spec.ts -t "rejects a pending receive"`
Expected: FAIL by timing out at 5 000 ms (the pending receive is never settled). That timeout is the intended reason.

- [ ] **Step 3: Settle in both `close()` methods**

`src/transport/tcp.ts`, at the top of `close()`:

```ts
  close(): Promise<void> {
    this.inbox.settle(new ZkConnectionError('transport closed while a receive was pending'))
    const sock = this.socket
    ...
```

Same first line in `src/transport/udp.ts`'s `close()`.

- [ ] **Step 4: Run the transport suites**

Run: `npx vitest run test/transport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport test/transport/listen.spec.ts
git commit -m "fix(transport): close() answers a pending receive instead of leaving it to time out"
```

---

### Task 7: One transport factory (spec §4.7)

**Files:**
- Create: `src/transport/createTransport.ts`
- Modify: `src/ZkDevice.ts:9-11,46-49`
- Test: `test/transport/createTransport.spec.ts` (new)

**Interfaces:**
- Produces: `createTransport(kind: 'tcp' | 'udp', opts: TransportOptions): Transport`. The CLI and the probe keep their own copies until the sibling spec switches them.

- [ ] **Step 1: Write the test**

`test/transport/createTransport.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTransport } from '../../src/transport/createTransport.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'

describe('createTransport', () => {
  it('builds the transport the kind names', () => {
    expect(createTransport('tcp', { host: '127.0.0.1', port: 1 })).toBeInstanceOf(TcpTransport)
    expect(createTransport('udp', { host: '127.0.0.1', port: 1 })).toBeInstanceOf(UdpTransport)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/transport/createTransport.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the factory and use it in ZkDevice**

`src/transport/createTransport.ts`:

```ts
import { TcpTransport } from './tcp.js'
import { UdpTransport } from './udp.js'
import type { Transport, TransportOptions } from './Transport.js'

/** The one place that knows which class each kind names. */
export function createTransport(kind: 'tcp' | 'udp', opts: TransportOptions): Transport {
  return kind === 'tcp' ? new TcpTransport(opts) : new UdpTransport(opts)
}
```

`src/ZkDevice.ts`: replace the two class imports with `import { createTransport } from './transport/createTransport.js'`, keep the `Transport` type import, and replace `makeTransport`:

```ts
  private makeTransport(): Transport {
    return createTransport(this.transportKind, { host: this.host, port: this.port })
  }
```

- [ ] **Step 4: Run and commit**

Run: `pnpm typecheck && npx vitest run test/transport/createTransport.spec.ts test/scenarios.spec.ts`
Expected: PASS.

```bash
git add src/transport/createTransport.ts src/ZkDevice.ts test/transport/createTransport.spec.ts
git commit -m "refactor(transport): one createTransport for the facade to call"
```

---

## Phase B — Session

### Task 8: One exchange at a time (spec §5.1)

**Files:**
- Modify: `src/session/Session.ts` (`send`, `receiveMore`, new `exchange`)
- Test: `test/session/session.spec.ts`

**Interfaces:**
- Produces: private `exchange<T>(fn: () => Promise<T>): Promise<T>` wrapping every transmit-and-receive; Task 9 adds the teardown branch inside it.

- [ ] **Step 1: Write the failing test**

Inside the `for (const transportKind …)` loop's `describe(\`Session over ${transportKind}\`)` in `test/session/session.spec.ts`, add:

```ts
    it('refuses a second request while one is in flight, before it is transmitted', async () => {
      // Answer GET_FREE_SIZES slowly so the first request is still waiting
      // when the second is issued.
      running = await startEmulator({
        transport: transportKind,
        replyDelayMs: 150,
        handlers: { [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK)] },
      })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const first = session.execute(CMD.GET_FREE_SIZES)
      const second = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e as Error)
      expect(second).toBeInstanceOf(ZkConnectionError)
      expect(second!.message).toMatch(/already in flight/)
      await expect(first).resolves.toMatchObject({ command: CMD.ACK_OK })
      // Nothing beyond CONNECT and the first request reached the wire.
      expect(running.received.map((p) => p.command)).toEqual([CMD.CONNECT, CMD.GET_FREE_SIZES])
    })
```

This test needs the emulator's `replyDelayMs` knob. Add it now to `test/emulator/index.ts`:

In `EmulatorOptions`:

```ts
  /**
   * Delays every reply by this many milliseconds. For the in-flight guard
   * (spec v0.5 §5.1) and for a reply that lands after the deadline (§5.2).
   */
  replyDelayMs?: number
```

In `startEmulator`'s TCP branch, replace `if (out) for (const p of out) sock.write(frameTcp(p))` with:

```ts
          if (out) {
            const write = (): void => { if (!sock.destroyed) for (const p of out) sock.write(frameTcp(p)) }
            if (opts.replyDelayMs) setTimeout(write, opts.replyDelayMs)
            else write()
          }
```

In the UDP branch, replace `if (out) for (const p of out) sock.send(p, rinfo.port, rinfo.address)` with:

```ts
    if (out) {
      const write = (): void => { for (const p of out) sock.send(p, rinfo.port, rinfo.address) }
      if (opts.replyDelayMs) setTimeout(write, opts.replyDelayMs)
      else write()
    }
```

(UDP `sock.send` after `close()` throws `ERR_SOCKET_DGRAM_NOT_RUNNING`; wrap the delayed UDP write in `try { … } catch { /* emulator closed first */ }`.)

- [ ] **Step 2: Run it to see it fail for the intended reason**

Run: `npx vitest run test/session/session.spec.ts -t "refuses a second request"`
Expected: FAIL on the `received` assertion: three commands on the wire (CONNECT and **two** GET_FREE_SIZES), because both requests transmit today and only the second `receive()` is refused. (The `second` may also be a ZkConnectionError today, from the transport's concurrent-receive refusal — that is why the wire assertion is the one that matters.)

- [ ] **Step 3: Implement the guard**

In `src/session/Session.ts` add a field and a method, and route `send` and `receiveMore` through it:

```ts
  private inFlight = false

  /**
   * Runs one transmit-and-receive with at most one in flight per session.
   *
   * Refused BEFORE anything is transmitted. Until v0.5 both requests went on
   * the wire and only the second receive() was refused, so the first caller
   * collected whichever reply came first and the other reply sat in the
   * queue for the next request (review R1, second half).
   */
  private async exchange<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      throw new ZkConnectionError(
        'a request is already in flight on this session; issue one at a time',
      )
    }
    this.inFlight = true
    try {
      return await fn()
    } finally {
      this.inFlight = false
    }
  }

  private send(command: number, data?: Buffer, override?: { sessionId: number }): Promise<DecodedPacket> {
    return this.exchange(async () => {
      await this.transmit(command, data, override)
      return decodePayload(await this.transport.receive(this.opts.timeoutMs))
    })
  }

  async receiveMore(): Promise<DecodedPacket> {
    this.assertOpen()
    return this.exchange(async () => decodePayload(await this.transport.receive(this.opts.timeoutMs)))
  }
```

Keep `send`'s existing docblock about the reply-id quirk above it.

- [ ] **Step 4: Run the session suites**

Run: `npx vitest run test/session test/commands test/realtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/Session.ts test/session/session.spec.ts test/emulator/index.ts
git commit -m "fix(session): one request in flight, refused before the second is transmitted"
```

---

### Task 9: A timeout or framing failure ends the session; a dropped connection closes it (spec §5.2)

**Files:**
- Modify: `src/session/Session.ts` (`exchange`, `abandon`)
- Test: `test/session/session.spec.ts`

- [ ] **Step 1: Write the failing tests**

Inside the same `describe(\`Session over ${transportKind}\`)`:

```ts
    it('closes the session on a timeout so a late reply is never collected by the next request', async () => {
      running = await startEmulator({
        transport: transportKind,
        replyDelayMs: 400,
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => [reply(state, req, CMD.ACK_OK, Buffer.from('late'))],
        },
      })
      // CONNECT is delayed too, so the open() deadline must clear it.
      session = new Session(makeTransport(running.port), { timeoutMs: 1000 })
      await session.open()
      ;(session as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs = 150
      await expect(session.execute(CMD.GET_FREE_SIZES)).rejects.toBeInstanceOf(ZkTimeoutError)

      // The late reply lands here. Before v0.5 the next call returned it.
      await new Promise((r) => setTimeout(r, 500))
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      // The goodbye was sent on the way out.
      expect(running.received.map((p) => p.command)).toContain(CMD.EXIT)
      session = null
    })

    it('closes the session when the connection drops, and says so rather than the socket', async () => {
      running = await startEmulator({ transport: transportKind, handlers: { [CMD.GET_FREE_SIZES]: () => null } })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const pending = session.execute(CMD.GET_FREE_SIZES)
      await new Promise((r) => setTimeout(r, 50))
      await running.close() // the peer goes away mid-request
      running = null
      // TCP sees the close; UDP sees nothing and times out. Both end the session.
      await expect(pending).rejects.toBeInstanceOf(transportKind === 'tcp' ? ZkConnectionError : ZkTimeoutError)
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      session = null
    })

    it.skipIf(transportKind !== 'tcp')('closes the session on a framing failure and sends the goodbye', async () => {
      running = await startEmulator({ transport: 'tcp', handlers: { [CMD.GET_FREE_SIZES]: () => null } })
      session = new Session(makeTransport(running.port), { timeoutMs: 2000 })
      await session.open()
      const pending = session.execute(CMD.GET_FREE_SIZES)
      await new Promise((r) => setTimeout(r, 50))
      for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
      await expect(pending).rejects.toBeInstanceOf(ZkFramingError)
      const next = await session.execute(CMD.GET_TIME).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      session = null
    })
```

Add `ZkFramingError` to the errors import at the top of the file.

- [ ] **Step 2: Run to see the failures for the intended reasons**

Run: `npx vitest run test/session/session.spec.ts -t "closes the session"`
Expected: the timeout test FAILS because the second call **resolves** with the late `ACK_OK` carrying `late` (or, over UDP where the connected socket may drop it, resolves with the GET_TIME reply) — either way not a rejection; the dropped-connection test FAILS with the socket's message rather than "this session is not open"; the framing test FAILS because the next call reaches the transport and rejects with the retained `ZkFramingError`.

- [ ] **Step 3: Implement the teardown in `exchange`**

Replace `exchange` from Task 8 with:

```ts
  private async exchange<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      throw new ZkConnectionError(
        'a request is already in flight on this session; issue one at a time',
      )
    }
    this.inFlight = true
    try {
      return await fn()
    } catch (err) {
      // A timeout means a reply may still be coming, and the next request
      // would collect it as its own (checklist item 22). A framing failure
      // means the stream is misaligned. Neither can be recovered from without
      // guessing what the device put in its replies, so the session ends —
      // the same rule open() and subscribe() apply to their own failures
      // (spec v0.5 §5.2). The caller still receives the original error.
      if (err instanceof ZkTimeoutError || err instanceof ZkFramingError) {
        await this.abandon()
      } else if (err instanceof ZkConnectionError) {
        // The transport is already gone; no goodbye can reach anyone. Clear
        // open_ so the next call is refused by assertOpen, naming this
        // session, rather than by whatever the dead socket says.
        this.open_ = false
      }
      throw err
    } finally {
      this.inFlight = false
    }
  }
```

Add `ZkFramingError` and `ZkTimeoutError` to the errors import in `Session.ts`.

Make `abandon` idempotent (Task 11 merges `close` into it):

```ts
  private async abandon(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    this.subscribed_ = false
    await this.transmit(CMD.EXIT).catch(() => {})
    await this.transport.close().catch(() => {})
  }
```

- [ ] **Step 4: Run the session, command, realtime and scenario suites**

Run: `npx vitest run test/session test/commands test/realtime test/scenarios.spec.ts test/diagnostics`
Expected: PASS. Watch `test/session/dataRead.legacy.spec.ts` "rejects rather than returning when FREE_DATA never answers, and leaves the session usable afterwards": it asserts the session is **usable** after a FREE_DATA timeout. Under §5.2 that is no longer true — the session is closed. Rewrite its second half:

```ts
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toBeInstanceOf(ZkTimeoutError)
      // v0.5: a timeout ends the session (spec §5.2), because FREE_DATA's late
      // reply would otherwise be collected by the next request. The next call
      // is refused by the session, not answered off a stale queue.
      const next = await session.execute(CMD.GET_FREE_SIZES).then(() => null, (e: unknown) => e as Error)
      expect(next).toBeInstanceOf(ZkConnectionError)
      expect(next!.message).toMatch(/this session is not open/)
      session = null
```

and rename it `'rejects rather than returning when FREE_DATA never answers, and closes the session'`.

- [ ] **Step 5: Commit**

```bash
git add src/session/Session.ts test/session
git commit -m "fix(session): a timeout or framing failure ends the session; a dropped connection closes it"
```

---

### Task 10: `subscribe()` guards itself (spec §5.3)

**Files:**
- Modify: `src/session/Session.ts` (`subscribe`)
- Test: `test/session/subscribe.spec.ts`

- [ ] **Step 1: Write the failing tests**

Inside `describe(\`Session.subscribe over ${kind}\`)` in `test/session/subscribe.spec.ts` (import `ZkAuthError`):

```ts
    it('refuses a second subscribe() before sending a second registration', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})
      const err = await session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {}).then(() => null, (e: unknown) => e as Error)
      expect(err).toBeInstanceOf(ZkConnectionError)
      expect(err!.message).toMatch(/already subscribed/)
      expect(running.received.filter((p) => p.command === CMD.REG_EVENT)).toHaveLength(1)
    })

    it('throws ZkAuthError when the registration answers ACK_UNAUTH', async () => {
      running = await startEmulator({
        transport: kind,
        handlers: { [CMD.REG_EVENT]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await expect(session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})).rejects.toBeInstanceOf(ZkAuthError)
      expect(session.subscribed).toBe(false)
    })

    it('refuses subscribe() on a session that is not open', async () => {
      running = await startEmulator({ transport: kind })
      session = new Session(make(running.port), { timeoutMs: 2000 })
      await session.open()
      await session.close()
      await expect(session.subscribe(EVENT_FLAG.ATTENDANCE, () => {}, () => {})).rejects.toThrow(/this session is not open/)
      session = null
    })
```

- [ ] **Step 2: Run to see the failures**

Run: `npx vitest run test/session/subscribe.spec.ts`
Expected: the second-subscribe test FAILS with **two** REG_EVENT packets received; the ACK_UNAUTH test FAILS with a `ZkProtocolError` ("refused a realtime subscription"); the not-open test FAILS because the registration is transmitted on a closed transport and the error is a `ZkConnectionError` from the transport, not the session's message.

- [ ] **Step 3: Add the guards**

At the top of `subscribe` in `src/session/Session.ts`:

```ts
    this.assertOpen()
    if (this.subscribed_) {
      throw new ZkConnectionError(
        'this session is already subscribed to realtime events; close it and reconnect to subscribe again',
      )
    }
    const res = await this.send(CMD.REG_EVENT, encodeEventMask(mask))
    if (isEventPacket(res)) { /* unchanged */ }
    if (res.command === CMD.ACK_UNAUTH) {
      throw new ZkAuthError(
        'CMD_REG_EVENT answered ACK_UNAUTH: the device did not authorize a realtime subscription',
        res.data,
      )
    }
    if (res.command !== CMD.ACK_OK) { /* unchanged */ }
```

Add to the docblock: "Guarded before anything is sent: a second subscribe() used to transmit a second REG_EVENT whose acknowledgment then arrived on the listening socket and ended the live stream as 'a non-event packet', blaming the device."

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/session test/realtime`
Expected: PASS.

```bash
git add src/session/Session.ts test/session/subscribe.spec.ts
git commit -m "fix(session): subscribe() refuses before sending, and ACK_UNAUTH is an auth error"
```

---

### Task 11: `close()` delegates to `abandon()` (spec §5.4)

**Files:**
- Modify: `src/session/Session.ts` (`close`, `abandon` docblock)
- Test: existing `test/session/*.spec.ts`, `test/realtime/*.spec.ts`

- [ ] **Step 1: Rewrite `close()`**

```ts
  /**
   * Ends the session. Never throws: a goodbye is best effort, and a device
   * that has already gone away needs none.
   *
   * A subscribed session cannot read a reply — the socket is listening — so
   * it goes through abandon(), which sends EXIT without awaiting one. On UDP
   * that goodbye is the only thing telling the device to release the session
   * slot, which is why it is sent at all. A goodbye that times out runs the
   * §5.2 teardown from inside send(); abandon() and the transport close that
   * follows are both idempotent, so the sequence ends the same way.
   */
  async close(): Promise<void> {
    if (!this.open_) return
    if (this.subscribed_) return this.abandon()
    this.open_ = false
    try {
      await this.send(CMD.EXIT)
    } catch {
      // A device that has already gone away needs no goodbye.
    }
    await this.transport.close().catch(() => {})
  }
```

Fold the sentence "The socket is listening, so a reply could never be read — the goodbye is sent without awaiting one" into `abandon`'s docblock, which already says the rest.

- [ ] **Step 2: Run the suites that close sessions, then commit**

Run: `npx vitest run test/session test/realtime test/scenarios.spec.ts`
Expected: PASS — this task changes structure, not behaviour; these suites are the proof.

```bash
git add src/session/Session.ts
git commit -m "refactor(session): close() and abandon() are one goodbye sequence with one error policy"
```

---

## Phase C — Bulk reads

### Task 12: `readTransfer`, with the overshoot check both paths share (spec §6.1 point 3, §6.3)

**Files:**
- Modify: `src/session/dataRead.ts` (`readBulkLegacy`, new `readTransfer`)
- Modify: `test/emulator/index.ts` (`legacyOvershootBytes` knob, `serveDataLegacy`)
- Test: `test/session/dataRead.legacy.spec.ts`

**Interfaces:**
- Produces: `readTransfer(session: Session, expected: number, first?: DecodedPacket): Promise<Buffer>` exported from `dataRead.ts`. Contract per spec §6.1 point 3: an optional leading `PREPARE_DATA` is consumed and ignored; `DATA` until `expected`; then `ACK_OK`; early `ACK_OK`, overshoot, or any other command is `ZkProtocolError`. Task 13 calls it per chunk.

- [ ] **Step 1: Write the failing test**

In `test/session/dataRead.legacy.spec.ts`, inside the `describe(\`readBulkLegacy over ${transportKind}\`)`:

```ts
    it('throws when the transfer delivers more bytes than PREPARE_DATA declared', async () => {
      // Declared 404, served 432. The loop used to exit cleanly on >= and the
      // record parser, whose only length guard is "too short", dropped the
      // tail silently (review S4).
      const rows = Array.from({ length: 50 }, (_, i) => rec8(i + 1))
      running = await startEmulator({
        transport: transportKind,
        records: { size: 8, rows },
        chunkSize: 32,
        legacyOvershootBytes: 28,
      })
      session = await openSession(running.port)
      await expect(readBulkLegacy(session, CMD.ATTLOG_RRQ)).rejects.toThrow(/delivered 432 bytes, expected 404/)
    })
```

Add the knob to `test/emulator/index.ts`. In `EmulatorOptions`:

```ts
  /** Extra zero bytes sent as one more DATA packet before the legacy ACK_OK. Spec v0.5 §6.3. */
  legacyOvershootBytes?: number
```

In `serveDataLegacy`, before `out.push(reply(state, req, CMD.ACK_OK))`:

```ts
  const overshoot = state.opts.legacyOvershootBytes ?? 0
  if (overshoot > 0) out.push(reply(state, req, CMD.DATA, Buffer.alloc(overshoot)))
```

- [ ] **Step 2: Run to see it fail for the intended reason**

Run: `npx vitest run test/session/dataRead.legacy.spec.ts -t "more bytes than PREPARE_DATA declared"`
Expected: FAIL because the read **resolves** with 432 bytes.

- [ ] **Step 3: Extract `readTransfer` and use it from the legacy path**

In `src/session/dataRead.ts`, add (above `readBulkLegacy`) and import `DecodedPacket` as a type from `../codec/packet.js`:

```ts
/**
 * Reads one transfer: an optional CMD_PREPARE_DATA announcement, CMD_DATA
 * packets until `expected` bytes have arrived, then ACK_OK.
 *
 * Shared by the legacy exchange (one transfer per read) and, since v0.5, by
 * the buffered exchange (one transfer per READ_BUFFER chunk), because that is
 * the shape the readable reference handles: zkteco-js's UDP chunk handler
 * ignores PREPARE_DATA, appends DATA, and completes on ACK_OK once the total
 * matches the size IT computed (zudp.js:335-350); its TCP handler is
 * command-agnostic and skips the first eight accumulated bytes, which is the
 * announcement arriving through the same accumulator (ztcp.js:389-395).
 * Nothing in the announcement is interpreted here either — `expected` comes
 * from the caller, who knows it from its own request.
 *
 * `first` is a packet the caller already consumed (an execute() reply); it is
 * treated as the first packet of the transfer.
 *
 * Refuses, as ZkProtocolError: an ACK_OK before `expected` bytes (where the
 * reference would sit until its timer fired, this says so at once), a total
 * past `expected` (the record parsers only reject a body that is too SHORT,
 * so an oversized one would lose its tail silently), and any other command.
 */
export async function readTransfer(
  session: Session,
  expected: number,
  first?: DecodedPacket,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  let pending: DecodedPacket | null = first ?? null
  const next = async (): Promise<DecodedPacket> => {
    if (pending) {
      const p = pending
      pending = null
      return p
    }
    return session.receiveMore()
  }

  const opening = await next()
  // No announcement: the packet belongs to the loop below.
  if (opening.command !== CMD.PREPARE_DATA) pending = opening

  // Strictly sequential: the session allows one exchange at a time.
  while (received < expected) {
    const packet = await next()
    if (packet.command !== CMD.DATA) {
      throw new ZkProtocolError(
        `transfer ended after ${received} of ${expected} bytes with command ${packet.command}`,
      )
    }
    chunks.push(packet.data)
    received += packet.data.length
  }
  if (received > expected) {
    throw new ZkProtocolError(`transfer delivered ${received} bytes, expected ${expected}`)
  }

  const tail = await next()
  if (tail.command !== CMD.ACK_OK) {
    throw new ZkProtocolError(`expected ACK_OK to close the transfer, got ${tail.command}`)
  }
  return Buffer.concat(chunks)
}
```

Replace the body of `readBulkLegacy` from `const declared = …` to the end with:

```ts
  const declared = res.data.readUInt32LE(0)
  const body = await readTransfer(session, declared)
  await freeBuffer(session)
  return body
```

and delete the now-unused loop. Keep its docblock; add: "The size in a legacy PREPARE_DATA is read at offset 0, as it always was; no reference exists to compare against (spec §6.4)."

- [ ] **Step 4: Run the bulk-read suites**

Run: `npx vitest run test/session test/commands`
Expected: PASS, including the existing "reassembles a body delivered as several CMD_DATA chunks" and "rejects when the device disconnects mid-transfer".

- [ ] **Step 5: Commit**

```bash
git add src/session/dataRead.ts test/session/dataRead.legacy.spec.ts test/emulator/index.ts
git commit -m "fix(session): one readTransfer for both bulk paths, and it refuses an overshoot"
```

---

### Task 13: The buffered path follows the reference (spec §6.1 points 1, 2, 4; §11)

**Files:**
- Modify: `src/codec/commands.ts` (add `BUFFER_FCT`), `src/session/dataRead.ts` (`readBulkBuffered`)
- Modify: `test/emulator/index.ts` (`EmulatorState.lastPrepareFct`, `prepareBufferReply`, `chunkReply`, `prepareBufferInline`, the two buffered handlers)
- Test: `test/session/dataRead.buffered.spec.ts`, `test/commands/users.spec.ts`

**Interfaces:**
- Produces: `BUFFER_FCT: Readonly<Record<number, number>>` in `commands.ts`; `readBulkBuffered(session, command, maxChunk): Promise<Buffer | null>` where `null` means "the device answered PREPARE_BUFFER with ACK_ERROR" — consumed by Task 14's `readBulk`. Emulator options `prepareBufferReply: 'size-at-1' | 'size-at-0'` (default `'size-at-1'`), `chunkReply: 'transfer' | 'single-packet'` (default `'transfer'`), `prepareBufferInline?: boolean`; state field `lastPrepareFct: number | null`.

- [ ] **Step 1: Move the emulator to the reference model and write the failing tests**

`test/emulator/index.ts`. In `EmulatorOptions`:

```ts
  /**
   * Where the PREPARE_BUFFER reply carries its size. 'size-at-1' is the
   * reference's layout (zkteco-js reads `readUIntLE(1, 4)`), five bytes with
   * byte 0 written as 0x00 — its meaning is not recorded anywhere readable.
   * 'size-at-0' is the four-byte layout this library believed before v0.5,
   * kept for experiment E2 (spec v0.5 §12) and deletable after it.
   */
  prepareBufferReply?: 'size-at-1' | 'size-at-0'
  /**
   * How each READ_BUFFER request is answered. 'transfer' is the reference's
   * shape: PREPARE_DATA, DATA packets, ACK_OK (spec v0.5 §6.1 point 3).
   * 'single-packet' is one ACK_DATA carrying the chunk, the v0.4 model, kept
   * for experiment E3 and deletable after it.
   */
  chunkReply?: 'transfer' | 'single-packet'
  /** Answers PREPARE_BUFFER with the whole body inline as CMD_DATA (§6.1 point 2). */
  prepareBufferInline?: boolean
```

In `EmulatorState` add `/** The fct field of the last PREPARE_BUFFER request, so a test can pin it. */ lastPrepareFct: number | null` and initialise it to `null` in `buildState`.

Replace `bufferedHandlers`:

```ts
const bufferedHandlers: HandlerTable = {
  [CMD.PREPARE_BUFFER]: (req, state) => {
    if (!state.supportsBuffer) return [reply(state, req, CMD.ACK_ERROR)]
    // Request body: <int8 1><int16 command><int32 fct><int32 ext>
    const command = req.data.readUInt16LE(1)
    state.lastPrepareFct = req.data.readUInt32LE(3)
    state.pendingBuffer = bufferedStream(state, command)
    if (state.opts.prepareBufferInline) return [reply(state, req, CMD.DATA, state.pendingBuffer)]
    const layout = state.opts.prepareBufferReply ?? 'size-at-1'
    const size = Buffer.alloc(layout === 'size-at-1' ? 5 : 4)
    size.writeUInt32LE(state.pendingBuffer.length, layout === 'size-at-1' ? 1 : 0)
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
    // bufferChunkOverride overrides the DATA total of this chunk: fewer
    // bytes than asked, or more, to exercise both refusals in readTransfer.
    const override = state.opts.bufferChunkOverride
    const take = override && state.chunksSent === override.atCall ? override.bytes : want
    let slice = state.pendingBuffer.subarray(offset, offset + take)
    if (slice.length < take) slice = Buffer.concat([slice, Buffer.alloc(take - slice.length)])
    if ((state.opts.chunkReply ?? 'transfer') === 'single-packet') {
      return [reply(state, req, CMD.ACK_DATA, slice)]
    }
    // The reference's shape: an announcement (8 bytes, size at 0, rest
    // zero), DATA pieces, ACK_OK. `chunkSize` sizes the pieces, as it does
    // for the legacy transfer.
    const announce = Buffer.alloc(8)
    announce.writeUInt32LE(slice.length, 0)
    const out = [reply(state, req, CMD.PREPARE_DATA, announce)]
    const piece = state.opts.chunkSize ?? 1024
    for (let off = 0; off < slice.length; off += piece) {
      out.push(reply(state, req, CMD.DATA, slice.subarray(off, off + piece)))
    }
    out.push(reply(state, req, CMD.ACK_OK))
    return out
  },
}
```

In `test/session/dataRead.buffered.spec.ts`, rewrite the `buffered bulk read` block's tests as follows (the direct `readBulkBuffered` calls now return `Buffer | null`, so each result is narrowed with `!` after a not-null assertion):

```ts
  describe(`buffered bulk read over ${transportKind}`, () => {
    it('reads a body through PREPARE_BUFFER and READ_BUFFER', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1), rec8(2), rec8(3)] } })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream).not.toBeNull()
      expect(stream!.readUInt32LE(0)).toBe(24)
      expect(stream!.length).toBe(28)
    })

    it('reads the total from offset 1 of the PREPARE_BUFFER reply, as the reference does', async () => {
      // 'size-at-0' is the layout this library believed before v0.5. Under it
      // the total read at offset 1 is garbage, so the read must fail loudly.
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, prepareBufferReply: 'size-at-0' })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).rejects.toThrow(ZkProtocolError)
    })

    it('accepts an inline CMD_DATA answer to PREPARE_BUFFER as the whole body', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1), rec8(2)] }, prepareBufferInline: true })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(stream!.readUInt32LE(0)).toBe(16)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.READ_BUFFER)
    })

    it('requests successive offsets when the body exceeds one chunk', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows }, chunkSize: 16 })
      session = await openSession(running.port)
      const stream = await readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)
      expect(stream!.length).toBe(804)
      const reads = running.received.filter((p) => p.command === CMD.READ_BUFFER)
      expect(reads.length).toBe(13) // ceil(804 / 64)
      expect(reads[1]!.data.readUInt32LE(0)).toBe(64)
    })

    it('refuses a chunk that ends before the requested size', async () => {
      // 32 bytes served for 64 asked. The reference would wait for its timer;
      // this library says so at once (spec v0.5 §6.1 point 3).
      const rows = Array.from({ length: 100 }, (_, i) => rec8(i + 1))
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows }, bufferChunkOverride: { atCall: 1, bytes: 32 } })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, 64)).rejects.toThrow(/ended after 32 of 64/)
    })

    it('refuses a chunk that delivers more than the requested size', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, bufferChunkOverride: { atCall: 1, bytes: 40 } })
      session = await openSession(running.port)
      await expect(readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).rejects.toThrow(/delivered 40 bytes, expected 12/)
    })

    it('sends the reference request shape: fct 0 for attendance, 5 for users', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, users: [] })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      const prepare = running.received.find((p) => p.command === CMD.PREPARE_BUFFER)!
      expect(prepare.data.length).toBe(11)
      expect(prepare.data.readUInt8(0)).toBe(1)
      expect(prepare.data.readUInt16LE(1)).toBe(CMD.ATTLOG_RRQ)
      expect(running.state.lastPrepareFct).toBe(0)
      await readBulkBuffered(session, CMD.USERTEMP_RRQ, MAX_CHUNK[transportKind])
      expect(running.state.lastPrepareFct).toBe(5)
      // And the buffered path was what served both: no legacy command went out.
      expect(running.received.map((p) => p.command)).not.toContain(CMD.USERTEMP_RRQ)
    })

    it('returns null when the device refuses PREPARE_BUFFER', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] }, supportsBuffer: false })
      session = await openSession(running.port)
      expect(await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])).toBeNull()
    })

    it('releases the device buffer afterwards', async () => {
      running = await startEmulator({ transport: transportKind, records: { size: 8, rows: [rec8(1)] } })
      session = await openSession(running.port)
      await readBulkBuffered(session, CMD.ATTLOG_RRQ, MAX_CHUNK[transportKind])
      expect(running.received.map((p) => p.command)).toContain(CMD.FREE_DATA)
    })
  })
```

Delete the old "advances the next offset by what actually arrived" and "throws when a chunk delivers more bytes than the declared total" tests (replaced above) and the old "sends the documented PREPARE_BUFFER request shape" test.

- [ ] **Step 2: Run to see the failures for the intended reasons**

Run: `npx vitest run test/session/dataRead.buffered.spec.ts`
Expected: "reads a body" FAILS with a ZkProtocolError about the size or a wrong total (the library reads offset 0 of a five-byte reply); the fct test FAILS on `lastPrepareFct` being 0 for users; "returns null" FAILS with a ZkProtocolError thrown instead. Every failure is about the layout, not about the emulator crashing — if the emulator throws, fix the handler first.

- [ ] **Step 3: Add `BUFFER_FCT` and rewrite `readBulkBuffered`**

`src/codec/commands.ts`, after `MAX_CHUNK`:

```ts
/**
 * The `fct` field of the 11-byte PREPARE_BUFFER request, per command.
 *
 * Restated from zkteco-js `helper/command.js:109-110` (MIT): GET_USERS sends
 * `01 09 00 05 00 00 00 …` (command 9, fct 5) and GET_ATTENDANCE_LOGS sends
 * `01 0d 00 00 00 00 00 …` (command 13, fct 0). Before v0.5 this library sent
 * 0 for both. What fct means is not recorded anywhere readable; only the
 * values are. A command absent here sends 0.
 */
export const BUFFER_FCT: Readonly<Record<number, number>> = {
  [CMD.USERTEMP_RRQ]: 5,
  [CMD.ATTLOG_RRQ]: 0,
}
```

`src/session/dataRead.ts`, replace `readBulkBuffered` (import `BUFFER_FCT` from `../codec/commands.js` and `ZkAuthError` is already imported):

```ts
/**
 * Reads a bulk payload through the buffered commands, the way the readable
 * reference does (spec v0.5 §6.1; zkteco-js ztcp.js:320-462, zudp.js:283-360).
 *
 * _CMD_PREPARE_BUFFER (1503) and _CMD_READ_BUFFER (1504) are undocumented by
 * the vendor. Until v0.5 this library's model of them agreed with nothing but
 * its own emulator. Four points now follow the reference:
 *   1. the request's fct is per command (BUFFER_FCT);
 *   2. a CMD_DATA reply to PREPARE_BUFFER is the whole body; otherwise the
 *      total is the uint32 at data offset 1 (byte 0 is not interpreted);
 *   3. each READ_BUFFER is answered by a transfer — see readTransfer;
 *   4. no command is required beyond what the reference's UDP handler checks.
 *
 * Returns null when the device answers PREPARE_BUFFER with ACK_ERROR — the
 * one signal that this firmware does not implement 1503 — so readBulk can
 * fall back on exactly that and on nothing else. ACK_UNAUTH throws
 * ZkAuthError here for the reason Session.execute's docblock gives: this is
 * the one tryExecute caller that must not inherit the fallback.
 */
export async function readBulkBuffered(
  session: Session,
  command: number,
  maxChunk: number,
): Promise<Buffer | null> {
  // <int8 1><int16 command><int32 fct><int32 ext>
  const request = Buffer.alloc(11)
  request.writeUInt8(1, 0)
  request.writeUInt16LE(command, 1)
  request.writeUInt32LE(BUFFER_FCT[command] ?? 0, 3)
  request.writeUInt32LE(0, 7)

  const prepared = await session.tryExecute(CMD.PREPARE_BUFFER, request)
  if (prepared.command === CMD.ACK_ERROR) return null
  if (prepared.command === CMD.ACK_UNAUTH) {
    throw new ZkAuthError(
      `command ${CMD.PREPARE_BUFFER} answered ACK_UNAUTH: the device did not authorize this request`,
      prepared.data,
    )
  }
  if (prepared.command === CMD.DATA) {
    await freeBuffer(session)
    return prepared.data
  }
  if (prepared.data.length < 5) {
    throw new ZkProtocolError('PREPARE_BUFFER did not report a size', prepared.data)
  }
  const total = prepared.data.readUInt32LE(1)

  const chunks: Buffer[] = []
  let offset = 0
  while (offset < total) {
    const want = Math.min(maxChunk, total - offset)
    const req = Buffer.alloc(8)
    req.writeUInt32LE(offset, 0)
    req.writeUInt32LE(want, 4)
    const opening = await session.execute(CMD.READ_BUFFER, req)
    const chunk = await readTransfer(session, want, opening)
    chunks.push(chunk)
    offset += chunk.length
  }

  await freeBuffer(session)
  return Buffer.concat(chunks)
}
```

Note the message for ACK_UNAUTH keeps the phrase `answered ACK_UNAUTH`, which `test/commands/users.spec.ts` matches.

- [ ] **Step 4: Fix the one call site that used the old return type**

`readBulk` (still the old version until Task 14) calls `readBulkBuffered` and returns its result; add a temporary narrowing so it typechecks: in `readBulk`'s `try`, `const body = await readBulkBuffered(...); if (body === null) throw new ZkProtocolError('device rejected command 1503'); return body`. Task 14 replaces this.

- [ ] **Step 5: Run the buffered, users and diagnostics suites**

Run: `pnpm typecheck && npx vitest run test/session test/commands test/diagnostics test/scenarios.spec.ts`
Expected: PASS. `test/diagnostics/probe.bulk.spec.ts` reads users through the emulator's buffered path and must stay green on the new model.

- [ ] **Step 6: Commit**

```bash
git add src/codec/commands.ts src/session/dataRead.ts test/emulator/index.ts test/session/dataRead.buffered.spec.ts
git commit -m "fix(session): the buffered read follows zkteco-js at four points, and the emulator does too"
```

---

### Task 14: Fall back on `ACK_ERROR` only (spec §6.2)

**Files:**
- Modify: `src/session/dataRead.ts` (`readBulk`), `CLAUDE.md:72-74`
- Test: `test/session/dataRead.buffered.spec.ts` (`readBulk dispatch` block)

- [ ] **Step 1: Write the failing test**

In the `readBulk dispatch` describe:

```ts
    it.skipIf(transportKind !== 'tcp')('does not fall back when the buffered read fails for any reason but a refusal', async () => {
      // A framing failure during the buffered read used to be caught as a
      // ZkProtocolError and retried down the legacy path on a broken stream
      // (review R2). Only an ACK_ERROR to PREPARE_BUFFER is a refusal.
      running = await startEmulator({
        transport: 'tcp',
        records: { size: 8, rows: [rec8(1)] },
        handlers: { [CMD.PREPARE_BUFFER]: () => null },
      })
      session = await openSession(running.port)
      const pending = readBulk(session, CMD.ATTLOG_RRQ, 'tcp')
      await new Promise((r) => setTimeout(r, 50))
      for (const socket of running.sockets) socket.write(Buffer.from('deadbeefdeadbeef', 'hex'))
      await expect(pending).rejects.toBeInstanceOf(ZkFramingError)
      expect(running.received.map((p) => p.command)).not.toContain(CMD.ATTLOG_RRQ)
      session = null
    })
```

Import `ZkFramingError`.

- [ ] **Step 2: Run to see it fail for the intended reason**

Run: `npx vitest run test/session/dataRead.buffered.spec.ts -t "does not fall back"`
Expected: with the Task 13 temporary code in place, the framing failure propagates already (it is a `ZkFramingError`, not a `ZkProtocolError`), so this test may PASS. To see the red the table names, temporarily change the catch in `readBulk` to `if (!(err instanceof ZkError)) throw err` and rerun: FAIL because `ATTLOG_RRQ` **is** in `received` — the legacy read ran. Revert that mutation.

- [ ] **Step 3: Rewrite `readBulk`**

```ts
/**
 * Reads a bulk payload, preferring the buffered commands and falling back to
 * the legacy exchange when — and only when — the device answers
 * PREPARE_BUFFER with ACK_ERROR. Older firmware does not implement 1503/1504
 * at all, and that refusal is the one signal of it.
 *
 * Everything else propagates: a framing failure (the stream is misaligned;
 * the session has already ended), a malformed size reply, a chunk that stops
 * short or overshoots, a timeout, a dropped connection, and ACK_UNAUTH (the
 * device said this session is not authorized, and whatever the legacy path
 * returned after that could not be trusted whether or not it looked
 * complete). Until v0.5 the fallback fired on any ZkProtocolError from six
 * throw sites plus the unframer, which is how a misaligned TCP stream was
 * retried down the legacy path and reported as a firmware capability.
 *
 * Firmware answering an unknown 1503 with silence never reaches the fallback
 * — accepted, as before, and worth revisiting once a real device has been
 * observed.
 */
export async function readBulk(
  session: Session,
  command: number,
  transport: 'tcp' | 'udp',
): Promise<Buffer> {
  const buffered = await readBulkBuffered(session, command, MAX_CHUNK[transport])
  if (buffered !== null) return buffered
  return readBulkLegacy(session, command)
}
```

The `freeBuffer` call that used to precede the fallback goes: a refused PREPARE_BUFFER left no device-side buffer to release.

`CLAUDE.md` lines 72-74: change "and falls back to the legacy exchange on exactly `ZkProtocolError`" to "and falls back to the legacy exchange only when the device answers PREPARE_BUFFER with `ACK_ERROR`; every other failure propagates".

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/session test/commands test/diagnostics`
Expected: PASS.

```bash
git add src/session/dataRead.ts test/session/dataRead.buffered.spec.ts CLAUDE.md
git commit -m "fix(session): readBulk falls back on a refusal and on nothing else"
```

---

## Phase D — Records and identity

### Task 15: The printed user id is nine bytes (spec §7.1)

**Files:**
- Modify: `src/codec/records/user.ts:24`, `src/types.ts:62-63`, `tools/emulator-serve.ts:25`
- Modify: `PROVENANCE.md` (new section)
- Test: `test/codec/records/user.spec.ts`, `test/commands/attendance.spec.ts`

- [ ] **Step 1: Write the failing tests**

`test/codec/records/user.spec.ts`: change the helper's `b.write(userId, 48, 8, 'ascii')` to `b.write(userId, 48, 9, 'ascii')` and add:

```ts
  it('reads a nine-character printed id in full', () => {
    // zkteco-js reads slice(48, 48 + 9) (helper/utils.js:143-144). An eight-byte
    // read returned '12345678' — a different identity that then keyed the
    // attendance lookup (review R4).
    expect(parseUserData(withHeader(userRec(7, '123456789', 'Nine')))[0]!.userId).toBe('123456789')
  })
```

`test/commands/attendance.spec.ts`: change its `emUser` helper to write 9 bytes (`b.write(userId, 48, 9, 'ascii')`) and add inside the transport loop:

```ts
    it('attributes a punch to a nine-character id without truncating it', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '123456789', 'Nine')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: '123456789', userIdSource: 'lookup' })
    })
```

- [ ] **Step 2: Run to see both fail on `'12345678'`**

Run: `npx vitest run test/codec/records/user.spec.ts test/commands/attendance.spec.ts -t "nine"`
Expected: FAIL, received `'12345678'`.

- [ ] **Step 3: Widen the read and record it**

`src/codec/records/user.ts:24`: `userId: readNulTerminated(rec, 48, 9),` with a comment above it:

```ts
    // Nine bytes, per zkteco-js helper/utils.js:143-144 (`slice(48, 48 + 9)`).
    // Eight, before v0.5, truncated a nine-digit id into a different identity.
    // PROVENANCE.md §User record width and size.
```

`src/types.ts:62-63`: `/** The identifier printed on the device, up to nine characters. A string, so leading zeros survive. */`

`tools/emulator-serve.ts:25`: `b.write(userId, 48, 9, 'latin1')`.

`PROVENANCE.md`: add before `## Inbound checksums are not validated`:

```markdown
## User record width and size

**The printed user id in the 72-byte user record is nine bytes at offset 48.**
Source reading, not hardware: `zkteco-js` `helper/utils.js:143-144` reads
`slice(48, 48 + 9)`. This library read eight until v0.5, which returned a
nine-digit id truncated — a different identity — and then keyed the attendance
lookup with it. Byte 57 is interpreted by neither implementation, so the wider
read consumes no other field. A device that stores eight leaves byte 57 NUL and
the returned string is unchanged.

**The reference decodes 28-byte user records over UDP and 72-byte records over
TCP** (`ztcp.js:471`, `zudp.js:382`, `helper/utils.js:114-126`). Whether that
is a property of the transport, of firmware age, or of the reference's own
history is not recorded anywhere readable. This library reads 72 on both
transports and refuses a body that is not a whole number of 72-byte records,
so a 28-byte device is refused rather than misparsed. Experiment E4 (below,
under *Black-box experiments against the buffered read*) asks `pyzk` which
size it expects on each transport. No second decoder exists; adding one would
be a new hypothesis.
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/codec test/commands test/diagnostics`
Expected: PASS.

```bash
git add src/codec/records/user.ts src/types.ts tools/emulator-serve.ts PROVENANCE.md test
git commit -m "fix(codec): the printed user id is nine bytes, as the readable reference reads it"
```

---

### Task 16: The record count is read twice (spec §7.2)

**Files:**
- Modify: `src/commands/attendance.ts:60-66`, `src/codec/records/attendance.ts:49-56`, `src/ZkDevice.ts:151-159`
- Modify: `PROVENANCE.md` §Unverified field offsets
- Test: `test/commands/attendance.spec.ts`

- [ ] **Step 1: Write the failing tests, both directions**

Inside the transport loop of `test/commands/attendance.spec.ts`:

```ts
    it('refuses the read when the record count moved during it', async () => {
      // One record counted, two on the wire: 16 bytes over a count of 1 is
      // "one 16-byte record", a misaligned parse with no error (review R3).
      // The second count read catches it.
      let counts = 0
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 1, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, DAY), rec8(2, DAY)] },
        handlers: {
          [CMD.GET_FREE_SIZES]: (req, state) => {
            counts += 1
            const info = { ...state.info, recordCount: counts === 1 ? 1 : 2 }
            return [reply(state, req, CMD.ACK_OK, encodeFreeSizes(info))]
          },
        },
      })
      session = await openSession(running.port)
      await expect(getAttendanceLogs(session, transportKind)).rejects.toThrow(/buffer changed during the read: 1 record\(s\) before, 2 after/)
    })

    it('parses when the record count is unchanged by the read, reading it twice', async () => {
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 0, recordCount: 2, recordCapacity: 1000 },
        records: { size: 8, rows: [rec8(1, DAY), rec8(2, DAY)] },
      })
      session = await openSession(running.port)
      const logs = await getAttendanceLogs(session, transportKind, { resolveUserIds: false })
      expect(logs.map((l) => l.uid)).toEqual([1, 2])
      expect(running.received.filter((p) => p.command === CMD.GET_FREE_SIZES)).toHaveLength(2)
    })
```

- [ ] **Step 2: Run to see the failures for the intended reasons**

Run: `npx vitest run test/commands/attendance.spec.ts -t "record count"`
Expected: the first FAILS because the read **resolves** with one 16-byte record (`recordSize: 16`); the second FAILS on the count of `GET_FREE_SIZES` packets (1, not 2).

- [ ] **Step 3: Bracket the read and rewrite the two docblocks**

`src/commands/attendance.ts`, replace lines 60-66 (import `ZkFramingError` from `../errors.js`):

```ts
  // The record count is needed before anything else: the framing guard divides
  // by it, and a freshly installed device must not be sent a read at all.
  const { recordCount } = await getInfo(session)
  if (recordCount === 0) return []

  const stream = await readBulk(session, CMD.ATTLOG_RRQ, transport)

  // Read again. The record-size division cannot detect a count that is stale
  // by a divisor — 16 bytes over a count of 1 is one 16-byte record, not two
  // 8-byte ones — so a punch landing between the first count and the read
  // would be parsed misaligned with no error. A count that did not move
  // across the read is the evidence that no such punch landed; a count that
  // did costs this poll, and the next poll recovers. Disabling the device
  // around the read, which is how other implementations avoid this, is a
  // write path and locks employees out (spec v0.5 §7.2).
  const after = await getInfo(session)
  if (after.recordCount !== recordCount) {
    throw new ZkFramingError(
      `the attendance buffer changed during the read: ${recordCount} record(s) before, ${after.recordCount} after`,
    )
  }
  const records = parseAttendanceData(stream, recordCount)
```

`src/codec/records/attendance.ts:49-56`, replace the docblock on `detectRecordSize`:

```ts
/**
 * Derives the record size by division.
 *
 * What this refuses: a body that is not a whole number of records, and a
 * quotient that is not a known size. What it CANNOT refuse: a count that is
 * wrong by a divisor of the true size — the known sizes are multiples of one
 * another, so 16 bytes over a count of 1 is "one 16-byte record" whether or
 * not it is really two 8-byte ones. That case is caught one layer up, where
 * getAttendanceLogs reads the count again after the transfer and refuses if
 * it moved. Do not describe this function as refusing a stale count; until
 * v0.5 its docblock did, and the claim was false.
 */
```

`src/ZkDevice.ts:151-159`, rewrite the `getAttendanceLogs` docblock's last sentence: "The interleaved-write risk is met by reading the record count on both sides of the transfer and refusing if it moved; the framing guard on its own cannot see a count that is stale by a divisor."

`PROVENANCE.md` §Unverified field offsets: replace "A wrong `recordCount` silently poisons the framing guard … instead of raising anything." with: "A wrong `recordCount` silently poisons the framing guard described in the design spec §5.3: the record-size division still "succeeds" on a count that is off by a divisor of the true size. Since v0.5 `getAttendanceLogs` reads the count on both sides of the transfer and refuses if it moved, which catches a count that changed during the read but not one that was wrong to begin with — a wrong OFFSET returns a wrong count twice, consistently."

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/commands test/scenarios.spec.ts test/diagnostics`
Expected: PASS. `test/diagnostics/probe.bulk.spec.ts` and `test/scenarios.spec.ts` count GET_FREE_SIZES sends in places; if one pins a count of 1 around an attendance read, update it to 2 with a comment citing spec v0.5 §7.2.

```bash
git add src/commands/attendance.ts src/codec/records/attendance.ts src/ZkDevice.ts PROVENANCE.md test
git commit -m "fix(commands): read the record count on both sides of the transfer, and say what the guard can see"
```

---

### Task 17: The lookup never fabricates (spec §7.3)

**Files:**
- Modify: `src/commands/attendance.ts` (`resolve`, the map build, the option doc)
- Test: `test/commands/attendance.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
    it('returns null when two enrolled ids collide numerically', async () => {
      // '1' and '01' both become 1. Last-writer-wins picked one and labelled
      // it 'lookup' (review R13).
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 2, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(1, '1', 'One'), emUser(2, '01', 'Zero-one')],
        records: { size: 16, rows: [rec16(1, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null })
    })

    it('returns null when the matched user has a blank printed id', async () => {
      // The 40-byte path maps '' to null (records/attendance.ts). The lookup
      // path handed '' back with source 'lookup'.
      running = await startEmulator({
        transport: transportKind,
        info: { userCount: 1, recordCount: 1, recordCapacity: 1000 },
        users: [emUser(9, '', 'Blank')],
        records: { size: 8, rows: [rec8(9, DAY)] },
      })
      session = await openSession(running.port)
      const [log] = await getAttendanceLogs(session, transportKind)
      expect(log).toMatchObject({ userId: null, userIdSource: null, uid: 9 })
    })
```

- [ ] **Step 2: Run to see them fail on `'01'` (or `'1'`) and `''`**

Run: `npx vitest run test/commands/attendance.spec.ts -t "returns null when"`
Expected: FAIL with `userId: '01'` (last writer) and `userId: ''`.

- [ ] **Step 3: Implement**

In `src/commands/attendance.ts`:

```ts
function resolve(
  record: DecodedAttendanceRecord,
  byUid: Map<number, ZkUser>,
  byNumericUserId: Map<number, ZkUser | null>,
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
  // No match means no identity, and so does an ambiguous one (null in
  // byNumericUserId marks a numeric key two users share) or a blank printed
  // id. Never fabricate — a null beats a name that belongs to somebody else.
  if (!match || match.userId === '') return { userId: null, userIdSource: null }
  return { userId: match.userId, userIdSource: 'lookup' }
}
```

and replace the `byNumericUserId` construction:

```ts
  // The 16-byte dialect carries a numeric user id, so match on the numeric
  // value of the printed one. Leading zeros survive because the string from
  // the user list is what gets returned — which is also why '1' and '01' are
  // two users sharing one numeric key: that key is marked ambiguous (null)
  // and resolves to no identity rather than to whichever was listed last.
  const byNumericUserId = new Map<number, ZkUser | null>()
  for (const u of users) {
    if (!/^\d+$/.test(u.userId)) continue
    const n = Number(u.userId)
    byNumericUserId.set(n, byNumericUserId.has(n) ? null : u)
  }
```

Replace the `resolveUserIds` option doc:

```ts
  /**
   * Resolve the printed user id for the 8- and 16-byte dialects by also
   * reading the user list. Defaults to true. Turning it off skips a full
   * download of the user list on every call — not one round-trip — and leaves
   * `userId` null for those dialects.
   */
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/commands test/scenarios.spec.ts`
Expected: PASS, including the existing "resolves a 16-byte record by numeric id while preserving leading zeros".

```bash
git add src/commands/attendance.ts test/commands/attendance.spec.ts
git commit -m "fix(commands): an ambiguous or blank lookup is no identity"
```

---

## Phase E — Subscription and facade

### Task 18: Subscription state union, and the idle timer armed by `start()` (spec §8)

**Files:**
- Modify: `src/realtime/Subscription.ts` (whole class), `src/ZkDevice.ts:203-210`
- Test: `test/realtime/subscription.spec.ts`, `test/realtime/device.spec.ts`

**Interfaces:**
- Produces: `Subscription.start(): void` — registering → live, arms the idle timer. `ZkDevice.subscribe` calls it after `session.subscribe` resolves. `push`, `fail`, `close`, iteration unchanged in signature.

- [ ] **Step 1: Write the failing tests**

`test/realtime/subscription.spec.ts`, add:

```ts
  it('does not arm the idle timer until start()', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, { ...opts, idleTimeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 80))
    // Still live: the timer is armed by start(), after registration.
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('E5')))
    const got = await drain(sub, 1)
    expect(got[0]).toMatchObject({ userId: 'E5' })
    await sub.close()
  })

  it('ends the stream with ZkTimeoutError once started and idle', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, { ...opts, idleTimeoutMs: 30 })
    sub.start()
    await expect(drain(sub, 1)).rejects.toThrow(ZkTimeoutError)
  })

  it('queues an event pushed before start() and delivers it after', async () => {
    const { session } = fakeSession()
    const sub = new Subscription(session, opts)
    sub.push(pushed(EVENT_FLAG.ATTENDANCE, attendancePayload('F6')))
    sub.start()
    expect((await drain(sub, 1))[0]).toMatchObject({ userId: 'F6' })
    await sub.close()
  })
```

`test/realtime/device.spec.ts`, inside the transport loop:

```ts
    it('delivers the first event when the idle timeout is shorter than the registration round trip', async () => {
      running = await startEmulator({ transport, replyDelayMs: 120 })
      device = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      await device.connect()
      stream = await device.subscribe({ idleTimeoutMs: 60 })
      const data = Buffer.alloc(32)
      data.write('G7', 0, 9, 'ascii')
      data.set([26, 8, 27, 8, 1, 30], 26)
      running.pushEvent(EVENT_FLAG.ATTENDANCE, data)
      const first = await stream[Symbol.asyncIterator]().next()
      expect(first.done).toBe(false)
      expect(first.value).toMatchObject({ kind: 'attendance', userId: 'G7' })
    })
```

- [ ] **Step 2: Run to see the failures**

Run: `npx vitest run test/realtime/subscription.spec.ts test/realtime/device.spec.ts`
Expected: "does not arm the idle timer until start()" FAILS with `start is not a function` (typecheck first: `pnpm typecheck` reports `start` does not exist) — that is the red; the device test FAILS because the stream is already ended when returned: `next()` resolves `done: true` or rejects `ZkTimeoutError` before the event.

- [ ] **Step 3: Rewrite the class**

Replace the class body in `src/realtime/Subscription.ts` (keep the file's imports, exports and docblocks on `SubscribeOptions`, `ZkEventStream`, `ResolvedOptions`):

```ts
type State =
  | { kind: 'registering' }
  | { kind: 'live' }
  | { kind: 'failed'; error: Error }
  | { kind: 'closed' }

interface Pending {
  resolve: (result: IteratorResult<ZkRealtimeEvent>) => void
  reject: (err: Error) => void
}

export class Subscription implements ZkEventStream {
  private readonly queue: ZkRealtimeEvent[] = []
  /**
   * One state, not five flags. Before v0.5 `waiter`, `rejectWaiter`,
   * `failure`, `ended` and `closed` had to be kept in step by hand at four
   * sites, and the type let them disagree (spec v0.5 §8).
   */
  private state: State = { kind: 'registering' }
  private pending: Pending | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly session: Session,
    private readonly opts: ResolvedOptions,
  ) {}

  /**
   * Registration completed: the stream is live and the idle timer starts.
   *
   * Called by ZkDevice.subscribe after Session.subscribe resolves. Arming
   * the timer in the constructor, as before v0.5, started it before
   * CMD_REG_EVENT was even sent, so an idleTimeoutMs shorter than the
   * registration round trip returned a stream that had already ended.
   */
  start(): void {
    if (this.state.kind !== 'registering') return
    this.state = { kind: 'live' }
    this.armIdleTimer()
  }

  /** Accepts one packet the transport pushed. Never throws. */
  push(pkt: DecodedPacket): void {
    if (this.state.kind === 'failed' || this.state.kind === 'closed') return
    if (!isEventPacket(pkt)) {
      // Deliberately strict: while listening, nothing else should arrive. If
      // something does, this library's model of the connection is wrong, and
      // continuing means guessing which packets mean what.
      this.fail(
        new ZkProtocolError(
          `a non-event packet (command ${pkt.command}) arrived on a listening connection`,
        ),
      )
      return
    }
    if (this.state.kind === 'live') this.armIdleTimer()
    const event = decodeRealtimeEvent(pkt)
    const pending = this.takePending()
    if (pending) {
      pending.resolve({ value: event, done: false })
      return
    }
    this.queue.push(event)
    if (this.queue.length > this.opts.bufferLimit) {
      this.fail(
        new ZkProtocolError(
          `event buffer of ${this.opts.bufferLimit} overflowed; the consumer is not keeping up`,
        ),
      )
    }
  }

  /**
   * Ends the stream with an error.
   *
   * Events already queued are still delivered first — losing readings that
   * arrived intact, because the connection died afterwards, would be worse
   * than reporting the failure a few iterations later.
   */
  fail(err: Error): void {
    if (this.state.kind === 'failed' || this.state.kind === 'closed') return
    this.state = { kind: 'failed', error: err }
    this.clearIdleTimer()
    if (this.queue.length === 0) {
      // A waiting consumer has nothing queued to drain, so it fails now.
      this.takePending()?.reject(err)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ZkRealtimeEvent> {
    return {
      next: (): Promise<IteratorResult<ZkRealtimeEvent>> => {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        switch (this.state.kind) {
          case 'failed':
            return Promise.reject(this.state.error)
          case 'closed':
            return Promise.resolve({ value: undefined, done: true })
          case 'registering':
          case 'live':
            break
        }
        if (this.pending) {
          // There is one waiter slot. A second concurrent next() would
          // overwrite the first and orphan its promise forever, so it is
          // refused instead — the same choice, and the same error, the
          // transports make for a concurrent receive().
          return Promise.reject(
            new ZkConnectionError(
              'a next() is already pending; this stream does not support concurrent iteration',
            ),
          )
        }
        return new Promise<IteratorResult<ZkRealtimeEvent>>((resolve, reject) => {
          this.pending = { resolve, reject }
        })
      },

      // (keep the existing docblock on return())
      return: async (): Promise<IteratorResult<ZkRealtimeEvent>> => {
        await this.close()
        return { value: undefined, done: true }
      },
    }
  }

  /** Ends the subscription and the connection it rides on. Idempotent. */
  async close(): Promise<void> {
    if (this.state.kind === 'closed') return
    this.state = { kind: 'closed' }
    this.clearIdleTimer()
    this.takePending()?.resolve({ value: undefined, done: true })
    await this.session.close()
  }

  private takePending(): Pending | null {
    const pending = this.pending
    this.pending = null
    return pending
  }

  private armIdleTimer(): void {
    if (this.opts.idleTimeoutMs <= 0) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.fail(new ZkTimeoutError(`no event within ${this.opts.idleTimeoutMs}ms`))
    }, this.opts.idleTimeoutMs)
    // Never hold the process open for a timer whose only job is to give up.
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
```

Note one deliberate change of behaviour that the old flags allowed: `close()` after `fail()` used to resolve a waiter with `done: true` even though `failure` was set; now a failed stream stays failed and `close()` only releases the connection. `next()` after that still rejects with the error, which is what the "drains queued events before reporting a failure" test expects.

`src/ZkDevice.ts:203-210`:

```ts
    const subscription = new Subscription(session, resolved)
    await session.subscribe(
      resolved.events,
      (pkt) => subscription.push(pkt),
      (err) => subscription.fail(err),
    )
    subscription.start()
    this.stream = subscription
    return subscription
```

- [ ] **Step 4: Run the realtime suites**

Run: `pnpm typecheck && npx vitest run test/realtime test/scenarios.spec.ts test/diagnostics/probe.realtime.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/realtime/Subscription.ts src/ZkDevice.ts test/realtime
git commit -m "fix(realtime): one stream state, and the idle timer starts when registration completes"
```

---

### Task 19: `disconnect()` during `connect()` (spec §9)

**Files:**
- Modify: `src/ZkDevice.ts` (`connect`, `disconnect`)
- Test: `test/scenarios.spec.ts` (inside its transport loop)

- [ ] **Step 1: Write the failing test**

```ts
    it('honours a disconnect() issued while connect() is still in flight', async () => {
      running = await startEmulator({ transport, replyDelayMs: 100 })
      const d = new ZkDevice({ host: '127.0.0.1', port: running.port, transport })
      const connecting = d.connect()
      await d.disconnect()
      await connecting
      // The session that finished opening was closed, not installed.
      await expect(d.getInfo()).rejects.toThrow(/not connected/)
      expect(running.received.map((p) => p.command)).toContain(CMD.EXIT)
    })
```

- [ ] **Step 2: Run to see it fail because `getInfo()` succeeds**

Run: `npx vitest run test/scenarios.spec.ts -t "disconnect\\(\\) issued while"`
Expected: FAIL — `getInfo()` resolves (the session was installed after the disconnect returned).

- [ ] **Step 3: Track the in-flight connect**

In `src/ZkDevice.ts`:

```ts
  private connecting: Promise<void> | null = null

  async connect(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
    if (this.session) {
      await this.session.close()
      this.session = null
    }
    const session = new Session(this.makeTransport(), {
      timeoutMs: this.timeoutMs,
      commKey: this.commKey,
    })
    const opening = session.open().then(() => { this.session = session })
    this.connecting = opening
    try {
      await opening
    } finally {
      if (this.connecting === opening) this.connecting = null
    }
  }

  /** Closes the session. Safe to call twice, before connect(), and during it. */
  async disconnect(): Promise<void> {
    // A connect() still opening finishes first, so the session it installs
    // is the one closed here rather than one installed after this returns.
    const connecting = this.connecting
    if (connecting) await connecting.catch(() => {})
    const stream = this.stream
    this.stream = null
    if (stream) await stream.close()
    const session = this.session
    this.session = null
    if (session) await session.close()
  }
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/scenarios.spec.ts test/realtime`
Expected: PASS.

```bash
git add src/ZkDevice.ts test/scenarios.spec.ts
git commit -m "fix(device): disconnect() waits for an in-flight connect() and closes what it opened"
```

---

## Phase F — Packaging

### Task 20: Types per condition, and the CLI built as ESM only (spec §10.1, §10.2)

**Files:**
- Modify: `package.json` (`exports`, `build` script), `tsup.config.ts`
- Test: `test/smoke.spec.ts`

- [ ] **Step 1: Write the failing assertions**

Add to `describe('toolchain', …)` in `test/smoke.spec.ts`:

```ts
  it('ships the CLI as ESM only, and the library with a declaration per format', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync('dist/cli.js')).toBe(true)
    // A CommonJS bundle of cli.ts shims import.meta to {}, so its main-module
    // check was always false and it exited 0 having done nothing (review R15).
    // It is not fixed; it is not built.
    expect(existsSync('dist/cli.cjs')).toBe(false)
    expect(existsSync('dist/index.d.ts')).toBe(true)
    expect(existsSync('dist/index.d.cts')).toBe(true)
  })

  it('points each export condition at its own declaration file', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      exports: { '.': { import: { types: string }; require: { types: string } } }
    }
    // One top-level `types` sent CommonJS TypeScript consumers to the ESM
    // declaration and TS1479 (review R12).
    expect(pkg.exports['.'].import.types).toBe('./dist/index.d.ts')
    expect(pkg.exports['.'].require.types).toBe('./dist/index.d.cts')
  })
```

- [ ] **Step 2: Build and run to see both fail**

Run: `pnpm build && npx vitest run test/smoke.spec.ts`
Expected: FAIL — `dist/cli.cjs` exists; `pkg.exports['.'].import.types` is undefined.

- [ ] **Step 3: Change the packaging**

`tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

// Two entries with different formats. The library ships ESM and CommonJS
// with a declaration for each; the CLI ships ESM only — `bin` points at
// dist/cli.js, and a CommonJS bundle of it could never run (its import.meta
// is shimmed to {}, so the main-module check is always false). `clean` is
// off here and done by the build script: with an array of configs tsup may
// run them concurrently, and one config's clean would race the other's
// output.
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, target: 'node20', sourcemap: true, clean: false },
  { entry: ['src/cli.ts'], format: ['esm'], dts: false, target: 'node20', sourcemap: true, clean: false },
])
```

`package.json`:

```json
  "scripts": {
    "build": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsup",
```

and

```json
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
```

Keep `main`, `module`, `types`, `bin`, `files` as they are.

- [ ] **Step 4: Build, run everything, commit**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS. Check `ls dist`: `index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`, `cli.js`, maps; no `cli.cjs`, no `cli.d.*`.

```bash
git add package.json tsup.config.ts test/smoke.spec.ts
git commit -m "build: a declaration per export condition, and no CommonJS CLI that could never run"
```

---

## Phase G — Evidence

### Task 21: Emulator knobs for the experiments (spec §11, E1 and E4 halves)

**Files:**
- Modify: `test/emulator/index.ts` (`reply`, `EmulatorOptions`, user encoding)
- Test: `test/emulator/emulator.spec.ts`

**Interfaces:**
- Produces: options `echoReplyId?: boolean` (default true), `replySessionIdOverride?: number` (applies to every reply except CONNECT and AUTH), `userRecordSize?: 72 | 28` (default 72); exported `encodeUser28(u: ZkUser): Buffer`.

- [ ] **Step 1: Write the failing tests**

In `test/emulator/emulator.spec.ts` (it already has a TCP transport + CONNECT round trip pattern at lines 44-68; follow it). Add to its imports: `import { encodeUser28, startEmulator, type Emulator } from './index.js'`, `import type { ZkUser } from '../../src/types.js'`, and `TcpTransport`, `CMD`, `encodePayload`, `decodePayload` if the file does not already import them. The `running`/`transport` slots and `afterEach` follow the same shape as `test/transport/tcp.spec.ts`.

```ts
describe('experiment knobs', () => {
  it('can stop echoing the reply id', async () => {
    running = await startEmulator({ transport: 'tcp', echoReplyId: false })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 7 }))
    expect(decodePayload(await transport.receive(2_000)).replyId).toBe(0)
  })

  it('can answer every command after the handshake with a wrong session id', async () => {
    running = await startEmulator({ transport: 'tcp', sessionId: 0x1111, replySessionIdOverride: 0x2222 })
    transport = new TcpTransport({ host: '127.0.0.1', port: running.port })
    await transport.connect(2_000)
    await transport.send(encodePayload({ command: CMD.CONNECT, sessionId: 0, replyId: 0 }))
    expect(decodePayload(await transport.receive(2_000)).sessionId).toBe(0x1111)
    await transport.send(encodePayload({ command: CMD.GET_FREE_SIZES, sessionId: 0x1111, replyId: 1 }))
    expect(decodePayload(await transport.receive(2_000)).sessionId).toBe(0x2222)
  })

  it('serves 28-byte user records when asked to', () => {
    const u: ZkUser = { uid: 3, userId: '42', name: 'Ann', privilege: 0, hasPassword: false, cardNumber: 0, raw: '' }
    const rec = encodeUser28(u)
    expect(rec.length).toBe(28)
    expect(rec.readUInt16LE(0)).toBe(3)
    expect(rec.subarray(8, 16).toString('latin1').replace(/\0+$/, '')).toBe('Ann')
    expect(rec.readUInt32LE(24)).toBe(42)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm typecheck`
Expected: unknown options / missing export.

- [ ] **Step 3: Implement the knobs**

In `EmulatorOptions`:

```ts
  /** When false, every reply carries reply id 0 instead of echoing the request's. Experiment E1. */
  echoReplyId?: boolean
  /**
   * Session id written into every reply EXCEPT CONNECT and AUTH, which carry
   * the real one so the client adopts it first. Experiment E1's second half:
   * does the client notice that later replies disagree with what it learned?
   */
  replySessionIdOverride?: number
  /**
   * The user record layout served. 72 is what this library reads. 28 is what
   * zkteco-js decodes over UDP (helper/utils.js:114-126); encoded here from
   * the ZkUser fields ONLY so experiment E4 can serve it to pyzk. This library
   * has no 28-byte decoder and adding one would be a new hypothesis.
   */
  userRecordSize?: 72 | 28
```

Replace `reply`:

```ts
/** Builds one reply payload echoing the request's reply id — unless a knob says otherwise. */
export function reply(
  state: EmulatorState,
  req: DecodedPacket,
  command: number,
  data?: Buffer,
): Buffer {
  const handshake = req.command === CMD.CONNECT || req.command === CMD.AUTH
  const sessionId =
    !handshake && state.opts.replySessionIdOverride !== undefined
      ? state.opts.replySessionIdOverride
      : state.sessionId
  const replyId = state.opts.echoReplyId === false ? 0 : req.replyId
  return encodePayload({ command, sessionId, replyId, data })
}
```

Add:

```ts
/** The 28-byte user record zkteco-js decodes over UDP, for experiment E4 only. */
export function encodeUser28(u: ZkUser): Buffer {
  const b = Buffer.alloc(28)
  b.writeUInt16LE(u.uid, 0)
  b.writeUInt8(u.privilege, 2)
  b.write(u.name, 8, 8, 'latin1')
  b.writeUInt32LE(Number(u.userId) >>> 0, 24)
  return b
}

/** The user list body in the configured record size. */
function userBody(state: EmulatorState): Buffer {
  const size = state.opts.userRecordSize ?? 72
  const records = state.users.map((u) => (size === 28 ? encodeUser28(u) : Buffer.from(u.raw, 'hex')))
  return withSizeHeader(Buffer.concat(records))
}
```

and use `userBody(state)` in both places that build the user list today (`bufferedStream` for `USERTEMP_RRQ`, and the `[CMD.USERTEMP_RRQ]` legacy handler).

- [ ] **Step 4: Run and commit**

Run: `pnpm typecheck && npx vitest run test/emulator test/commands/users.spec.ts`
Expected: PASS.

```bash
git add test/emulator
git commit -m "test(emulator): knobs for the reply-binding and record-size experiments"
```

---

### Task 22: The four black-box experiments and their record (spec §12, §5.5, §7.4)

**Files:**
- Modify: `tools/oracle/capture_pyzk.py`
- Create: `tools/oracle/experiments.ts`, `test/oracle/bulk.spec.ts`, `test/fixtures/oracle/bulk/*.json` (eight files, generated)
- Modify: `package.json` (`oracle:experiments` script), `PROVENANCE.md` (two sections), `tools/oracle/README.md`

**Prerequisite:** `tools/oracle/.venv` with pyzk installed (see `tools/oracle/README.md`). If it does not exist, create it as the README says. pyzk is executed only; its source is never opened.

- [ ] **Step 1: Extend the pyzk driver with a `read-users` mode**

Replace `tools/oracle/capture_pyzk.py`:

```python
"""Drives pyzk against the local emulator so its wire bytes can be recorded.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.

Usage: capture_pyzk.py <port> [tcp|udp] [comm_key] [read-users]

Exit codes, so a harness can tell "did not run" from "ran and failed":
  0  completed everything it was asked
  1  could not connect
  2  connected, but the read raised
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    comm_key = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    read_users = len(sys.argv) > 4 and sys.argv[4] == "read-users"
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp, password=comm_key)
    try:
        conn.connect()
    except Exception as exc:  # the emulator may answer only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
        return 1
    code = 0
    try:
        if read_users:
            for user in conn.get_users():
                # One line per user the client believes it read: what it
                # parsed is the observable, not how it parsed it.
                print(f"{user.uid}|{user.user_id}|{user.name}")
    except Exception as exc:
        print(f"pyzk read failed: {exc}", file=sys.stderr)
        code = 2
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return code


if __name__ == "__main__":
    raise SystemExit(main())
```

(`conn.get_users()` and the `uid`, `user_id`, `name` attributes are pyzk's documented public API.)

- [ ] **Step 2: Write the harness**

`tools/oracle/experiments.ts`:

```ts
/**
 * Four black-box experiments against pyzk (spec v0.5 §12). Each starts the
 * emulator in one configuration, runs pyzk's public API against it, and
 * records three observables: what pyzk sent (the emulator's log), what pyzk
 * printed (the users it believes it read), and how it exited.
 *
 * A run that could not be spawned, or exited non-zero without printing, is
 * recorded as `completed: false` with the exit code — never as a result.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CMD } from '../../src/codec/commands.js'
import { USER_RECORD_SIZE } from '../../src/codec/records/user.js'
import type { ZkUser } from '../../src/types.js'
import { startEmulator, type EmulatorOptions } from '../../test/emulator/index.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle', 'bulk')
const SESSION_ID = 0x1f2e

function pythonPath(): string {
  const win = path.join('tools', 'oracle', '.venv', 'Scripts', 'python.exe')
  const posix = path.join('tools', 'oracle', '.venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  throw new Error('oracle venv not found — see tools/oracle/README.md')
}

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'latin1')
  b.write(userId, 48, 9, 'latin1')
  return { uid, userId, name, privilege: 0, hasPassword: false, cardNumber: 0, raw: b.toString('hex') }
}

// Three users: 3 × 72 + 4 = 220 body bytes, so a size read at the wrong
// offset is unmistakable (0x000000dc at offset 1 reads as 0x0000dc00 at 0).
const USERS = [emUser(1, '100001', 'Ann'), emUser(2, '100002', 'Bo'), emUser(3, '100003', 'Cy')]

interface Run { exitCode: number | null; stdout: string; stderr: string; spawned: boolean }

function runPyzk(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawned = true
    const child = spawn(pythonPath(), ['tools/oracle/capture_pyzk.py', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { spawned = false; stderr += String(err) })
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr, spawned }))
  })
}

interface Variant { name: string; experiment: 'E1' | 'E2' | 'E3' | 'E4'; transport: 'tcp' | 'udp'; options: Partial<EmulatorOptions> }

const VARIANTS: Variant[] = [
  { name: 'E1-no-reply-id-echo-tcp', experiment: 'E1', transport: 'tcp', options: { echoReplyId: false } },
  { name: 'E1-wrong-session-id-tcp', experiment: 'E1', transport: 'tcp', options: { replySessionIdOverride: 0x2222 } },
  { name: 'E2-size-at-1-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-1' } },
  { name: 'E2-size-at-0-tcp', experiment: 'E2', transport: 'tcp', options: { prepareBufferReply: 'size-at-0' } },
  { name: 'E3-chunk-transfer-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'transfer' } },
  { name: 'E3-chunk-single-packet-tcp', experiment: 'E3', transport: 'tcp', options: { chunkReply: 'single-packet' } },
  { name: 'E4-users-72-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 72 } },
  { name: 'E4-users-28-udp', experiment: 'E4', transport: 'udp', options: { userRecordSize: 28 } },
]

async function runVariant(v: Variant): Promise<void> {
  const emulator = await startEmulator({ transport: v.transport, sessionId: SESSION_ID, users: USERS, ...v.options })
  try {
    const run = await runPyzk([String(emulator.port), v.transport, '0', 'read-users'])
    await new Promise((r) => setTimeout(r, 300))
    const sent = emulator.received.map((p) => ({
      command: p.command,
      sessionId: p.sessionId,
      replyId: p.replyId,
      // The READ_BUFFER request's (offset, size) is E2's observable.
      data: p.command === CMD.READ_BUFFER || p.command === CMD.PREPARE_BUFFER ? p.data.toString('hex') : undefined,
    }))
    const fixture = {
      experiment: v.experiment,
      variant: v.name,
      transport: v.transport,
      served: { users: USERS.map((u) => `${u.uid}|${u.userId}|${u.name}`), options: v.options },
      completed: run.spawned && run.exitCode === 0,
      exitCode: run.exitCode,
      printed: run.stdout.trim().split(/\r?\n/).filter(Boolean),
      stderr: run.stderr.trim(),
      sent,
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `${v.name}.json`)
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`${fixture.completed ? 'completed' : `NOT COMPLETED (exit ${String(run.exitCode)})`}: ${file}\n`)
  } finally {
    await emulator.close()
  }
}

for (const v of VARIANTS) await runVariant(v)
```

Add to `package.json` scripts: `"oracle:experiments": "tsx tools/oracle/experiments.ts"`.

- [ ] **Step 3: Write the presence spec**

`test/oracle/bulk.spec.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join('test', 'fixtures', 'oracle', 'bulk')
const VARIANTS = [
  'E1-no-reply-id-echo-tcp', 'E1-wrong-session-id-tcp',
  'E2-size-at-1-tcp', 'E2-size-at-0-tcp',
  'E3-chunk-transfer-tcp', 'E3-chunk-single-packet-tcp',
  'E4-users-72-udp', 'E4-users-28-udp',
]

// These fixtures are evidence for PROVENANCE.md, not tests of the library.
// What is asserted is that the evidence is present and says whether it ran:
// a deleted fixture, or one recorded as not completed, must be noticed.
describe('buffered-read experiments (spec v0.5 §12)', () => {
  it.each(VARIANTS)('%s is recorded', (name) => {
    const file = path.join(DIR, `${name}.json`)
    expect(existsSync(file)).toBe(true)
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as { completed: boolean; exitCode: number | null; sent: unknown[] }
    expect(typeof fixture.completed).toBe('boolean')
    expect(fixture.sent.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 4: Run the experiments and read the results**

Run: `pnpm oracle:experiments`
Expected: eight lines, one per variant, each `completed` or `NOT COMPLETED (exit N)`, and eight files under `test/fixtures/oracle/bulk/`. Then `npx vitest run test/oracle/bulk.spec.ts` PASSES.

Read the eight files. What each tells you:

- **E1**: `completed` true in both variants means pyzk relies on neither echo. `completed` false (exit 1 or 2, with a timeout in `stderr`) in a variant means pyzk waited for a reply matching what it sent.
- **E2**: in `sent`, the first READ_BUFFER request's `data` hex is `<offset:4><size:4>` little-endian. Under `size-at-1`, a client reading offset 1 asks for size 220 (`dc000000`); under `size-at-0` a client reading offset 1 asks for a garbage size and a client reading offset 0 asks for 220. Whichever variant produced a sensible request is the offset pyzk reads.
- **E3**: `completed` true with `printed` equal to `served.users` under exactly one `chunkReply` value (or both) says which shape pyzk completes a read under.
- **E4**: `printed` matches `served.users` under 72 or under 28 on UDP; that is the size pyzk expects there.

- [ ] **Step 5: Record the results in `PROVENANCE.md`**

Add two sections before `## Inbound checksums are not validated` (after the *User record width and size* section from Task 15). Write the second column of each table from the fixtures, and pick the sentence the decision rule names — the spec's §12 table gives one sentence per outcome; do not soften either.

```markdown
## Reply binding: not implemented, and why

`Session` (v0.5) closes on any timeout and refuses a concurrent request, so a
late reply can never be collected by a later request (design spec v0.5 §5.2).
It does **not** compare a reply's session id or reply id to the request, for
three reasons that are recorded here so the decision is not re-litigated from
memory:

1. No readable reference validates either id on receive. `zkteco-js` reads
   the session id out of the `CMD_CONNECT` reply (`ztcp.js:274-275`,
   `zudp.js:231`) and never compares anything on any later packet; its chunk
   handlers do not read the header at all (`ztcp.js:380-402`).
2. No oracle fixture shows a device reply. Every capture under
   `test/fixtures/oracle/` is what a client SENT.
3. A wrong guess would be total: a device that does not echo would time out
   every request, and under §5.2 every timeout closes the session.

Experiment E1 asked the one question askable without hardware — does `pyzk`
keep working when the emulator stops echoing? — with the results in
`test/fixtures/oracle/bulk/E1-*.json`:

| Variant | pyzk completed connect + read | Read as |
|---|---|---|
| reply id never echoed | (from the fixture) | (sentence per the decision rule) |
| session id wrong after the handshake | (from the fixture) | (sentence per the decision rule) |

Whatever E1 shows is a fact about `pyzk`, not about a device. Matching stays
out until a device answers, or until a later cycle takes E1's result as its
evidence.

## The buffered read — restated from a single readable source

`readBulkBuffered` (v0.5) follows `zkteco-js` at four points, at the
"source reading" level (design spec v0.5 §6.1). Before v0.5 this library's
model agreed with nothing but its own emulator.

| Point | This library before v0.5 | The reference | Lines |
|---|---|---|---|
| PREPARE_BUFFER request `fct` | 0 for every command | 5 for the user list, 0 for attendance | `helper/command.js:109-110` |
| PREPARE_BUFFER reply | size at data offset 0 | size at offset 1; a `CMD_DATA` reply is the whole body | `ztcp.js:344-352`, `zudp.js:311` |
| READ_BUFFER reply | one packet carrying the chunk | PREPARE_DATA, DATA packets, ACK_OK | `zudp.js:335-350`, `ztcp.js:389-395` |
| READ_BUFFER reply command | never checked | not checked on TCP; a fourth command is an error on UDP | same |

Experiments E2 and E3 put `pyzk` against both models
(`test/fixtures/oracle/bulk/E2-*.json`, `E3-*.json`):

| Question | Result | Read as |
|---|---|---|
| E2: which offset does pyzk read the size at? | (the size field of pyzk's first READ_BUFFER request under each layout) | (agrees with the reference: two oracles agree; disagrees: divergence recorded, the library keeps following the readable reference, the emulator keeps both) |
| E3: which chunk shape does pyzk complete a read under? | (which variant printed the served users) | (as E2) |
| E4: which user record size does pyzk expect over UDP? | (which variant printed the served users) | (recorded under *User record width and size*; no code change) |

Neither oracle is a device. The first hardware run is the test either way.
```

Also add one paragraph to `tools/oracle/README.md` under a new heading `## Experiments`: what `pnpm oracle:experiments` does, that its fixtures live in `test/fixtures/oracle/bulk/` (their own directory so `fixtures.spec.ts`'s count is untouched), and that a non-zero exit is recorded as not completed.

- [ ] **Step 6: Commit**

```bash
git add tools/oracle test/oracle/bulk.spec.ts test/fixtures/oracle/bulk package.json PROVENANCE.md
git commit -m "oracle: four black-box pyzk experiments on reply binding and the buffered read, recorded"
```

---

## Phase H — Documentation and version

### Task 23: README, checklist item 22, and the remaining PROVENANCE row (spec §14, §16)

**Files:**
- Modify: `README.md` (after the Usage block; in the Identity section), `docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md:701-703`, `PROVENANCE.md` §Known divergences

- [ ] **Step 1: README**

After the Usage code block (line 40), add:

```markdown
A `ZkTimeoutError` closes the session. After one, every call throws
`ZkConnectionError` until `connect()` is called again — a reply that arrives
after the deadline would otherwise be handed to the next request as its own
answer, and nothing in the protocol lets this library tell the two apart
without guessing. The same deadline bounds `connect()` itself. If you retry
on a timeout, reconnect first.
```

In *Identity, and why `userId` can be null*, after the table, add:

```markdown
`userId` is up to nine characters. That width follows the one readable
reference implementation; a device storing eight returns the same string.
```

- [ ] **Step 2: Checklist item 22**

In the v0.1 spec, replace the sentence at lines 701-703 — "This is v0.1 transport architecture, not something this scope introduced, and no code change is proposed here — record what a real device does before deciding whether one is warranted." — with:

"v0.5 (`2026-09-02-zkteco-library-correctness-design.md` §5.2) closes the session on any timeout and refuses a concurrent request, so a late reply can no longer be collected by a later request. Whether a device answers late remains the question; the trace audit answers it."

Leave the item's remaining text, including "Not testable by the bring-up kit", unchanged.

- [ ] **Step 3: PROVENANCE §Known divergences**

Update the introductory paragraph's count ("Two claims were adjudicated by captured evidence") to name the buffered-read section: append "The buffered read's four points, adopted from source reading and put to `pyzk` in v0.5, are recorded under *The buffered read* below rather than as numbered divergences here, because they were never claims this project adjudicated between two oracles — they were a model that agreed with nothing."

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-28-zkteco-protocol-library-design.md PROVENANCE.md
git commit -m "docs: timeouts close the session, nine-character ids, and item 22 points at v0.5"
```

---

### Task 24: Version 0.5.0 and the full check (spec §2.3, §10.3)

**Files:**
- Modify: `package.json:3`, `src/index.ts:24`, `test/smoke.spec.ts:6`

- [ ] **Step 1: Bump both, and the pinned literal**

`package.json`: `"version": "0.5.0"`. `src/index.ts`: `export const VERSION = '0.5.0'`. `test/smoke.spec.ts:6`: `expect(VERSION).toBe('0.5.0')`.

- [ ] **Step 2: The full check, in the load-bearing order**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS, every suite. Then `pnpm release:drill` — expected to pass its eleven checks against the emulator (the drill's own updates are the sibling spec's; a failure here that names `dist/cli.cjs` or the exports map means Task 20 regressed something the drill exercises — investigate before continuing).

- [ ] **Step 3: Commit without tagging**

```bash
git add package.json src/index.ts test/smoke.spec.ts
git commit -m "chore: 0.5.0 in both places; tagged only after the diagnostics-evidence plan lands"
```

Do **not** push a tag. Spec §10.3: one release after both plans.

---

## Self-review against the spec

- §4.1–§4.7 → Tasks 1–7. §5.1–§5.4 → Tasks 8–11; §5.5 → Task 22's PROVENANCE section. §6.1 → Tasks 12–13; §6.2 → Task 14; §6.3 → Task 12; §6.4 → Task 12's docblock note. §7.1 → Task 15; §7.2 → Task 16; §7.3 → Task 17; §7.4 → Tasks 15 (record) and 21–22 (E4). §8 → Task 18. §9 → Task 19. §10.1–§10.2 → Task 20; §10.3 → Task 24. §11 knobs: `replyDelayMs` (Task 8), `legacyOvershootBytes` (12), `prepareBufferReply`/`chunkReply`/`prepareBufferInline`/`lastPrepareFct` (13), `echoReplyId`/`replySessionIdOverride`/`userRecordSize`/`emUser` nine bytes (15, 21). §12 → Task 22. §13's rows each name their task's Step 2. §14 → Tasks 14 (CLAUDE.md), 15–16 (PROVENANCE, docblocks), 23 (README, item 22). §16 → Task 23.
- Names used across tasks: `PacketInbox` with `held: () => Error | null` (1, used 2–6); `connect(timeoutMs)` (3, used everywhere); `readTransfer(session, expected, first?)` (12, used 13); `readBulkBuffered(): Promise<Buffer | null>` (13, used 14); `BUFFER_FCT` (13); `Subscription.start()` (18); `createTransport` (7); emulator knob names as listed above; `encodeUser28` (21, used 22 through `userRecordSize`).
- The one item the spec assigns to this plan but whose test lives elsewhere: the CommonJS consumer typecheck (§13, §10.1) runs in the release drill, which the sibling plan extends. Task 20's assertion on the exports map is the in-repo half.
