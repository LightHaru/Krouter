import { resolve4 } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'

/**
 * Resolve public endpoints without consulting the hosts file. Krouter's optional
 * MITM mode maps Kiro hosts to 127.0.0.1, which must not capture direct backend
 * requests when the local HTTPS interceptor is stopped.
 */
const publicDnsLookup: LookupFunction = (hostname, options, callback) => {
  const family = isIP(hostname)
  if (family) {
    callback(null, options.all ? [{ address: hostname, family }] : hostname, family)
    return
  }

  resolve4(hostname, (error, addresses) => {
    if (error || addresses.length === 0) {
      callback(error || new Error(`No IPv4 address found for ${hostname}`), '', 4)
      return
    }

    if (options.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 }))
      )
      return
    }
    callback(null, addresses[0], 4)
  })
}

export function createDirectDispatcher(connections: number): Agent {
  return new Agent({
    allowH2: true,
    connections,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connectTimeout: 15_000,
    connect: { lookup: publicDnsLookup }
  })
}
