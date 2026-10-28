/** The workspace portal this admin build links to, or null when it is not configured. */
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

export const WORKSPACE_PORTAL_URL = workspacePortalUrl(process.env.PORTAL_URL);
