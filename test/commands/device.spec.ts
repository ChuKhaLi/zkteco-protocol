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
