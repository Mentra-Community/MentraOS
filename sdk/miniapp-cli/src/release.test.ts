import {describe, expect, test} from "bun:test"
import {spawnSync} from "node:child_process"
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import JSZip from "jszip"

import {signBundleArchive} from "./bundle-signing"
import {generatePackageSigningKey, publisherKeyFingerprint} from "./package-signing-key"
import {isCachedReleaseBundleValid} from "./release"

describe("release cache", () => {
  test("explicit signing fails without a key even when an unsigned cache is fresh", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentra-release-sign-"))
    try {
      const manifest = {
        packageName: "com.example.release",
        version: "1.0.0",
        name: "Fixture",
        permissions: [],
        hardwareRequirements: [],
      }
      writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(manifest))
      const runner = join(cwd, "check.ts")
      writeFileSync(
        runner,
        `
        import {writeFileSync} from "node:fs";
        import {release} from ${JSON.stringify(new URL("./release.ts", import.meta.url).pathname)};
        Object.defineProperty(Bun, "secrets", {value: {get: async () => null}});
        Object.defineProperty(Bun, "serve", {value: () => {throw new Error("must not serve an unsigned cache")}});
        try { await release({sign: true}); }
        catch (error) { writeFileSync(${JSON.stringify(join(cwd, "error.txt"))}, String(error)); }
      `,
      )
      mkdirSync(join(cwd, "build"))
      const zip = new JSZip()
      zip.file("miniapp.json", JSON.stringify(manifest))
      writeFileSync(join(cwd, "build/com.example.release-1.0.0.zip"), await zip.generateAsync({type: "uint8array"}))
      const result = spawnSync(process.execPath, [runner], {
        cwd,
        timeout: 5000,
        encoding: "utf8",
        env: {
          ...process.env,
          MENTRA_CLI_HOME: join(cwd, "keys"),
          MENTRA_MINIAPP_SIGNING_KEY_FILE: "",
          MENTRA_MINIAPP_SIGNING_KEY_JSON: "",
        },
      })
      expect(result.status).toBe(0)
      expect(readFileSync(join(cwd, "error.txt"), "utf8")).toContain("No publisher signing key exists")
    } finally {
      rmSync(cwd, {recursive: true, force: true})
    }
  })

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
