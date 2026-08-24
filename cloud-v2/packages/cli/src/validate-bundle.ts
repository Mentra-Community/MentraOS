import JSZip from "jszip";
import { canonicalJson } from "./signing";

export async function validatePackedBundle(
  bundle: Uint8Array,
  submittedManifest: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bundle, { checkCRC32: true });
  } catch {
    throw new Error("Packed release is not a valid ZIP archive");
  }
  for (const entry of Object.values(zip.files)) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (!isSafeBundlePath(originalName, entry.dir) || !isSafeBundlePath(entry.name, entry.dir)) {
      throw new Error(`Packed release contains an unsafe path: ${originalName}`);
    }
    if (!entry.dir && isSymlink(entry)) {
      throw new Error(`Packed release contains a symbolic link: ${entry.name}`);
    }
  }
  const manifests = Object.values(zip.files).filter(
    entry => !entry.dir && entry.name.toLowerCase().endsWith("miniapp.json"),
  );
  if (manifests.length !== 1 || manifests[0]?.name !== "miniapp.json") {
    throw new Error("Packed release must contain exactly one root miniapp.json");
  }
  const parsed = JSON.parse(await manifests[0].async("string")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Packed miniapp.json must be a JSON object");
  }
  const manifest = parsed as Record<string, unknown>;
  if (canonicalJson(manifest) !== canonicalJson(submittedManifest)) {
    throw new Error("Packed miniapp.json does not match the project manifest");
  }
  const entry = manifest.entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    for (const key of ["background", "ui"] as const) {
      const path = (entry as Record<string, unknown>)[key];
      if (typeof path === "string" && !isSafeBundlePath(path)) {
        throw new Error(`Packed miniapp.json entry.${key} contains an unsafe path`);
      }
      if (path !== undefined && (typeof path !== "string" || !zip.files[path] || zip.files[path].dir)) {
        throw new Error(`Packed miniapp.json entry.${key} is missing from the ZIP`);
      }
    }
  }
  return manifest;
}

function isSafeBundlePath(path: string, directory = false): boolean {
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    normalized.length > 0 &&
    !normalized.includes("\\") &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    normalized.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const mode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  return (mode & 0o170000) === 0o120000;
}
