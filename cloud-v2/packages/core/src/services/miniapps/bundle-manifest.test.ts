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
    const leadingZero = { ...manifest, version: "1.0.0-01" };
    await expect(parseCanonicalBundleManifest(await bundle(leadingZero), leadingZero)).rejects.toMatchObject({
      code: "invalid_version",
    } satisfies Partial<BundleManifestError>);
  });

  test("rejects permissions outside the public manifest schema", async () => {
    for (const permissions of [
      { type: "MICROPHONE" },
      ["MICROPHONE"],
      [{ type: "SYSTEM" }],
      [{ type: "MICROPHONE", required: "yes" }],
    ]) {
      const invalid = { ...manifest, permissions };
      await expect(parseCanonicalBundleManifest(await bundle(invalid), invalid)).rejects.toMatchObject({
        code: "invalid_manifest_permissions",
      } satisfies Partial<BundleManifestError>);
    }
  });

  test("rejects duplicate raw ZIP records", async () => {
    const archive = await bundle(manifest, zip => {
      zip.file("one.txt", "one");
      zip.file("two.txt", "two");
    });
    patchCentralName(archive, "two.txt", "one.txt");
    await expect(parseCanonicalBundleManifest(archive)).rejects.toMatchObject({
      code: "invalid_bundle",
      message: expect.stringContaining("duplicate path"),
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

  test("bounds inflation before checking a forged expanded size", async () => {
    const archive = await bundle(manifest, zip => zip.file("bomb.txt", "x".repeat(2 * 1024 * 1024)));
    patchCentralUncompressedSize(archive, "bomb.txt", 1);

    await expect(parseCanonicalBundleManifest(archive)).rejects.toMatchObject({
      code: "invalid_bundle",
      message: expect.stringContaining("could not safely inflate bomb.txt"),
    } satisfies Partial<BundleManifestError>);
  });

  test("checks each entry CRC without an unbounded JSZip pre-inflation", async () => {
    const archive = await bundle();
    patchCentralCrc(archive, "background/index.js", 0);

    await expect(parseCanonicalBundleManifest(archive)).rejects.toMatchObject({
      code: "invalid_bundle",
      message: expect.stringContaining("CRC mismatch"),
    } satisfies Partial<BundleManifestError>);
  });
});

function patchCentralUncompressedSize(archive: Uint8Array, name: string, size: number): void {
  const offset = findCentralEntry(archive, name);
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(offset + 24, size, true);
}

function patchCentralCrc(archive: Uint8Array, name: string, crc: number): void {
  const offset = findCentralEntry(archive, name);
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(offset + 16, crc, true);
}

function findCentralEntry(archive: Uint8Array, expectedName: string): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    if (name === expectedName) return offset;
  }
  throw new Error(`central ZIP entry not found: ${expectedName}`);
}

function patchCentralName(archive: Uint8Array, expectedName: string, replacement: string): void {
  if (expectedName.length !== replacement.length) throw new Error("replacement ZIP name must have equal length");
  const offset = findCentralEntry(archive, expectedName);
  archive.set(new TextEncoder().encode(replacement), offset + 46);
}
