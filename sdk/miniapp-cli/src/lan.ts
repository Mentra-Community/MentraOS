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
  "docker",
  "veth",
  "vmnet",
  "tun",
  "tap",
  "zt",
  "tailscale",
  "ipsec",
  "ppp",
  "ap",
  "phy",
]

/** Prefer these when present (macOS Wi-Fi is usually en0). */
const PREFERRED_NAMES = new Set(["en0", "en1", "eth0", "eth1", "wlan0", "wlan1", "wlp0s20f3"])

function isIpv4(family: string | number): boolean {
  return family === "IPv4" || family === 4
}

function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.")
}

function isPrivateLan(address: string): boolean {
  if (address.startsWith("192.168.")) return true
  if (address.startsWith("10.")) return true
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
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
  if (iface.mac === "00:00:00:00:00:00" && !PREFERRED_NAMES.has(iface.name)) return -1

  let score = 0
  if (isPrivateLan(iface.address)) score += 50
  else score += 5 // public / unusual — last resort

  if (PREFERRED_NAMES.has(iface.name)) score += 40
  else if (
    /^en\d+$/i.test(iface.name) ||
    /^eth\d+$/i.test(iface.name) ||
    /^wlan\d+$/i.test(iface.name) ||
    // Predictable NetworkManager names on modern Linux (wlp3s0, enp0s3, …).
    /^wlp\w+/i.test(iface.name) ||
    /^enp\w+/i.test(iface.name)
  ) {
    score += 25
  }

  const specificity = netmaskSpecificity(iface.netmask)
  // Prefer /16–/24 style LANs over /8 tunnels that slipped past the name filter.
  if (specificity >= 16 && specificity <= 24) score += 20
  else if (specificity > 24) score += 10
  else if (specificity > 0 && specificity < 16) score -= 20

  // 192.168/16 is the common home/office Wi-Fi shape.
  if (iface.address.startsWith("192.168.")) score += 10

  return score
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
