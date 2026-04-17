/**
 * updates.ts
 *
 * SDK update notification messages and dist-tag utilities.
 *
 * Previously used boxen-bordered ASCII art banners. Now returns plain
 * single-line strings that the clean transport formats with color/prefix.
 *
 * The clean logger renders this as:
 *   MentraOS  ⚠ SDK update available: 2.1.29 → 2.1.30 — bun install @mentra/sdk@latest
 *   MentraOS  ⚠ SDK update available: 3.0.0-hono.4 → 3.0.0-hono.5 — bun install @mentra/sdk@hono
 */

/**
 * Known npm dist-tags for @mentra/sdk.
 * Used to parse the current version's prerelease identifier into a dist-tag,
 * and to validate the tag before sending it to the cloud API.
 */
const KNOWN_DIST_TAGS = ["alpha", "beta", "hono", "rc", "canary", "next"] as const;

/**
 * Determine the npm dist-tag (release track) from a semver version string.
 *
 * Parses the prerelease identifier:
 *   "2.1.29"          → "latest"  (no prerelease)
 *   "2.1.31-beta.5"   → "beta"
 *   "3.0.0-hono.4"    → "hono"
 *   "2.1.2-alpha.0"   → "alpha"
 *   "4.0.0-rc.1"      → "rc"
 *   "1.0.0-unknown.1" → "latest"  (unrecognized prerelease falls back to latest)
 *
 * @param version - The installed SDK version string
 * @returns The dist-tag name (e.g., "latest", "beta", "hono")
 */
export function getDistTag(version: string): string {
  const pattern = new RegExp(`-(${KNOWN_DIST_TAGS.join("|")})`);
  const match = version.match(pattern);
  return match ? match[1] : "latest";
}

/**
 * Generate a single-line SDK update notification message.
 *
 * The install command uses the correct dist-tag so developers on non-latest
 * tracks (beta, hono, etc.) aren't told to install @latest which would
 * downgrade/brick their app.
 *
 * @param currentVersion - The currently installed SDK version
 * @param latestVersion - The latest available SDK version for this track
 * @param tag - The npm dist-tag for the install command (default: "latest")
 * @returns A plain string suitable for `logger.warn()`
 */
export const newSDKUpdate = (currentVersion: string, latestVersion: string, tag: string = "latest"): string => {
  return `SDK update available: ${currentVersion} → ${latestVersion} — bun install @mentra/sdk@${tag}`;
};
