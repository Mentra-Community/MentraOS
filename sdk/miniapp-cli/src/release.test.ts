import {describe, expect, test} from "bun:test"
import JSZip from "jszip"

import {signBundleArchive} from "./bundle-signing"
import {generatePackageSigningKey, publisherKeyFingerprint} from "./package-signing-key"
import {isCachedReleaseBundleValid} from "./release"

describe("release cache", () => {
  test("accepts unsigned caches only for unsigned requests", async () => {
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName: "com.example.release", version: "1.0.0"}))
    const unsigned = await zip.generateAsync({type: "uint8array"})
    const key = generatePackageSigningKey("com.example.release")
    const signed = await signBundleArchive(unsigned, key)
    expect(await isCachedReleaseBundleValid(unsigned, "com.example.release", "1.0.0", null)).toBe(true)
    expect(await isCachedReleaseBundleValid(signed, "com.example.release", "1.0.0", null)).toBe(false)
    expect(
      await isCachedReleaseBundleValid(
        unsigned,
        "com.example.release",
        "1.0.0",
        publisherKeyFingerprint(key.publicKeyJwk),
      ),
    ).toBe(false)
    expect(await isCachedReleaseBundleValid(unsigned, "com.example.release", "2.0.0", null)).toBe(false)
    expect(await isCachedReleaseBundleValid(new Uint8Array([1, 2, 3]), "com.example.release", "1.0.0", null)).toBe(
      false,
    )
  })

  test("rejects a cached archive signed by a different requested key", async () => {
    const packageName = "com.example.release"
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName, version: "1.0.0"}))
    const cachedKey = generatePackageSigningKey(packageName)
    const requestedKey = generatePackageSigningKey(packageName)
    const cached = await signBundleArchive(await zip.generateAsync({type: "uint8array"}), cachedKey)

    await expect(
      isCachedReleaseBundleValid(cached, packageName, "1.0.0", publisherKeyFingerprint(requestedKey.publicKeyJwk)),
    ).resolves.toBe(false)
    await expect(
      isCachedReleaseBundleValid(cached, packageName, "1.0.0", publisherKeyFingerprint(cachedKey.publicKeyJwk)),
    ).resolves.toBe(true)
  })
})
