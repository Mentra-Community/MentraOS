import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { BundleManifestError, parseCanonicalBundleManifest } from "./bundle-manifest";

const manifest = {
  packageName: "com.example.weather",
  version: "1.0.0",
  name: "Weather",
  hardwareRequirements: [],
  entry: { background: "background/index.js", ui: "ui/index.html" },
};

async function bundle(value: Record<string, unknown> = manifest, extra?: (zip: JSZip) => void): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("miniapp.json", JSON.stringify(value));
  zip.file("background/index.js", "export {};");
  zip.file("ui/index.html", "<!doctype html>");
  extra?.(zip);
  return zip.generateAsync({ type: "uint8array" });
}

describe("parseCanonicalBundleManifest", () => {
  test("returns the root manifest as canonical identity", async () => {
    const parsed = await parseCanonicalBundleManifest(await bundle(), manifest);
    expect(parsed.packageName).toBe("com.example.weather");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects submitted metadata that differs from the ZIP manifest", async () => {
    await expect(
      parseCanonicalBundleManifest(await bundle(), { ...manifest, packageName: "com.example.other" }),
    ).rejects.toMatchObject({ code: "manifest_mismatch" } satisfies Partial<BundleManifestError>);
  });

  test("rejects a nested manifest", async () => {
    const zip = new JSZip();
    zip.file("nested/miniapp.json", JSON.stringify(manifest));
    await expect(parseCanonicalBundleManifest(await zip.generateAsync({ type: "uint8array" }))).rejects.toMatchObject({
      code: "invalid_manifest_location",
    } satisfies Partial<BundleManifestError>);
  });

  test("rejects missing entry files", async () => {
    const zip = new JSZip();
    zip.file("miniapp.json", JSON.stringify(manifest));
    await expect(parseCanonicalBundleManifest(await zip.generateAsync({ type: "uint8array" }))).rejects.toMatchObject({
      code: "missing_manifest_entry",
    } satisfies Partial<BundleManifestError>);
  });

  test("rejects unsafe manifest entry paths", async () => {
    const unsafe = { ...manifest, entry: { background: "../outside.js" } };
    await expect(parseCanonicalBundleManifest(await bundle(unsafe), unsafe)).rejects.toMatchObject({
      code: "invalid_manifest_entry",
    } satisfies Partial<BundleManifestError>);
  });

  test("rejects non-semantic release versions", async () => {
    const invalid = { ...manifest, version: "latest" };
    await expect(parseCanonicalBundleManifest(await bundle(invalid), invalid)).rejects.toMatchObject({
      code: "invalid_version",
    } satisfies Partial<BundleManifestError>);
  });

  test("rejects symbolic links before storage", async () => {
    const zip = new JSZip();
    zip.file("miniapp.json", JSON.stringify({ packageName: "com.example.app", version: "1.0.0", name: "App" }));
    zip.file("linked.js", "../outside.js", { unixPermissions: 0o120777 });
    await expect(
      parseCanonicalBundleManifest(await zip.generateAsync({ type: "uint8array", platform: "UNIX" })),
    ).rejects.toMatchObject({ code: "unsafe_bundle_path" } satisfies Partial<BundleManifestError>);
  });
});
