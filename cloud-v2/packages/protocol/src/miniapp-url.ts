/**
 * @fileoverview Miniapp URLs, and the package names each may serve.
 *
 * A miniapp URL is a base URL that serves `miniapp.json` and the files it names. A miniapp's package name is its
 * identity, so a name may only be served from a domain that owns it: the URL's reversed registrable domain, plus at
 * least one more part (`notes.example.com` may serve `com.example.*`). Core checks this when it verifies a
 * registration and the engine checks it on every install and update, both from this one implementation.
 *
 * Registrable domains come from the Public Suffix List (tldts), private section included, as browsers use it to scope
 * cookies, so each GitHub Pages user has their own namespace. Nobody owns names under an IP address, a local-network
 * name, a suffix the list doesn't know (`.internal`, `.test`) or `.arpa`, so those have no registrable domain.
 *
 * Every input is parsed the same way on Bun and on Hermes, whose URL implementation has no IDN support: anything
 * outside printable ASCII is refused, and IDN hosts are written in their `xn--` form.
 */
import {parse as parseDomain} from "tldts"
import {z} from "zod"

/** A public miniapp URL is HTTPS; a local-network one, on the developer's own network, may be HTTP. */
export type MiniappHostKind = "public" | "local"

export interface NormalizedMiniappUrl {
  /** The canonical URL: lowercase scheme and host, no default port, a path that ends in `/`. */
  url: string
  /** The URL's hostname: lowercase, without a port or a trailing dot; an IPv6 address keeps its brackets. */
  host: string
  kind: MiniappHostKind
}

/** Package names: lowercase dot-separated parts that start with a letter, with no hyphens. */
export const MINIAPP_PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Apple's age categories, which `ageRating` in `miniapp.json` takes. */
export const MINIAPP_AGE_RATINGS = ["4+", "9+", "13+", "16+", "18+"] as const
export type MiniappAgeRating = (typeof MINIAPP_AGE_RATINGS)[number]

/** `com.mentra.*` belongs to mentraglass.com, which Mentra owns; mentra.com is not Mentra's. */
const MENTRA_PACKAGE_PREFIX = "com.mentra."
const MENTRA_DOMAIN_PREFIX = "com.mentraglass"

