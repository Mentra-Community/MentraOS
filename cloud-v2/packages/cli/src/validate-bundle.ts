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
  const manifests = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith("miniapp.json"),
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
      if (path !== undefined && (typeof path !== "string" || !zip.files[path] || zip.files[path].dir)) {
        throw new Error(`Packed miniapp.json entry.${key} is missing from the ZIP`);
      }
    }
  }
  return manifest;
}
