import {engine} from "@mentra/engine"
import {appRegistry} from "@mentra/engine-host-internal"

import {checkPermissionsUI} from "@/utils/PermissionsUtils"

/** One authoring request replaces only its named package using the normal installer. */
export async function loadAuthoringMiniapp(link: string) {
  const request = new URL(link)
  if (request.protocol !== "com.mentra:" || request.hostname !== "test" || request.pathname !== "/load-miniapp") {
    throw new Error("Expected a Mentra miniapp authoring link")
  }
  const single = (key: string) => {
    const values = request.searchParams.getAll(key)
    if (values.length !== 1 || !values[0]) throw new Error(`One ${key} is required`)
    return values[0]
  }
  const packageName = single("package"),
    version = single("version"),
    bundleUrl = single("url")
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(packageName) || !/^[a-zA-Z0-9._+-]+$/.test(version)) {
    throw new Error("Invalid miniapp package or version")
  }
  const source = new URL(bundleUrl)
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw new Error("Miniapp bundle must use an HTTP(S) URL without credentials")
  }
  await engine.miniapps.stop(packageName)
  const installed = await appRegistry.installFromUrl(bundleUrl, {
    expectedPackageName: packageName,
    expectedVersion: version,
  })
  if (installed.is_error()) throw installed.error
  await engine.miniapps.refresh()
  const app = engine.miniapps.list().find((item) => item.packageName === packageName)
  if (!app) throw new Error("Installed miniapp is missing from the registry")
  const missing = await checkPermissionsUI(app)
  if (missing.length) throw new Error(`Miniapp needs permissions: ${missing.join(", ")}`)
  if (!(await engine.miniapps.start(app, {skipNavigation: true}))) throw new Error("Miniapp launch was refused")
  await engine.miniapps.setForeground(packageName)
  return {packageName, version}
}
