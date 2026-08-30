import { afterEach, describe, expect, it } from 'vitest'
import { getIdentity, getParameters, getTime } from '../../src/commands/device.js'
import { Session } from '../../src/session/Session.js'
import { TcpTransport } from '../../src/transport/tcp.js'
import { UdpTransport } from '../../src/transport/udp.js'
import { CMD } from '../../src/codec/commands.js'
import { ZkAuthError, ZkProtocolError, ZkTimeoutError } from '../../src/errors.js'
import { reply, startEmulator, type Emulator } from '../emulator/index.js'

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

    it('reports a refused prototype-named key as absent, not inherited', async () => {
      running = await startEmulator({ transport: transportKind, params: PARAMS })
      session = await connect(running.port)
      const out = await getParameters(session, ['toString'])
      expect('toString' in out).toBe(false)
    })

    it('throws ZkAuthError rather than decoding an ACK_UNAUTH reply as a value', async () => {
      // ACK_UNAUTH is the one non-acknowledgment reply this codebase already
      // assigns a meaning to (Session.open handles it during the comm-key
      // handshake). tryExecute() only throws on ACK_ERROR, so without this
      // check the reply would fall through to decodeParamReply() and either
      // be parsed as a plausible value or, empty-bodied, be mistaken for a
      // legitimate empty-value answer.
      running = await startEmulator({
        transport: transportKind,
        params: PARAMS,
        handlers: { [CMD.OPTIONS_RRQ]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = await connect(running.port)
      await expect(getParameters(session, ['~SerialNumber'])).rejects.toBeInstanceOf(
        ZkAuthError,
      )
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
      expect(id.deviceName).toBe('MB360')
      expect(id.platform).toBe('ZMM220_TFT')
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

    it('throws ZkAuthError when CMD_GET_VERSION answers ACK_UNAUTH with an empty body', async () => {
      // readFirmware is the sharpest case: it is the only read in this scope
      // with no other validation (no echo, no length check), so an
      // ACK_UNAUTH with an EMPTY body would otherwise decode to
      // firmwareVersion: '' — indistinguishable from a device that genuinely
      // answered with no value.
      running = await startEmulator({
        transport: transportKind,
        params: FULL.params,
        handlers: { [CMD.GET_VERSION]: (req, state) => [reply(state, req, CMD.ACK_UNAUTH)] },
      })
      session = await connect(running.port)
      await expect(getIdentity(session)).rejects.toBeInstanceOf(ZkAuthError)
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

    it('throws ZkAuthError rather than decoding an ACK_UNAUTH body as a time', async () => {
      // The sharpest case of the collapse the ACK_UNAUTH guards close: unlike a
      // parameter reply, which the echo check would reject, and unlike a short
      // reply, which the length check would reject, FOUR bytes of an
      // acknowledgment that is not one decode to a perfectly valid-looking date
      // with nothing anywhere to contradict them. The bytes below decode to
      // 2035-08-07T01:49:05 — a plausible clock reading from a device that
      // never answered the question.
      running = await startEmulator({
        transport: transportKind,
        handlers: {
          [CMD.GET_TIME]: (req, state) => [
            reply(state, req, CMD.ACK_UNAUTH, Buffer.from([0x11, 0x22, 0x33, 0x44])),
          ],
        },
      })
      session = await connect(running.port)
      // The guard is Session.execute()'s, not getTime()'s -- getTime carries no
      // ACK_UNAUTH check of its own. This still asserts the property that
      // matters end to end: getTime never returns a date decoded from a reply
      // that acknowledged nothing.
      await expect(getTime(session)).rejects.toBeInstanceOf(ZkAuthError)
    })
  })
}
