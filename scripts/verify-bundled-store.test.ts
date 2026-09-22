import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {join} from "node:path"

import {validateInstallBundleArchive} from "../mobile/modules/engine/src/services/validateInstallBundle"

const assets = join(import.meta.dir, "..", "mobile", "assets", "miniapps")
const bundles = readdirSync(assets)
  .filter((name) => name.endsWith(".zip"))
  .sort()

describe("bundled miniapp compatibility", () => {
  test("ships exactly one pinned Store artifact", () => expect(bundles.filter((name) => name.startsWith("com.mentra.store-"))).toHaveLength(1))

  test.each(bundles)("%s is accepted by the Mentra App", async (name) => {
    const bytes = new Uint8Array(readFileSync(join(assets, name)))
    const host = await validateInstallBundleArchive(bytes)

    expect(host.packageName).toBeTruthy()
    expect(name).toBe(`${host.packageName}-${host.version}.zip`)
  })
})
