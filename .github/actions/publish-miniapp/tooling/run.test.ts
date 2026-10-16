import {expect, test} from "bun:test"
import JSZip from "jszip"
import {canonicalBundle} from "./run"
const manifest = {packageName: "com.mentra.fixture", name: "Fixture", version: "1.0.0"}
test("ZIP timestamps and insertion order do not change uploaded bytes", async () => {
  const first = await new JSZip().file("miniapp.json", JSON.stringify(manifest), {date: new Date()}).file("ui/index.html", "hello").generateAsync({type: "uint8array"})
  const second = await new JSZip().file("ui/index.html", "hello", {date: new Date(0)}).file("miniapp.json", JSON.stringify(manifest)).generateAsync({type: "uint8array"})
  const canonical = await canonicalBundle(first, manifest)
  expect(Buffer.from(canonical)).toEqual(Buffer.from(await canonicalBundle(second, manifest)))
  expect(Buffer.from(canonical)).toEqual(Buffer.from(await canonicalBundle(canonical, manifest)))
})
test("stale manifests and signature envelopes are rejected without signing anything", async () => {
  const zip = new JSZip().file("miniapp.json", JSON.stringify(manifest))
  await expect(canonicalBundle(await zip.generateAsync({type: "uint8array"}), {...manifest, version: "2.0.0"})).rejects.toThrow("differs")
  zip.file("META-INF/MENTRA.SIG", "not a valid signature")
  await expect(canonicalBundle(await zip.generateAsync({type: "uint8array"}), manifest)).rejects.toThrow()
})
