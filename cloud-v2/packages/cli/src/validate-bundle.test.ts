import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { generatePackageSigningKey, signBundleArchive } from "@mentra/miniapp-cli";
import { validatePackedBundle } from "./validate-bundle";

const manifest = {
  packageName: "com.example.app",
  version: "1.0.0",
  name: "Example",
  entry: { background: "background/index.js" },
};

async function bundle(value = manifest) {
  const zip = new JSZip();
  zip.file("miniapp.json", JSON.stringify(value));
  zip.file("background/index.js", "export {};");
  return zip.generateAsync({ type: "uint8array" });
}

describe("validatePackedBundle", () => {
  test("accepts an unsigned bundle with the exact canonical manifest", async () => {
    await expect(validatePackedBundle(await bundle(), manifest)).resolves.toEqual(manifest);
  });

  test("verifies an optional signature and rejects tampered signed contents", async () => {
    const signed = await signBundleArchive(await bundle(), generatePackageSigningKey(manifest.packageName));
    await expect(validatePackedBundle(signed, manifest)).resolves.toEqual(manifest);
    const zip = await JSZip.loadAsync(signed);
    zip.file("background/index.js", "changed");
    await expect(validatePackedBundle(await zip.generateAsync({type: "uint8array"}), manifest)).rejects.toThrow("does not match");
  });

  test("rejects a manifest mismatch", async () => {
    await expect(validatePackedBundle(await bundle(), { ...manifest, version: "2.0.0" })).rejects.toThrow(
      "does not match",
    );
  });

  test("rejects missing entry files", async () => {
    const zip = new JSZip();
    zip.file("miniapp.json", JSON.stringify(manifest));
    await expect(
      validatePackedBundle(
        await zip.generateAsync({ type: "uint8array" }),
        manifest,
      ),
    ).rejects.toThrow("missing");
  });

  test("rejects traversal entry paths", async () => {
    const unsafeManifest = { ...manifest, entry: { background: "../background/index.js" } };
    await expect(validatePackedBundle(await bundle(unsafeManifest), unsafeManifest)).rejects.toThrow("unsafe path");
  });

  test("rejects symbolic links", async () => {
    const zip = new JSZip();
    zip.file("miniapp.json", JSON.stringify(manifest));
    zip.file("background/index.js", "target", { unixPermissions: 0o120777 });
    await expect(
      validatePackedBundle(
        await zip.generateAsync({ type: "uint8array", platform: "UNIX" }),
        manifest,
      ),
    ).rejects.toThrow("symbolic link");
  });
});
