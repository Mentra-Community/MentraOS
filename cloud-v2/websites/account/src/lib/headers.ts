/** Hosted Supabase Auth. Used for the CSP when `SUPABASE_URL` is unset. */
export const DEFAULT_SUPABASE_URL = "https://auth.mentra.glass";

/** The origin of the Supabase project, the only cross-origin API this site calls. */
export function supabaseOrigin(supabaseUrl: string | undefined): string {
  const value = supabaseUrl?.trim() || DEFAULT_SUPABASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUPABASE_URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("SUPABASE_URL must be an absolute http(s) URL.");
  }
  return url.origin;
}

export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${supabaseOrigin(supabaseUrl)}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** Cloudflare Pages `_headers` file for the account site. */
export function buildHeadersFile(supabaseUrl: string | undefined): string {
  return [
    "/*",
    `  Content-Security-Policy: ${contentSecurityPolicy(supabaseUrl)}`,
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "",
    "/oauth/*",
    "  Cache-Control: no-store",
    "",
    "/signout",
    "  Cache-Control: no-store",
    "",
  ].join("\n");
}
