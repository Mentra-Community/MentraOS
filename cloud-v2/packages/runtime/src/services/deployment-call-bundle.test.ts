import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {fileURLToPath} from "node:url"
import {inflateRawSync} from "node:zlib"

import {loadDeploymentMiniappBundles} from "./deployment-miniapps"

/** The text of one file in a ZIP, read from its central directory. */
function readZipEntry(zip: Uint8Array, name: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = zip.byteLength - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error("not a ZIP: no end of central directory")
  let offset = view.getUint32(end + 16, true)
  for (let index = view.getUint16(end + 10, true); index > 0; index--) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("corrupt ZIP central directory")
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const entryName = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength))
    if (entryName === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = zip.subarray(start, start + size)
      if (method === 0) return new TextDecoder().decode(data)
      if (method === 8) return new TextDecoder().decode(inflateRawSync(data))
      throw new Error(`unsupported ZIP compression method ${method}`)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`${name} is not in the ZIP`)
}

test("the reference Runtime serves the Call bundle it ships, as pinned in the manifest", async () => {
  const reference = new URL("../../../../deploy/azure/enterprise-reference/", import.meta.url)
  const manifestFile = Bun.file(new URL("mentra-deployment.json", reference))
  const manifest = await manifestFile.json()
  const entry = manifest.miniapps.managed.find((app: {packageName: string}) => app.packageName === "com.mentra.call")
  expect(entry).toBeDefined()

  // The pin names the ZIP the reference ships: same file, same bytes, same package and version.
  const fileName = `com.mentra.call-${entry.version}.zip`
  expect(new URL(entry.bundleUrl).pathname).toBe(`/miniapps/${fileName}`)
  const shipped = new Uint8Array(await Bun.file(new URL(`miniapps/${fileName}`, reference)).arrayBuffer())
  expect(createHash("sha256").update(shipped).digest("hex")).toBe(entry.sha256)
  expect(JSON.parse(readZipEntry(shipped, "miniapp.json"))).toMatchObject({
    packageName: entry.packageName,
    version: entry.version,
  })

  const bundles = await loadDeploymentMiniappBundles(
    await manifestFile.text(),
    fileURLToPath(new URL("miniapps/", reference)),
  )
  const bundle = bundles.find((bundle) => bundle.path === new URL(entry.bundleUrl).pathname)
  expect(bundle).toBeDefined()
  expect(new Uint8Array(await bundle!.body.arrayBuffer())).toEqual(shipped)
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
