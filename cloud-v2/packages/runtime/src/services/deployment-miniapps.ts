import { createHash } from "node:crypto";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

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
    const url = new URL(entry.bundleUrl);
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
