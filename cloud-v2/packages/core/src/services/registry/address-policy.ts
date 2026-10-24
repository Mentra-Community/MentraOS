/**
 * @fileoverview The addresses Core's miniapp fetcher may connect to.
 *
 * Core fetches URLs that developers choose, so it must never reach its own
 * network through one. Only ordinary public unicast passes. That refuses
 * loopback, private, link-local (which holds cloud instance metadata services),
 * carrier-grade NAT, multicast, broadcast, reserved and documentation ranges,
 * and for IPv6 also unique-local, site-local, 6to4, Teredo, NAT64 and
 * everything outside global unicast (2000::/3). An IPv4 address mapped into
 * IPv6 is judged as the IPv4 address it carries.
 */

import net from "node:net"
import ipaddr from "ipaddr.js"

/** IPv6 global unicast: the only IPv6 space allocated to public hosts. */
const IPV6_GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3")

/**
 * Public-range addresses that cloud platforms answer from inside their own
 * networks: Azure's platform address (WireServer).
 */
const IPV4_PLATFORM_ADDRESSES = [ipaddr.parseCIDR("168.63.129.16/32")]

/**
 * Whether Core's fetcher may connect to `address`, an IPv4 or IPv6 literal as
 * a resolver answers it. Anything else, including IPv4 shorthands like
 * `127.1`, octal or hex parts, brackets and IPv6 zone indexes, is refused.
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false
  // Node's own check takes only canonical forms; ipaddr.js alone accepts
  // shorthands such as "127.1" and "0x7f.0.0.1".
  const family = net.isIP(address)
  if (family === 0) return false
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    // ipaddr.js reads an IPv6 address written with a dotted IPv4 tail, such
    // as "::8.8.8.8", as IPv4-mapped. The URL parser writes the address the
    // socket would use, all in hex, first.
    parsed = ipaddr.parse(family === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address)
  } catch {
    return false
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6
    if (!v6.isIPv4MappedAddress()) return v6.range() === "unicast" && v6.match(IPV6_GLOBAL_UNICAST)
    parsed = v6.toIPv4Address()
  }
  const v4 = parsed as ipaddr.IPv4
  return v4.range() === "unicast" && !IPV4_PLATFORM_ADDRESSES.some(range => v4.match(range))
}
