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
