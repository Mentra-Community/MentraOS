/** Mentra's own packages: `com.mentra.*` counts as `com.mentraglass.*`. */
function isMentraPackage(packageName: string): boolean {
  return packageName.startsWith("com.mentra.") || packageName.startsWith("com.mentraglass.")
}

function isMentraHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === "mentraglass.com" || host.endsWith(".mentraglass.com")
}

/**
 * The domain rule: a package name may only come from a domain that owns it.
 * Mentra's packages come only from mentraglass.com hosts. Other names need the
 * Public Suffix List to find their registrable domain; they arrive with URL
 * installs, so until then nothing else updates from a URL.
 */
export function isPackageNameAllowedForUrl(packageName: string, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  return isMentraPackage(packageName) && isMentraHost(parsed.hostname)
}
