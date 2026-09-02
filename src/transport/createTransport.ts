import { TcpTransport } from './tcp.js'
import { UdpTransport } from './udp.js'
import type { Transport, TransportOptions } from './Transport.js'

/** The one place that knows which class each kind names. */
export function createTransport(kind: 'tcp' | 'udp', opts: TransportOptions): Transport {
  return kind === 'tcp' ? new TcpTransport(opts) : new UdpTransport(opts)
}
