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
      sdkVersion: "0.3.0",
      minHostVersion: "2.13.0",
      hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}],
      entry: {background: "background/index.js"},
    })
    await expect(
      validateInstallBundleArchive(bytes, {packageName: "com.example.app", version: "1.0.0"}),
    ).resolves.toEqual({
      packageName: "com.example.app",
      version: "1.0.0",
      sdkVersion: "0.3.0",
      minHostVersion: "2.13.0",
      hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}],
    })
    await expect(validateInstallBundleArchive(bytes, {packageName: "com.example.other"})).rejects.toThrow(
      "package mismatch",
    )
  })

  test("rejects malformed hardware requirements before native extraction", async () => {
    await expect(
      validateInstallBundleArchive(
        await bundle({
          packageName: "com.example.app",
          version: "1.0.0",
          hardwareRequirements: [{type: "CAMERA", level: "MAYBE"}],
        }),
      ),
    ).rejects.toThrow("hardwareRequirements[0].level")
  })

  test("rejects permissions outside the public manifest schema", async () => {
    for (const permissions of [
      {type: "MICROPHONE"},
      ["MICROPHONE"],
      [{type: "SYSTEM"}],
      [{type: "MICROPHONE", description: false}],
    ]) {
      await expect(
        validateInstallBundleArchive(
          await bundle({packageName: "com.example.app", version: "1.0.0", permissions}),
        ),
      ).rejects.toThrow("permissions")
    }
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
    await expect(
      validateInstallBundleArchive(await bundle({packageName: "com.example.app", version: "1.0.0-01"})),
    ).rejects.toThrow("invalid semantic version")
  })

  test("rejects parent traversal in a raw ZIP entry name", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    zip.file("../escape.js", "nope")
    await expect(validateInstallBundleArchive(await zip.generateAsync({type: "uint8array"}))).rejects.toThrow(
      "unsafe path",
    )
  })

  test("rejects duplicate raw ZIP records before JSZip can collapse them", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    zip.file("one.txt", "one")
    zip.file("two.txt", "two")
    const bytes = await zip.generateAsync({type: "uint8array"})
    patchCentralName(bytes, "two.txt", "one.txt")
    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("duplicate path")
  })

  test("rejects symbolic links before native extraction", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    zip.file("linked.js", "../outside.js", {unixPermissions: 0o120777})
    const bytes = await zip.generateAsync({type: "uint8array", platform: "UNIX"})
    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("symbolic link")
  })

  test("bounds inflation before checking a forged expanded size", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.app", version: "1.0.0"}))
    zip.file("bomb.txt", "x".repeat(2 * 1024 * 1024))
    const bytes = await zip.generateAsync({type: "uint8array"})
    patchCentralField(bytes, "bomb.txt", 24, 1)

    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("declared limit")
  })

  test("checks CRC while streaming within the host expansion limit", async () => {
    const bytes = await bundle({packageName: "com.example.app", version: "1.0.0"})
    patchCentralField(bytes, "background/index.js", 16, 0)

    await expect(validateInstallBundleArchive(bytes)).rejects.toThrow("CRC mismatch")
  })
})

function patchCentralField(archive: Uint8Array, expectedName: string, fieldOffset: number, value: number): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    if (name !== expectedName) continue
    view.setUint32(offset + fieldOffset, value, true)
    return
  }
  throw new Error(`central ZIP entry not found: ${expectedName}`)
}

function patchCentralName(archive: Uint8Array, expectedName: string, replacement: string): void {
  if (expectedName.length !== replacement.length) throw new Error("replacement ZIP name must have equal length")
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 46
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLength))
    if (name !== expectedName) continue
    archive.set(new TextEncoder().encode(replacement), nameStart)
    return
  }
  throw new Error(`central ZIP entry not found: ${expectedName}`)
}
