export interface StoreRelease {
  id: string
  version: string
  bundleUrl: string
  bundleSha256: string
  manifestSha256: string | null
  publishedAt: string | null
  permissions: Array<string | {type: string; required?: boolean; description?: string}>
  hardwareRequirements: Array<{type: string; level?: string; description?: string}>
  minHostVersion: string | null
  sdkVersion: string | null
}

export interface StoreApp {
  packageName: string
  name: string
  subtitle: string | null
  description: string | null
  categories: string[]
  privacyPolicyUrl: string | null
  supportUrl: string | null
  websiteUrl: string | null
  reviewTier: "community" | "verified"
  featured: boolean
  iconUrl: string | null
  coverUrl: string | null
  screenshotUrls: string[]
  release: StoreRelease
}

export interface InstalledApp {
  packageName: string
  name: string
  version: string
  running: boolean
  compatibility: {isCompatible: boolean; warnings: string[]}
}

export interface StoreSnapshot {
  apps: StoreApp[]
  installed: InstalledApp[]
  loading: boolean
  offline: boolean
  error: string | null
  operation: {
    packageName: string
    kind: "install" | "uninstall" | "open"
    phase?: "downloading" | "verifying" | "extracting" | "activating" | "complete"
  } | null
  refreshedAt: number | null
}
