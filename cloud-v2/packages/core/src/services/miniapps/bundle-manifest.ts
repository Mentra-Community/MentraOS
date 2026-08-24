import JSZip from "jszip";
import { canonicalJson } from "./developer-signing.service";
import { sha256Hex } from "../storage/storage.service";

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface CanonicalBundleManifest {
  manifest: Record<string, unknown>;
  manifestSha256: string;
  packageName: string;
  version: string;
}

/**
 * Parse the manifest that the phone will execute from a release ZIP.
 *
 * The root miniapp.json is the only accepted identity source. The caller may
 * provide upload metadata for compatibility with existing clients, but it must
 * be byte-semantically equal after canonical JSON serialization.
 */
export async function parseCanonicalBundleManifest(
  bundle: Uint8Array,
  submittedManifest?: Record<string, unknown>,
): Promise<CanonicalBundleManifest> {
  if (bundle.byteLength === 0 || bundle.byteLength > MAX_BUNDLE_BYTES) {
    throw new BundleManifestError("invalid_bundle_size", `bundle must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes`);
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bundle, { checkCRC32: true });
  } catch (error) {
    throw new BundleManifestError("invalid_bundle", `bundle is not a valid ZIP archive: ${errorMessage(error)}`);
  }

  const entries = Object.values(archive.files);
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) {
    throw new BundleManifestError(
      "invalid_bundle_entries",
      `bundle must contain between 1 and ${MAX_ZIP_ENTRIES} entries`,
    );
  }

  let expandedBytes = 0;
  for (const entry of entries) {
    const originalName = unsafeOriginalName(entry) ?? entry.name;
    if (!isSafeZipPath(originalName) || !isSafeZipPath(entry.name)) {
      throw new BundleManifestError("unsafe_bundle_path", `bundle contains an unsafe path: ${originalName}`);
    }
    if (isSymlink(entry)) {
      throw new BundleManifestError("unsafe_bundle_path", `bundle contains a symbolic link: ${originalName}`);
    }
    expandedBytes += uncompressedSize(entry);
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new BundleManifestError("bundle_expands_too_large", `bundle expands beyond ${MAX_EXPANDED_BYTES} bytes`);
    }
  }

  const manifestEntries = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith("miniapp.json"));
  if (manifestEntries.length !== 1 || manifestEntries[0]?.name !== "miniapp.json") {
    throw new BundleManifestError(
      "invalid_manifest_location",
      "bundle must contain exactly one miniapp.json at the ZIP root",
    );
  }

  let manifestText: string;
  try {
    manifestText = await manifestEntries[0].async("string");
  } catch (error) {
    throw new BundleManifestError("invalid_manifest", `could not read miniapp.json: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(manifestText, "utf8") > MAX_MANIFEST_BYTES) {
    throw new BundleManifestError("manifest_too_large", `miniapp.json exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestText) as unknown;
    if (!isRecord(parsed)) throw new Error("manifest must be a JSON object");
    manifest = parsed;
  } catch (error) {
    throw new BundleManifestError("invalid_manifest", `miniapp.json is invalid: ${errorMessage(error)}`);
  }

  const packageName = requiredString(manifest, "packageName").toLowerCase();
  if (!PACKAGE_NAME_PATTERN.test(packageName) || packageName !== manifest.packageName) {
    throw new BundleManifestError(
      "invalid_package_name",
      "miniapp.json packageName must be lowercase reverse-DNS text",
    );
  }
  const version = requiredString(manifest, "version");
  if (!VERSION_PATTERN.test(version)) {
    throw new BundleManifestError("invalid_version", "miniapp.json version must be valid semantic version text");
  }
  requiredString(manifest, "name");
  validateManifestEntries(archive, manifest);

  if (submittedManifest && canonicalJson(submittedManifest) !== canonicalJson(manifest)) {
    throw new BundleManifestError(
      "manifest_mismatch",
      "submitted manifest does not match the bundle's root miniapp.json",
    );
  }

  return {
    manifest,
    manifestSha256: sha256Hex(Buffer.from(canonicalJson(manifest))),
    packageName,
    version,
  };
}

export class BundleManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BundleManifestError";
  }
}

function validateManifestEntries(archive: JSZip, manifest: Record<string, unknown>): void {
  if (manifest.entry === undefined) return;
  if (!isRecord(manifest.entry)) {
    throw new BundleManifestError("invalid_manifest_entry", "miniapp.json entry must be an object");
  }
  const background = requiredString(manifest.entry, "background");
  validateEntryPath(archive, "background", background);
  if (manifest.entry.ui !== undefined) {
    validateEntryPath(archive, "ui", requiredString(manifest.entry, "ui"));
  }
}

function validateEntryPath(archive: JSZip, label: string, path: string): void {
  if (!isSafeZipPath(path) || path.endsWith("/")) {
    throw new BundleManifestError(
      "invalid_manifest_entry",
      `miniapp.json entry.${label} must be a safe relative file path`,
    );
  }
  const entry = archive.files[path];
  if (!entry || entry.dir) {
    throw new BundleManifestError(
      "missing_manifest_entry",
      `miniapp.json entry.${label} points at missing bundle file "${path}"`,
    );
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BundleManifestError("invalid_manifest", `miniapp.json ${key} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeZipPath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) return false;
  const pieces = path.split("/");
  return !pieces.some((piece) => piece === ".." || (piece === "" && pieces.length > 1 && pieces.at(-1) !== ""));
}

function unsafeOriginalName(entry: JSZip.JSZipObject): string | undefined {
  return (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
}

function uncompressedSize(entry: JSZip.JSZipObject): number {
  const data = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
  return Number.isFinite(data?.uncompressedSize) ? Math.max(0, data?.uncompressedSize ?? 0) : 0;
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  return typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
