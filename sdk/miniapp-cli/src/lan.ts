/**
 * LAN address selection for miniapp QR codes / release install URLs.
 *
 * Naive "first non-internal IPv4" picks VPN/tunnel interfaces (utun, tun,
 * Tailscale, etc.) on many developer machines, which phones on Wi-Fi cannot
 * reach. Score candidates and prefer real Wi-Fi / Ethernet instead.
 */

import os from "os"

export interface LanIface {
  name: string
  address: string
  internal: boolean
  family: string | number
  /** Present on normal broadcast LANs; often missing on point-to-point tunnels. */
  netmask?: string
  cidr?: string | null
  mac?: string
}

/** Interface-name prefixes that are almost never the Wi-Fi the phone shares. */
const SKIP_NAME_PREFIXES = [
  "utun",
  "awdl",
  "llw",
  "bridge",
  "tun",
  "tap",
  "ipsec",
  "ppp",
  "ap",
  "phy",
]

/** Virtual / overlay adapter names to demote to last-resort fallback. */
const VIRTUAL_NAME_REGEX =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|docker|^vmnet|^veth|^zt/i

/** RFC 6598 Carrier Grade NAT (CGNAT) address space (100.64.0.0/10), used by Tailscale. */
const CGNAT_REGEX = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/** Prefer these when present (macOS Wi-Fi is usually en0). */
const PREFERRED_NAMES = new Set(["en0", "en1", "eth0", "eth1", "wlan0", "wlan1", "wlp0s20f3"])

function isIpv4(family: string | number): boolean {
  return family === "IPv4" || family === 4
}

function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.")
}

function isCgnat(address: string): boolean {
  return CGNAT_REGEX.test(address)
}

function isVirtualName(name: string): boolean {
  return VIRTUAL_NAME_REGEX.test(name)
}

function isPreferredName(name: string): boolean {
  const lower = name.toLowerCase()
  return PREFERRED_NAMES.has(name) || PREFERRED_NAMES.has(lower) || /^(wi-fi|ethernet)(\s+\d+)?$/i.test(name)
}

function shouldSkipName(name: string): boolean {
  const lower = name.toLowerCase()
  return SKIP_NAME_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}`))
}

/**
 * Rough "how /8-like is this mask?" — tunnel VPNs often advertise 255.0.0.0
 * while home/office Wi-Fi is /24. Smaller host-count (tighter mask) scores higher.
 */
function netmaskSpecificity(netmask: string | undefined): number {
  if (!netmask) return 0
  const parts = netmask.split(".").map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return 0
  // Count set bits.
  let bits = 0
  for (const octet of parts) {
    let v = octet
    while (v) {
      bits += v & 1
      v >>= 1
    }
  }
  return bits
}

/** Score a candidate; higher wins. Negative = reject. */
export function scoreLanIface(iface: LanIface): number {
  if (!isIpv4(iface.family) || iface.internal) return -1
  if (isLinkLocal(iface.address)) return -1
  if (shouldSkipName(iface.name)) return -1
  // Zero MAC is typical of virtual/tunnel adapters on macOS.
  // Reject unless it qualifies as a virtual/CGNAT fallback candidate.
  if (
    iface.mac === "00:00:00:00:00:00" &&
    !isPreferredName(iface.name) &&
    !isVirtualName(iface.name) &&
    !isCgnat(iface.address)
  ) {
    return -1
  }

  const isVirtual = isVirtualName(iface.name)
  const isCgnatAddr = isCgnat(iface.address)

  let score = 0
  // Prioritize standard private physical LAN ranges
  if (iface.address.startsWith("192.168.")) {
    score += 100
  } else if (iface.address.startsWith("10.")) {
    score += 80
  } else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)) {
    score += 60
  } else if (isCgnatAddr) {
    score += 5
  } else {
    score += 10 // other public / unusual — last resort
  }

  if (!isVirtual) {
    if (isPreferredName(iface.name)) {
      score += 40
    } else if (
      /^en\d+$/i.test(iface.name) ||
      /^eth\d+$/i.test(iface.name) ||
      /^wlan\d+$/i.test(iface.name) ||
      // Predictable NetworkManager names on modern Linux (wlp3s0, enp0s3, …).
      /^wlp\w+/i.test(iface.name) ||
      /^enp\w+/i.test(iface.name)
    ) {
      score += 25
    }
  }

  const specificity = netmaskSpecificity(iface.netmask)
  // Prefer /16–/24 style LANs over /8 tunnels that slipped past the name filter.
  if (specificity >= 16 && specificity <= 24) score += 20
  else if (specificity > 24) score += 10
  else if (specificity > 0 && specificity < 16) score -= 20

  if (!isVirtual && !isCgnatAddr) {
    // Primary tier: all non-virtual, non-CGNAT candidates are offset by +1000
    // so physical scores are always >= 1000.
    score += 1000
    return Math.max(1000, score)
  }

  // Fallback tier: virtual adapter names and CGNAT addresses
  if (isVirtual) score -= 100
  if (isCgnatAddr) score -= 50

  // Clamped between 1 and 100 so virtual/CGNAT acts as last-resort fallback.
  return Math.min(100, Math.max(1, score))
}

/**
 * Pick the best LAN IPv4 for phone reachability from a NetworkInterfaces-like map.
 * Exposed for unit tests; production code uses {@link getLanIp}.
 */
export function pickLanIp(interfaces: NodeJS.Dict<LanIface[] | undefined>): string | null {
  let best: {address: string; score: number} | null = null
  for (const [name, list] of Object.entries(interfaces)) {
    for (const raw of list ?? []) {
      const iface: LanIface = {...raw, name}
      const score = scoreLanIface(iface)
      if (score < 0) continue
      if (!best || score > best.score) {
        best = {address: iface.address, score}
      }
    }
  }
  return best?.address ?? null
}

/** Current machine's best phone-reachable LAN IPv4, or null if none. */
export function getLanIp(): string | null {
  return pickLanIp(os.networkInterfaces() as NodeJS.Dict<LanIface[] | undefined>)
}

/**
 * Bonjour / mDNS host for this machine (`ComputerName.local`), when usable.
 * Survives Wi-Fi IP changes better than a raw IPv4 — phones that resolve
 * `.local` can keep the same QR/dev URL across DHCP renewals.
 */
export function getMdnsHostname(): string | null {
  const host = String(os.hostname() || "").trim()
  if (!host) return null
  // Bonjour advertises the first DNS label as `Label.local`. Machines whose
  // hostname includes a corporate DNS suffix (e.g. `mba.corp.example.com`)
  // must not become `mba.corp.example.com.local`.
  const base = host.replace(/\.local$/i, "").split(".")[0] ?? ""
  if (!base || base.toLowerCase() === "localhost") return null
  // Reject names that would make a broken URL host.
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(base)) {
    return null
  }
  return `${base}.local`
}