const MAX_URL_LENGTH = 2048
const MAX_HOST_LENGTH = 253
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const SCHEME_AND_AUTHORITY = /^https?:\/\/([^/?#]*)/i
const HOST_CHARACTERS = /^[a-z0-9._:[\]-]+$/i
const HOST_LABEL = /^[a-z0-9_-]{1,63}$/
const PACKAGE_PART = /^[a-z][a-z0-9_]*$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6_GROUP = /^[0-9a-f]{1,4}$/

/**
 * Normalize a miniapp URL, or answer null when it isn't one: lowercase the scheme and host, drop the default port and
 * a trailing dot, and end the path in `/`. Credentials, a query and a fragment are refused. A public URL must be
 * HTTPS; a local-network URL ({@link isLocalNetworkHost}) may be HTTP or HTTPS.
 */
export function normalizeMiniappUrl(input: string): NormalizedMiniappUrl | null {
  const parsed = parseHttpUrl(input)
  if (!parsed) return null
  // Any `?` or `#` starts a query or a fragment, even an empty one.
  if (/[?#]/.test(input)) return null
  const kind: MiniappHostKind = isLocalCanonicalHost(parsed.host) ? "local" : "public"
  if (kind === "public" && parsed.url.protocol !== "https:") return null
  const port = parsed.url.port ? `:${parsed.url.port}` : ""
  const path = parsed.url.pathname.endsWith("/") ? parsed.url.pathname : `${parsed.url.pathname}/`
  return {url: `${parsed.url.protocol}//${parsed.host}${port}${path}`, host: parsed.host, kind}
}

/**
 * The registrable domain of a host, from the Public Suffix List: `notes.example.com` is `example.com`, and
 * `alice.github.io` is itself. Null for a public suffix, an IP address, a local-network name, a suffix the list
 * doesn't know, `.arpa`, or anything that isn't a hostname.
 */
export function registrableDomain(host: string): string | null {
  const canonical = canonicalHost(host)
  return canonical ? registrableDomainOf(canonical) : null
}

/**
 * The package-name prefix a host's domain owns: its reversed registrable domain, with each hyphen as an underscore
 * (`notes.my-site.com` is `com.my_site`). Null when the host has no registrable domain, or when the domain can't map
 * to package-name parts: a label that starts with a digit, or one with an underscore, which could collide with a
 * mapped hyphen.
 */
export function packagePrefixForHost(host: string): string | null {
  const canonical = canonicalHost(host)
  return canonical ? packagePrefixOf(canonical) : null
}

/**
 * The domain rule: whether a miniapp URL may serve this package name. The name must start with the prefix its host's
 * domain owns ({@link packagePrefixForHost}) plus at least one more part, and `com.mentra.*` is served only from
 * mentraglass.com. Only the host decides, so this also checks where a redirect ended, query and all. A URL that isn't
 * public HTTPS serves no name: a local-network address has no domain to own one.
 */
export function isPackageNameAllowedForUrl(packageName: string, url: string): boolean {
  if (typeof packageName !== "string" || !MINIAPP_PACKAGE_NAME_PATTERN.test(packageName)) return false
  const parsed = parseHttpUrl(url)
  if (!parsed || parsed.url.protocol !== "https:" || isLocalCanonicalHost(parsed.host)) return false
  const prefix = packagePrefixOf(parsed.host)
  if (!prefix) return false
  if (packageName.startsWith(MENTRA_PACKAGE_PREFIX)) return prefix === MENTRA_DOMAIN_PREFIX
  return packageName.startsWith(`${prefix}.`)
}

/**
 * Whether a host is on the local network: `localhost` and `*.localhost`, `*.local` names, and loopback, private,
 * link-local and shared (100.64.0.0/10) IPv4 addresses, and loopback, unique local and link-local IPv6 addresses,
 * including IPv4 addresses mapped into IPv6. Takes a hostname, with or without IPv6 brackets.
 */
export function isLocalNetworkHost(host: string): boolean {
  const canonical = canonicalHost(host)
  return canonical !== null && isLocalCanonicalHost(canonical)
}

/** Parse an absolute HTTP or HTTPS URL without credentials, the same way on every runtime. */
function parseHttpUrl(input: string): {url: URL; host: string} | null {
  if (typeof input !== "string") return null
  const value = input.trim()
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null
  // URL parsers differ on non-ASCII and on backslashes, so neither is accepted.
  if (!PRINTABLE_ASCII.test(value) || value.includes("\\")) return null
  const authority = SCHEME_AND_AUTHORITY.exec(value)
  if (!authority || authority[1]!.includes("@")) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  const host = canonicalHostname(url.hostname)
  return host ? {url, host} : null
}

/** A hostname given on its own, canonicalized as a URL's would be: `127.1` is `127.0.0.1`. */
function canonicalHost(host: string): string | null {
  if (typeof host !== "string" || !HOST_CHARACTERS.test(host)) return null
  const candidate = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  let url: URL
  try {
    url = new URL(`http://${candidate}/`)
  } catch {
    return null
  }
  // A port, or anything else that isn't part of the hostname.
  if (url.host !== url.hostname) return null
  return canonicalHostname(url.hostname)
}

/** A URL's hostname, lowercase, without a trailing dot, and with each label checked. */
function canonicalHostname(hostname: string): string | null {
  let host = hostname.toLowerCase()
  if (host.startsWith("[")) return host.endsWith("]") && parseIpv6(host.slice(1, -1)) ? host : null
  if (host.endsWith(".")) host = host.slice(0, -1)
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null
  if (IPV4.test(host)) return parseIpv4(host) ? host : null
  const valid = host
    .split(".")
    .every((label) => HOST_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"))
  return valid ? host : null
}

function isLocalCanonicalHost(host: string): boolean {
  if (host.startsWith("[")) {
    const words = parseIpv6(host.slice(1, -1))
    return words !== null && isLocalIpv6(words)
  }
  const ipv4 = parseIpv4(host)
  if (ipv4) return isLocalIpv4(ipv4)
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
}

function registrableDomainOf(host: string): string | null {
  if (host.startsWith("[") || parseIpv4(host) || isLocalCanonicalHost(host)) return null
  const parsed = parseDomain(host, {allowPrivateDomains: true})
  if (parsed.hostname !== host || !parsed.domain || !parsed.publicSuffix) return null
  // A suffix the list doesn't know matches only its implicit `*` rule; nobody owns names under it.
  if (!parsed.isIcann && !parsed.isPrivate) return null
  if (parsed.publicSuffix === "arpa" || parsed.publicSuffix.endsWith(".arpa")) return null
  return parsed.domain
}

function packagePrefixOf(host: string): string | null {
  const domain = registrableDomainOf(host)
  if (!domain) return null
  const parts: string[] = []
  for (const label of domain.split(".").reverse()) {
    if (label.includes("_")) return null
    const part = label.replace(/-/g, "_")
    if (!PACKAGE_PART.test(part)) return null
    parts.push(part)
  }
  return parts.join(".")
}

function parseIpv4(text: string): number[] | null {
  const match = IPV4.exec(text)
  if (!match) return null
  const octets = match.slice(1).map((octet) => (/^(0|[1-9]\d*)$/.test(octet!) ? Number(octet) : 256))
  return octets.every((octet) => octet <= 255) ? octets : null
}

function isLocalIpv4([a, b]: number[]): boolean {
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b! >= 64 && b! <= 127)
  )
}

/** Eight 16-bit words, from an IPv6 address without brackets. */
function parseIpv6(text: string): number[] | null {
  const halves = text.toLowerCase().split("::")
  if (halves.length > 2) return null
  const compressed = halves.length === 2
  const head = parseIpv6Groups(halves[0]!, !compressed)
  const tail = compressed ? parseIpv6Groups(halves[1]!, true) : []
  if (!head || !tail) return null
  if (!compressed) return head.length === 8 ? head : null
  const missing = 8 - head.length - tail.length
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null
}

/** IPv6 groups; the last group of the address may be a dotted IPv4 address. */
function parseIpv6Groups(part: string, endsAddress: boolean): number[] | null {
  if (part === "") return []
  const groups = part.split(":")
  const words: number[] = []
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!
    if (endsAddress && index === groups.length - 1 && group.includes(".")) {
      const ipv4 = parseIpv4(group)
      if (!ipv4) return null
      words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!)
    } else if (IPV6_GROUP.test(group)) {
      words.push(parseInt(group, 16))
    } else {
      return null
    }
  }
  return words
}

function isLocalIpv6(words: number[]): boolean {
  const first = words[0]!
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  const isUniqueLocal = (first & 0xfe00) === 0xfc00
  const isLinkLocal = (first & 0xffc0) === 0xfe80
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  if (isMappedIpv4) return isLocalIpv4([words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff])
  return isLoopback || isUniqueLocal || isLinkLocal
}

/** SemVer 2.0.0 (semver.org): `1.4.2`, `1.4.2-beta.1`; not `v1.4.2` or `1.4`. The `version` of a served `miniapp.json`. */
export const MINIAPP_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** What a miniapp URL serves at `<url>/miniapp.json`: the manifest inside its current ZIP, plus `bundle`. */
export interface ServedMiniappManifest {
  packageName: string
  version: string
  name: string
  description?: string
  /** Relative to the miniapp URL, or an absolute URL. */
  icon?: string
  /** Absent: the Mentra App's own rating, so the miniapp is never age-gated. */
  ageRating?: MiniappAgeRating
  sdkVersion?: string
  minHostVersion?: string
  hardwareRequirements?: Array<{type: string; level: string; description?: string}>
  /** The directory's listing; the phone ignores it, so it isn't checked here. */
  listing?: unknown
  /** The ZIP: its URL, relative to the miniapp URL or absolute, and its SHA-256, in lowercase hex. */
  bundle: {url: string; sha256: string}
}

const NonBlankString = z.string().refine((value) => value.trim().length > 0, "must not be blank")

/**
 * The served `miniapp.json`. Fields this schema doesn't name, such as `entry` and `permissions`, are kept as served;
 * the engine checks them in the ZIP's own copy when it installs.
 */
export const ServedMiniappManifestSchema: z.ZodType<ServedMiniappManifest> = z
  .object({
    packageName: z.string().regex(MINIAPP_PACKAGE_NAME_PATTERN),
    version: z.string().regex(MINIAPP_VERSION_PATTERN),
    name: NonBlankString,
    description: z.string().optional(),
    icon: NonBlankString.optional(),
    ageRating: z.enum(MINIAPP_AGE_RATINGS).optional(),
    sdkVersion: NonBlankString.optional(),
    minHostVersion: NonBlankString.optional(),
    hardwareRequirements: z
      .array(z.object({type: z.string(), level: z.string(), description: z.string().optional()}).passthrough())
      .optional(),
    listing: z.unknown(),
    bundle: z
      .object({
        url: NonBlankString,
        sha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .transform((sha256) => sha256.toLowerCase()),
      })
      .passthrough(),
  })
  .passthrough()
