/** Device-facing REST client for the independently deployed Miniapp Store. */
import type {HttpClient} from "../../http"

export interface MiniappListing {
  packageName: string
  name: string
  version: string
  description?: string
  iconUrl?: string
}

export interface MiniappManifest {
  packageName: string
  name: string
  version: string
  permissions?: string[]
}

export interface MiniappBundle {
  downloadUrl: string
  version: string
  manifest: MiniappManifest
}

export type PreinstalledInstallPolicy = "install_once" | "keep_updated" | "mandatory"

export interface PreinstalledMiniappRegistryEntry {
  packageName: string
  version: string
  bundleUrl: string
  bundleSha256: string
  required: boolean
  installPolicy: PreinstalledInstallPolicy
  channel: string
  minMobileVersion?: string
  maxMobileVersion?: string
  tenantId?: string
}

export interface PreinstalledMiniappRegistry {
  generatedAt: string
  entries: PreinstalledMiniappRegistryEntry[]
}

export class Store {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<MiniappListing[]> {
    return this.http.get<MiniappListing[]>("/api/client/miniapps")
  }

  getBundle(packageName: string, version?: string): Promise<MiniappBundle> {
    const base = `/api/client/miniapps/${encodeURIComponent(packageName)}/bundle`
    const path = version === undefined ? base : `${base}?version=${encodeURIComponent(version)}`
    return this.http.get<MiniappBundle>(path)
  }

  getPreinstalledRegistry(opts?: {environment?: string}): Promise<PreinstalledMiniappRegistry> {
    const query = opts?.environment ? `?environment=${encodeURIComponent(opts.environment)}` : ""
    return this.http.get<PreinstalledMiniappRegistry>(`/api/client/miniapps/registry${query}`)
  }
}
