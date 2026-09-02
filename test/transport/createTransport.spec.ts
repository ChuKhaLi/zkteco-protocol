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
