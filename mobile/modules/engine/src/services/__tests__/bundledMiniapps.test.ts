import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"

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

  test("ships no Store miniapp: the engine updates each miniapp from its own URL", () => {
    expect(bundles.filter((name) => name.startsWith("com.mentra.store-"))).toEqual([])
  })
})
