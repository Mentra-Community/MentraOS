import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {join} from "node:path"

import {parseCanonicalBundleManifest} from "../cloud-v2/packages/core/src/services/miniapps/bundle-manifest"
import {validateInstallBundleArchive} from "../mobile/modules/engine/src/services/validateInstallBundle"

const assets = join(import.meta.dir, "..", "mobile", "assets", "miniapps")
const bundles = readdirSync(assets)
  .filter((name) => name.endsWith(".zip"))
  .sort()

describe("bundled miniapp publisher signatures", () => {
  test.each(bundles)("%s is accepted identically by Core and the Mentra App", async (name) => {
    const bytes = new Uint8Array(readFileSync(join(assets, name)))
    const core = await parseCanonicalBundleManifest(bytes)
    const host = await validateInstallBundleArchive(bytes, {requirePublisherSignature: true})

    expect(host.packageName).toBe(core.packageName)
    expect(host.version).toBe(core.version)
    expect(host.publisherKeyFingerprint).toBe(core.publisherKeyFingerprint)
  })
})
