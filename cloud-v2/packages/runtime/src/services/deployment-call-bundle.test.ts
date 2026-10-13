import {expect, test} from "bun:test"
import {fileURLToPath} from "node:url"

import {loadDeploymentMiniappBundles} from "./deployment-miniapps"

test("the reference Runtime serves the exact Call bundle pinned in the manifest and bundled in mobile", async () => {
  const reference = new URL("../../../../deploy/azure/enterprise-reference/", import.meta.url)
  const manifestFile = Bun.file(new URL("mentra-deployment.json", reference))
  const manifest = await manifestFile.json()
  const entry = manifest.miniapps.managed.find((app: {packageName: string}) => app.packageName === "com.mentra.call")
  expect(entry).toBeDefined()
  const bundles = await loadDeploymentMiniappBundles(
    await manifestFile.text(),
    fileURLToPath(new URL("miniapps/", reference)),
  )
  const bundle = bundles.find((bundle) => bundle.path === new URL(entry.bundleUrl).pathname)
  expect(bundle).toBeDefined()
  const mobile = Bun.file(new URL(`../../../../../mobile/assets/miniapps/com.mentra.call-${entry.version}.zip`, import.meta.url))
  expect(await bundle!.body.arrayBuffer()).toEqual(await mobile.arrayBuffer())
})

test("the reference demo also serves the exact demo miniapps bundled in mobile", async () => {
  const reference = new URL("../../../../deploy/azure/enterprise-reference/", import.meta.url)
  const manifest = await Bun.file(new URL("mentra-deployment.json", reference)).json()
  const demo = await Bun.file(new URL("demo-miniapps.json", reference)).json()
  expect(demo.length).toBeGreaterThan(0)
  // The demo deployment appends these to the reference managed list.
  manifest.miniapps.managed = [...manifest.miniapps.managed, ...demo]
  const bundles = await loadDeploymentMiniappBundles(
    JSON.stringify(manifest),
    fileURLToPath(new URL("miniapps/", reference)),
  )
  for (const entry of demo) {
    const bundle = bundles.find((bundle) => bundle.path === new URL(entry.bundleUrl).pathname)
    expect(bundle).toBeDefined()
    const mobile = Bun.file(new URL(`../../../../../mobile/assets/miniapps/${entry.packageName}-${entry.version}.zip`, import.meta.url))
    expect(await bundle!.body.arrayBuffer()).toEqual(await mobile.arrayBuffer())
  }
})
