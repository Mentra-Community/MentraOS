import type {StoreApp} from "../shared/types"

export function parseCatalog(value: unknown): StoreApp[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as {apps?: unknown}).apps)) {
    throw new Error("Store catalog returned an invalid response")
  }
  return (value as {apps: unknown[]}).apps.filter(isStoreApp)
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

export function coreOriginFromToken(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const parsed = JSON.parse(atob(normalized)) as {iss?: unknown}
    if (typeof parsed.iss !== "string") return null
    const url = new URL(parsed.iss)
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null
  } catch {
    return null
  }
}

/** True only when `candidate` is a strictly newer semantic version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseSemver(candidate)
  const installed = parseSemver(current)
  if (!next || !installed) return false
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== installed.core[index]) return next.core[index]! > installed.core[index]!
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
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber
    if (leftNumber !== null) return false
    if (rightNumber !== null) return true
    return left > right
  }
  return false
}

function parseSemver(value: string): {core: [number, number, number]; prerelease: string[]} | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    value,
  )
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  }
}
