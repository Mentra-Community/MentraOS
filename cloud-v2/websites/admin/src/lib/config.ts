/**
 * The admin portal's public build-time configuration. build.ts replaces each `process.env.X` read here with
 * the value the build ran with. `scripts/deploy-pages.ts` sets it for each Mentra environment; a build without
 * it (a Private Cloud's, CI's or a local one) leaves it empty.
 */

/**
 * The workspace portal the admin portal links to, from `PORTAL_URL`: an absolute http(s) URL without a trailing
 * slash, or null when unset or unusable (then no link is shown).
 */
export function workspacePortalUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** This build's workspace portal, or null. */
export const WORKSPACE_PORTAL_URL = workspacePortalUrl(process.env.PORTAL_URL);

/** The Fleet Management overview of `workspaceId` in the workspace portal, or null where there is no portal. */
export function fleetOverviewUrl(portalUrl: string | null, workspaceId: string): string | null {
  return portalUrl ? `${portalUrl}/w/${encodeURIComponent(workspaceId)}/fleet?fleet=overview` : null;
}
