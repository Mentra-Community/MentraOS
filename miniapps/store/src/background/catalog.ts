import type {StoreApp} from "../shared/types"

export interface StoreCatalogPage {
  apps: StoreApp[]
  page: number
  hasMore: boolean
}

const MAX_CATALOG_PAGES = 200

export function parseCatalog(value: unknown): StoreApp[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as {apps?: unknown}).apps)) {
    throw new Error("Store catalog returned an invalid response")
  }
  return (value as {apps: unknown[]}).apps.filter(isStoreApp)
}

export function parseCatalogPage(value: unknown): StoreCatalogPage {
  const record = value as {page?: unknown; hasMore?: unknown}
  if (!Number.isInteger(record?.page) || Number(record.page) < 1 || typeof record?.hasMore !== "boolean") {
    throw new Error("Store catalog returned invalid pagination metadata")
  }
  return {apps: parseCatalog(value), page: Number(record.page), hasMore: record.hasMore}
}

export async function loadCompleteCatalog(
  fetchPage: (page: number) => Promise<unknown>,
  maxPages = MAX_CATALOG_PAGES,
): Promise<StoreApp[]> {
  const apps = new Map<string, StoreApp>()
  for (let requestedPage = 1; requestedPage <= maxPages; requestedPage += 1) {
    const page = parseCatalogPage(await fetchPage(requestedPage))
    if (page.page !== requestedPage) throw new Error("Store catalog returned an unexpected page")
    for (const app of page.apps) apps.set(app.packageName, app)
    if (!page.hasMore) return [...apps.values()]
  }
  throw new Error(`Store catalog exceeded the ${maxPages}-page safety limit`)
}

function isStoreApp(value: unknown): value is StoreApp {
  if (!value || typeof value !== "object") return false
  const app = value as Record<string, unknown>
  const release = app.release as Record<string, unknown> | undefined
  return (
    typeof app.packageName === "string" &&
    typeof app.name === "string" &&
    Boolean(release) &&
    typeof release?.id === "string" &&
    typeof release?.version === "string" &&
    typeof release?.bundleUrl === "string" &&
    typeof release?.bundleSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(release.bundleSha256)
  )
}

export function trustedCoreOrigin(value: string | null | undefined): string | null {
  try {
    if (!value) return null
    const url = new URL(value)
    if (url.username || url.password) return null
    if (url.protocol === "https:") return url.origin
    return url.protocol === "http:" && isPrivateDevelopmentHost(url.hostname) ? url.origin : null
  } catch {
    return null
  }
}

function isPrivateDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1") return true

  const ipv4 = host.split(".").map(Number)
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return (
      ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168)
    )
  }

  const firstIpv6Group = Number.parseInt(host.split(":", 1)[0] ?? "", 16)
  return (
    Number.isInteger(firstIpv6Group) &&
    ((firstIpv6Group & 0xfe00) === 0xfc00 || (firstIpv6Group & 0xffc0) === 0xfe80)
  )
}

/** True only when `candidate` is a strictly newer semantic version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseSemver(candidate)
  const installed = parseSemver(current)
  if (!next || !installed) return false
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifier(next.core[index]!, installed.core[index]!)
    if (comparison !== 0) return comparison > 0
  }
  if (next.prerelease.length === 0 || installed.prerelease.length === 0) {
    return next.prerelease.length === 0 && installed.prerelease.length > 0
  }
  const count = Math.max(next.prerelease.length, installed.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const left = next.prerelease[index]
    const right = installed.prerelease[index]
    if (left === right) continue
    if (left === undefined) return false
    if (right === undefined) return true
    const leftNumber = /^\d+$/.test(left) ? left : null
    const rightNumber = /^\d+$/.test(right) ? right : null
    if (leftNumber !== null && rightNumber !== null) return compareNumericIdentifier(leftNumber, rightNumber) > 0
    if (leftNumber !== null) return false
    if (rightNumber !== null) return true
    return left > right
  }
  return false
}

function parseSemver(value: string): {core: [string, string, string]; prerelease: string[]} | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match) return null
  const prerelease = match[4]?.split(".") ?? []
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0")) {
    return null
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease,
  }
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  return left === right ? 0 : left > right ? 1 : -1
}
