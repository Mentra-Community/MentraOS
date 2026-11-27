import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"
import {engine, SETTINGS} from "@mentra/engine"

import {checkPermissionsUI} from "@/utils/PermissionsUtils"

let loading = false

/**
 * The Super Mode authoring link scripts and the lab send (`com.mentra://test/load-miniapp?url=<miniapp URL>`, from
 * `scripts/load-authoring-miniapp.mjs`): install the miniapp a local address serves, as scanning that address does
 * but without the install sheet, and open it. It installs as a development build, which updates from that address.
 * Overlapping requests are refused.
 */
export async function loadAuthoringMiniapp(link: string): Promise<{packageName: string; version: string}> {
  if (loading) throw new Error("A miniapp replacement is already in progress")
  loading = true
  try {
    return await installAndOpen(link)
  } finally {
    loading = false
  }
}

async function installAndOpen(link: string): Promise<{packageName: string; version: string}> {
  if (engine.settings.get(SETTINGS.super_mode.key) !== true)
    throw new Error("Enable Super Mode to load a miniapp from a script")
  const request = new URL(link)
  if (request.protocol !== "com.mentra:" || request.hostname !== "test" || request.pathname !== "/load-miniapp") {
    throw new Error("Expected a Mentra miniapp authoring link")
  }
  const urls = request.searchParams.getAll("url")
  if (urls.length !== 1 || !urls[0]) throw new Error("One url is required")
  const target = normalizeMiniappUrl(urls[0])
  if (target?.kind !== "local") throw new Error("The authoring link names a miniapp URL at a local address")
  // Installed over a running copy, the miniapp restarts on the new build; installed already, it stays as it is.
  const {packageName, version} = await engine.miniapps.install(target.url, {source: "local"})
  await engine.miniapps.refresh()
  const app = engine.miniapps.list().find((item) => item.packageName === packageName)
  if (!app) throw new Error("Installed miniapp is missing from the registry")
  // Nobody is there to answer a permission question: what the miniapp needs must be granted already.
  const missing = await checkPermissionsUI(app)
  if (missing.length) throw new Error(`Miniapp needs permissions: ${missing.join(", ")}`)
  if (!app.running && !(await engine.miniapps.start(app, {skipNavigation: true})))
    throw new Error("Miniapp launch was refused")
  await engine.miniapps.setForeground(packageName)
  return {packageName, version}
}
