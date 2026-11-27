import {result as Res, type AsyncResult} from "typesafe-ts"

import {assertMiniappDevelopmentAllowed} from "../runtime/bootstrap"
import {installLocalBuild} from "./localBuildInstall"

/**
 * Explicit release QR installation (`miniapp://release?url=...`, from an older CLI's `mentra release`, whose server
 * serves `miniapp.json` without naming its ZIP). The archive must match the manifest the release server shows.
 * Nothing checks its package name against a domain, so it is a developer's build of that name whatever address
 * serves it: it installs as a local build (see `localBuildInstall.ts`), beside any installed release of the name,
 * with its own data and tokens marked as a local build's. It is a fixed build: its server names no build to update
 * to, so it records no address to update from. Today's CLI prints a plain miniapp URL instead, which installs and
 * updates like any other; this goes one release after the rest of the old development path.
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
    await installLocalBuild(`${trimmed}/bundle.zip`, {packageName, version})
    return {packageName, version, name}
  })
}
