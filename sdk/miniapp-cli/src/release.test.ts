import {describe, expect, test} from "bun:test"
import JSZip from "jszip"

import {signBundleArchive} from "./bundle-signing"
import {generatePackageSigningKey, publisherKeyFingerprint} from "./package-signing-key"
import {isCachedReleaseBundleValid} from "./release"

describe("release cache", () => {
  test("rejects a cached archive signed by a different requested key", async () => {
    const packageName = "com.example.release"
    const zip = new JSZip()
    zip.file("miniapp.json", JSON.stringify({packageName, version: "1.0.0"}))
    const cachedKey = generatePackageSigningKey(packageName)
    const requestedKey = generatePackageSigningKey(packageName)
    const cached = await signBundleArchive(await zip.generateAsync({type: "uint8array"}), cachedKey)

    await expect(
      isCachedReleaseBundleValid(
        cached,
        packageName,
        "1.0.0",
        publisherKeyFingerprint(requestedKey.publicKeyJwk),
      ),
    ).resolves.toBe(false)
    await expect(
      isCachedReleaseBundleValid(
        cached,
        packageName,
        "1.0.0",
        publisherKeyFingerprint(cachedKey.publicKeyJwk),
      ),
    ).resolves.toBe(true)
  })
})
