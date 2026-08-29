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

### Realtime events

```ts
const device = new ZkDevice({ host: '192.168.1.201' })
await device.connect()
const stream = await device.subscribe()          // attendance events by default

try {
  for await (const event of stream) {
    if (event.kind === 'attendance') console.log(event.userId, event.timestamp.local)
  }
} finally {
  await stream.close()                           // releases the connection
}
```

**Close the stream, in a `finally`.** The error path needs it as much as the
happy one: a stream that ended with an error stops delivering but does not
release the socket, which stays open with a listener attached until
`stream.close()` or `device.disconnect()` is called.

**The stream does not reconnect and does not backfill.** A lost connection
throws out of the `for await` and the events that occur before you subscribe
again are gone — the device buffers nothing for a subscriber that went away.
Realtime is a latency improvement on top of polling, not a replacement for it:
keep reading the log on a schedule, and let it recover whatever the stream
missed.

**One device, one mode.** While subscribed, `getInfo()`, `getUsers()` and
`getAttendanceLogs()` throw. To poll and listen at the same time, construct a
second `ZkDevice` — which opens a second connection, and the number of
concurrent connections a terminal accepts has never been verified against
hardware.

**Some models send no identity.** The larger event payload carries the printed
user id; the smaller one carries only a device-internal `uid`, which is
recycled after a user is deleted and is therefore not an identity. `userId` is
`null` there rather than a guess.

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
so `in` answers exactly whether it replied. `getParameters` returns a
null-prototype object, so `in` is not just the convenient check but the
correct one — `result.hasOwnProperty(key)` throws on it. `DEVICE_PARAM` lists
the keywords that have been observed; it is not a promise that any given
model exposes them.

```ts
const clock = await device.getTime()   // ZkNaiveTime, never a Date
```

Useful mainly for spotting drift: a device whose clock has slipped produces
attendance timestamps that look wrong for no visible reason. Setting the clock
is a write path and is deliberately not implemented.

**Strings are decoded as latin1, not ASCII.** Node's `'ascii'` strips the high
bit, which silently corrupts any name outside ASCII with no way to recover it.
latin1 is byte-preserving: if a device sends text in another encoding, the
original bytes are `Buffer.from(value, 'latin1')` away. Which encoding devices
actually use is an open question — see the first-hardware checklist.

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
