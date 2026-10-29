import {result as Res, type AsyncResult} from "typesafe-ts"

import {assertMiniappDevelopmentAllowed} from "../runtime/bootstrap"
import {installMiniappRelease} from "./miniappReleaseInstall"

/**
 * Explicit release QR installation (`miniapp://release?url=...`). The archive
 * must match the manifest the release server shows.
 */
export function installMiniappFromJsonUrl(
  baseUrl: string,
): AsyncResult<{packageName: string; version: string; name: string}, Error> {
  return Res.try_async(async () => {
    assertMiniappDevelopmentAllowed()
    const trimmed = baseUrl.replace(/\/$/, "")
    const manifestRes = await fetch(`${trimmed}/miniapp.json`)
    if (!manifestRes.ok) throw new Error(`Failed to fetch miniapp.json: ${manifestRes.status}`)
    const manifest = (await manifestRes.json()) as Record<string, unknown>
    const packageName = typeof manifest.packageName === "string" ? manifest.packageName.trim() : ""
    const version = typeof manifest.version === "string" ? manifest.version.trim() : ""
    if (!packageName) throw new Error("miniapp.json missing packageName")
    if (!version) throw new Error("miniapp.json missing version")
    const name = typeof manifest.name === "string" ? manifest.name : packageName
    await installMiniappRelease(`${trimmed}/bundle.zip`, {
      expectedPackageName: packageName,
      expectedVersion: version,
      releaseIdentity: {source: "direct_download"},
    })
    return {packageName, version, name}
  })
}
