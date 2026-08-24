/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import JSZip from "jszip"
import {validateInstallBundleArchive} from "../validateInstallBundle"

async function bundle(manifest: Record<string, unknown>) {
  const zip = new JSZip()
  zip.file("miniapp.json", JSON.stringify(manifest))
  zip.file("background/index.js", "export {}")
  return zip.generateAsync({type: "uint8array"})
}

describe("validateInstallBundleArchive", () => {
  test("binds the ZIP to the Store's expected identity", async () => {
    const bytes = await bundle({
      packageName: "com.example.app",
      version: "1.0.0",
      entry: {background: "background/index.js"},
    })
    await expect(
      validateInstallBundleArchive(bytes, {packageName: "com.example.app", version: "1.0.0"}),
    ).resolves.toEqual({packageName: "com.example.app", version: "1.0.0"})
    await expect(validateInstallBundleArchive(bytes, {packageName: "com.example.other"})).rejects.toThrow(
      "package mismatch",
    )
  })

  test("rejects a nested manifest", async () => {
    const zip = new JSZip()
    zip.file("nested/miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    await expect(validateInstallBundleArchive(await zip.generateAsync({type: "uint8array"}))).rejects.toThrow(
      "root miniapp.json",
    )
  })

  test("rejects a manifest whose entry is absent", async () => {
    const bytes = await bundle({packageName: "com.example.app", version: "1.0.0", entry: {background: "missing.js"}})
    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("invalid or missing")
  })

  test("rejects filesystem identities and non-semantic versions", async () => {
    await expect(
      validateInstallBundleArchive(await bundle({packageName: "../escape", version: "1.0.0"})),
    ).rejects.toThrow("invalid packageName")
    await expect(
      validateInstallBundleArchive(await bundle({packageName: "com.example.app", version: "latest"})),
    ).rejects.toThrow("invalid semantic version")
  })

  test("rejects symbolic links before native extraction", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    zip.file("linked.js", "../outside.js", {unixPermissions: 0o120777})
    const bytes = await zip.generateAsync({type: "uint8array", platform: "UNIX"})
    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("symbolic link")
  })
})
