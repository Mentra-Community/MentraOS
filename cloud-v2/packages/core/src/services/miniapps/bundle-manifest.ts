import { createHash } from "node:crypto";
import semver from "semver";
import { canonicalJson } from "./developer-signing.service";
import { verifyZipArchive, type VerifiedZipEntry } from "./zip-archive";

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// Keep in sync with the public miniapp manifest schema in sdk/miniapp-cli.
// SYSTEM is host-derived and is intentionally not author-declarable.
const AUTHOR_DECLARABLE_PERMISSION_TYPES = new Set([
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
]);
const AUTHOR_DECLARABLE_HARDWARE_TYPES = new Set([
  "CAMERA",
  "DISPLAY",
  "MICROPHONE",
  "SPEAKER",
  "IMU",
  "BUTTON",
  "LIGHT",
  "WIFI",
]);
const HARDWARE_REQUIREMENT_LEVELS = new Set(["REQUIRED", "OPTIONAL"]);

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

  let entries: Map<string, VerifiedZipEntry>;
  try {
    entries = verifyZipArchive(bundle, {
      maxEntries: MAX_ZIP_ENTRIES,
      maxExpandedBytes: MAX_EXPANDED_BYTES,
      maxEntryBytes: name => (name === "miniapp.json" ? MAX_MANIFEST_BYTES : undefined),
      capture: name => name === "miniapp.json",
      validatePath: isSafeZipPath,
    });
  } catch (error) {
    const message = errorMessage(error);
    const code = message.includes("ZIP entry exceeds its configured limit: miniapp.json")
      ? "manifest_too_large"
      : message.includes("unsafe path") || message.includes("symbolic link")
        ? "unsafe_bundle_path"
        : message.includes("expands beyond")
          ? "bundle_expands_too_large"
          : message.includes("entry count")
            ? "invalid_bundle_entries"
            : "invalid_bundle";
    throw new BundleManifestError(code, `bundle is not a valid ZIP archive: ${message}`);
  }

  const manifestEntries = [...entries.values()].filter(
    entry => !entry.directory && entry.name.toLowerCase().endsWith("miniapp.json"),
  );
  if (manifestEntries.length !== 1 || manifestEntries[0]?.name !== "miniapp.json") {
    throw new BundleManifestError(
      "invalid_manifest_location",
      "bundle must contain exactly one miniapp.json at the ZIP root",
    );
  }

  const manifestBytes = manifestEntries[0].bytes;
  if (!manifestBytes) throw new BundleManifestError("invalid_manifest", "could not read miniapp.json");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new BundleManifestError("manifest_too_large", `miniapp.json exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  let manifest: Record<string, unknown>;
  try {
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
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
  if (!isValidSemanticVersion(version)) {
    throw new BundleManifestError("invalid_version", "miniapp.json version must be valid semantic version text");
  }
  requiredString(manifest, "name");
  validateOptionalSemanticVersion(manifest, "sdkVersion", "Mentra Miniapp SDK version");
  validateOptionalSemanticVersion(manifest, "minHostVersion", "minimum Mentra App version");
  validateManifestPermissions(manifest.permissions);
  validateManifestHardwareRequirements(manifest.hardwareRequirements);
  validateManifestEntries(entries, manifest);

  if (submittedManifest && canonicalJson(submittedManifest) !== canonicalJson(manifest)) {
    throw new BundleManifestError(
      "manifest_mismatch",
      "submitted manifest does not match the bundle's root miniapp.json",
    );
  }

  return {
    manifest,
    manifestSha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
    packageName,
    version,
  };
}

function validateOptionalSemanticVersion(
  manifest: Record<string, unknown>,
  key: "sdkVersion" | "minHostVersion",
  label: string,
): void {
  const value = manifest[key];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !semver.valid(semver.coerce(value))
  ) {
    throw new BundleManifestError("invalid_manifest_version_requirement", `miniapp.json ${label} is invalid`);
  }
}

function validateManifestHardwareRequirements(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new BundleManifestError(
      "invalid_manifest_hardware_requirements",
      "miniapp.json hardwareRequirements must be an array",
    );
  }
  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new BundleManifestError(
        "invalid_manifest_hardware_requirements",
        `miniapp.json hardwareRequirements[${index}] must be an object`,
      );
    }
    if (typeof candidate.type !== "string" || !AUTHOR_DECLARABLE_HARDWARE_TYPES.has(candidate.type)) {
      throw new BundleManifestError(
        "invalid_manifest_hardware_requirements",
        `miniapp.json hardwareRequirements[${index}].type is invalid`,
      );
    }
    if (typeof candidate.level !== "string" || !HARDWARE_REQUIREMENT_LEVELS.has(candidate.level)) {
      throw new BundleManifestError(
        "invalid_manifest_hardware_requirements",
        `miniapp.json hardwareRequirements[${index}].level is invalid`,
      );
    }
    if (candidate.description !== undefined && typeof candidate.description !== "string") {
      throw new BundleManifestError(
        "invalid_manifest_hardware_requirements",
        `miniapp.json hardwareRequirements[${index}].description must be a string`,
      );
    }
  });
}

function validateManifestPermissions(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new BundleManifestError("invalid_manifest_permissions", "miniapp.json permissions must be an array");
  }
  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new BundleManifestError(
        "invalid_manifest_permissions",
        `miniapp.json permissions[${index}] must be an object`,
      );
    }
    if (typeof candidate.type !== "string" || !AUTHOR_DECLARABLE_PERMISSION_TYPES.has(candidate.type)) {
      throw new BundleManifestError(
        "invalid_manifest_permissions",
        `miniapp.json permissions[${index}].type is invalid`,
      );
    }
    if (candidate.required !== undefined && typeof candidate.required !== "boolean") {
      throw new BundleManifestError(
        "invalid_manifest_permissions",
        `miniapp.json permissions[${index}].required must be a boolean`,
      );
    }
    if (candidate.description !== undefined && typeof candidate.description !== "string") {
      throw new BundleManifestError(
        "invalid_manifest_permissions",
        `miniapp.json permissions[${index}].description must be a string`,
      );
    }
  });
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

function validateManifestEntries(entries: Map<string, VerifiedZipEntry>, manifest: Record<string, unknown>): void {
  if (manifest.entry === undefined) return;
  if (!isRecord(manifest.entry)) {
    throw new BundleManifestError("invalid_manifest_entry", "miniapp.json entry must be an object");
  }
  const background = requiredString(manifest.entry, "background");
  validateEntryPath(entries, "background", background);
  if (manifest.entry.ui !== undefined) {
    validateEntryPath(entries, "ui", requiredString(manifest.entry, "ui"));
  }
}

function validateEntryPath(entries: Map<string, VerifiedZipEntry>, label: string, path: string): void {
  if (!isSafeZipPath(path) || path.endsWith("/")) {
    throw new BundleManifestError(
      "invalid_manifest_entry",
      `miniapp.json entry.${label} must be a safe relative file path`,
    );
  }
  const entry = entries.get(path);
  if (!entry || entry.directory) {
    throw new BundleManifestError(
      "missing_manifest_entry",
      `miniapp.json entry.${label} points at missing bundle file "${path}"`,
    );
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new BundleManifestError("invalid_manifest", `miniapp.json ${key} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSemanticVersion(value: string): boolean {
  if (!VERSION_PATTERN.test(value)) return false;
  const prerelease = value.split("+", 1)[0]?.split("-", 2)[1];
  return !prerelease
    ?.split(".")
    .some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0");
}

function isSafeZipPath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) return false;
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized.length > 0 && normalized.split("/").every(piece => piece !== "" && piece !== "." && piece !== "..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
