import { createHash } from "node:crypto";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Canonical SemVer 2.0.0 (`MAJOR.MINOR.PATCH[-prerelease]`), no `v` prefix, no
 * build metadata allowed, no leading zeroes in numeric identifiers. Mirrors the client's
 * `semver.valid(value) === value` check so both sides agree on release identity.
 */
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface DeploymentMiniappBundle {
  path: string;
  body: Blob;
}

export async function loadDeploymentMiniappBundles(
  deploymentManifest: string | undefined,
  configuredDirectory = process.env.DEPLOYMENT_MANAGED_MINIAPP_DIR,
): Promise<DeploymentMiniappBundle[]> {
  const directory = configuredDirectory?.trim();
  if (!directory || !deploymentManifest) return [];

  const raw = JSON.parse(deploymentManifest) as {
    services?: { runtimeUrl?: unknown };
    miniapps?: {
      managed?: Array<{
        packageName?: unknown;
        version?: unknown;
        bundleUrl?: unknown;
        sha256?: unknown;
      }>;
    };
  };
  const entries = raw.miniapps?.managed ?? [];
  if (entries.length === 0) return [];

  // Bundles are served by this Runtime, so every bundleUrl must resolve to the
  // manifest's Runtime origin over HTTPS. Anything else would be advertised to
  // clients but never served here.
  const runtimeUrl = raw.services?.runtimeUrl;
  if (typeof runtimeUrl !== "string") {
    throw new Error(
      "deployment managed miniapps require services.runtimeUrl in the manifest",
    );
  }
  const runtimeOrigin = new URL(runtimeUrl).origin;

  const bundles: DeploymentMiniappBundle[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (
      typeof entry.packageName !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.bundleUrl !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("deployment managed miniapp entry is invalid");
    }
    if (!STRICT_SEMVER.test(entry.version)) {
      throw new Error(
        `deployment managed miniapp version must be canonical SemVer: ${entry.packageName}@${entry.version}`,
      );
    }
    const url = new URL(entry.bundleUrl);
    if (url.protocol !== "https:") {
      throw new Error(
        `deployment managed miniapp URL must use https: ${entry.bundleUrl}`,
      );
    }
    if (url.origin !== runtimeOrigin) {
      throw new Error(
        `deployment managed miniapp URL must share the Runtime origin ${runtimeOrigin}: ${entry.bundleUrl}`,
      );
    }
    if (!url.pathname.startsWith("/miniapps/") || url.pathname.endsWith("/")) {
      throw new Error(
        `deployment managed miniapp URL must be under /miniapps/: ${entry.bundleUrl}`,
      );
    }
    const fileName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (
      !fileName ||
      fileName.includes("/") ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw new Error(
        `deployment managed miniapp URL has no safe filename: ${entry.bundleUrl}`,
      );
    }
    if (paths.has(url.pathname)) {
      throw new Error(
        `deployment managed miniapp path is duplicated: ${url.pathname}`,
      );
    }

    const file = Bun.file(`${directory.replace(/\/+$/, "")}/${fileName}`);
    if (!(await file.exists())) {
      throw new Error(
        `deployment managed miniapp file does not exist: ${fileName}`,
      );
    }
    if (file.size > MAX_BUNDLE_BYTES) {
      throw new Error(`deployment managed miniapp exceeds 64 MiB: ${fileName}`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("deployment managed miniapps exceed 256 MiB total");
    }
    const actualSha256 = createHash("sha256")
      .update(await file.bytes())
      .digest("hex");
    if (actualSha256 !== entry.sha256.toLowerCase()) {
      throw new Error(
        `deployment managed miniapp SHA-256 mismatch for ${entry.packageName}@${entry.version}`,
      );
    }
    paths.add(url.pathname);
    // Retain the lazy file handle, not every ZIP's bytes, after validation.
    bundles.push({ path: url.pathname, body: file });
  }
  return bundles;
}
