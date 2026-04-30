import composer from "@/services/Composer"
import {storage} from "@/utils/storage/storage"

export interface DevMiniappSnapshotInput {
  packageName: string
  devUrl: string
  devPort?: number | string
  keep?: number
}

export function persistDevMiniappLaunch({packageName, devUrl, devPort}: DevMiniappSnapshotInput): void {
  storage.save(`${packageName}_dev_url`, devUrl)
  const port = parseDevPort(devPort)
  if (port !== null) {
    storage.save(`${packageName}_dev_port`, port)
  }
}

export async function installDevMiniappSnapshot(input: DevMiniappSnapshotInput): Promise<boolean> {
  persistDevMiniappLaunch(input)

  const port = parseDevPort(input.devPort)
  if (port === null) return false

  const sidecarBase = buildSidecarBaseUrl(input.devUrl, port)
  if (!sidecarBase) return false

  const res = await composer.installMiniApp(`${sidecarBase}/__mentra_dev/bundle.zip`, {
    versionOverride: `dev-${Date.now()}`,
  })
  if (res.is_error()) throw res.error

  composer.gcDevVersions(input.packageName, input.keep ?? 2)
  return true
}

export function inferDevSidecarPort(devUrl: string): number | null {
  try {
    const url = new URL(devUrl)
    const port = parseInt(url.port, 10)
    if (!Number.isFinite(port)) return null
    return port + 1
  } catch {
    return null
  }
}

export function parseDevPort(devPort: number | string | undefined): number | null {
  if (typeof devPort === "number") {
    return Number.isFinite(devPort) ? devPort : null
  }
  if (typeof devPort === "string") {
    const port = parseInt(devPort, 10)
    return Number.isFinite(port) ? port : null
  }
  return null
}

function buildSidecarBaseUrl(devUrl: string, sidecarPort: number): string | null {
  try {
    const url = new URL(devUrl)
    return `${url.protocol}//${url.hostname}:${sidecarPort}`
  } catch {
    return null
  }
}
