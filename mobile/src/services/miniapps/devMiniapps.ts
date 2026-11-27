import {engine} from "@mentra/engine"
import {appRegistry} from "@mentra/engine-host-internal"

import {devMachineHost} from "@/utils/cloudClient/devHost"

const withoutSlash = (url: string) => url.replace(/\/+$/, "")

/**
 * The miniapps a debug build started by `bun start`, `bun android` or `bun ios` gets from the developer's computer
 * (scripts/local-miniapps.mjs: `<packageName>@<port>,…`), each at its dev server on the host this bundle came from.
 */
function servedDevMiniapps(): {packageName: string; url: string}[] {
  const served: string | undefined = process.env.EXPO_PUBLIC_DEV_MINIAPPS
  const host = devMachineHost()
  if (!__DEV__ || !served || !host) return []
  return served.split(",").map((entry) => {
    const at = entry.lastIndexOf("@")
    return {packageName: entry.slice(0, at), url: `http://${host}:${entry.slice(at + 1)}/`}
  })
}

/**
 * Whether the package's build is the one its dev server serves, as a debug build installs it: a local build installed
 * from that server's address, which updates from it on every open and every save (`miniappUrlUpdates.ts`).
 */
export function runsDevMiniapp(packageName: string): boolean {
  const served = servedDevMiniapps().find((app) => app.packageName === packageName)
  if (!served) return false
  const version = engine.miniapps.list().find((app) => app.packageName === packageName)?.version
  const identity = version?.startsWith("dev-") ? appRegistry.getReleaseIdentity(packageName, version) : null
  return identity?.source === "local" && !!identity.sourceUrl && withoutSlash(identity.sourceUrl) === withoutSlash(served.url)
}

/**
 * Install the package from its dev server, as a local build that updates on every save, unless it runs from there
 * already. False when this build serves no such miniapp, or it didn't install.
 */
export async function installDevMiniapp(packageName: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  const served = servedDevMiniapps().find((app) => app.packageName === packageName)
  if (!served) return false
  if (runsDevMiniapp(packageName)) return true
  try {
    await engine.miniapps.install(served.url, {source: "local", isCancelled: () => !isCurrent()})
    return true
  } catch (error) {
    if (isCurrent()) console.warn(`MANTLE: could not install the dev miniapp at ${served.url}`, error)
    return false
  }
}

/** Install every miniapp served to this debug build. Stops once `isCurrent` turns false. */
export async function installDevMiniapps(isCurrent: () => boolean): Promise<void> {
  for (const {packageName} of servedDevMiniapps()) {
    if (!isCurrent()) return
    await installDevMiniapp(packageName, isCurrent)
  }
}
