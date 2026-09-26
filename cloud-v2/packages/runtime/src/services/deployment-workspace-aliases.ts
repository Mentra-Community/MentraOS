/** Explicit aliases only: forwarded/request hostnames never authorize a new origin. */
export function parseWorkspaceAliases(raw: string | undefined): string[] {
  const aliases: unknown = JSON.parse(raw?.trim() || "[]");
  if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string")) {
    throw new Error("DEPLOYMENT_WORKSPACE_ALIASES must be a JSON array of HTTPS origins");
  }
  return aliases.map((alias: string) => {
    const url = new URL(alias);
    if (url.protocol !== "https:" || url.origin !== alias.replace(/\/$/, "")) {
      throw new Error("DEPLOYMENT_WORKSPACE_ALIASES must contain HTTPS origins without paths or credentials");
    }
    return url.origin;
  });
}

/** Precompute origin-consistent discovery responses while retaining Core/auth identity. */
export function createWorkspaceManifestAliases(body: string, aliases: string[]): Map<string, string> {
  const responses = new Map<string, string>();
  if (aliases.length === 0) return responses;
  const original = JSON.parse(body);
  const canonical = new URL(original.services.runtimeUrl).origin;

  for (const origin of parseWorkspaceAliases(JSON.stringify(aliases))) {
    const manifest = JSON.parse(body);
    const rebase = (value: unknown): unknown => {
      if (typeof value === "string" && (value === canonical || value.startsWith(canonical + "/"))) {
        return origin + value.slice(canonical.length);
      }
      if (Array.isArray(value)) return value.map(rebase);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)]));
      }
      return value;
    };
    manifest.services.runtimeUrl = rebase(manifest.services.runtimeUrl);
    for (const key of ["branding", "links", "artifacts", "content"] as const) {
      if (manifest[key]) manifest[key] = rebase(manifest[key]);
    }
    for (const miniapp of manifest.miniapps?.managed ?? []) {
      miniapp.bundleUrl = rebase(miniapp.bundleUrl);
    }
    responses.set(new URL(origin).host, JSON.stringify(manifest) + "\n");
  }
  return responses;
}
