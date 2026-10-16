import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"

import JSZip from "jszip"

import {normalizeManifestActions} from "../manifestActions"
import {validateInstallBundleArchive} from "../validateInstallBundle"

// The Mentra App's own bundled ZIPs must pass the installer it ships.
const assets = fileURLToPath(new URL("../../../../../assets/miniapps/", import.meta.url))
const bundles = readdirSync(assets)
  .filter((name) => name.endsWith(".zip"))
  .sort()

describe("bundled miniapps", () => {
  test.each(bundles)("%s is accepted by the installer under its file name", async (name) => {
    const manifest = await validateInstallBundleArchive(new Uint8Array(readFileSync(assets + name)))
    expect(name).toBe(`${manifest.packageName}-${manifest.version}.zip`)
  })

  test("ships exactly one Store, whose update check is a host-only background action", async () => {
    const stores = bundles.filter((name) => name.startsWith("com.mentra.store-"))
    expect(stores).toHaveLength(1)
    const archive = await JSZip.loadAsync(readFileSync(assets + stores[0]))
    const manifest = JSON.parse(await archive.file("miniapp.json")!.async("string"))
    expect(
      normalizeManifestActions(manifest.actions).find((action) => action.id === "reconcile_updates"),
    ).toMatchObject({lifecycle: "transient", audience: "host"})
    expect(manifest.hardwareRequirements ?? []).toEqual([])
  })
})
