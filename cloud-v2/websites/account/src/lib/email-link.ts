/**
 * Supabase sends a person to the Site URL (this page's root) after an email
 * link when the request named no `redirect_to`: a Mentra App sign-up's
 * confirmation link does, until every Core sends one. Supabase reports the
 * outcome in the URL fragment: a session (`#access_token=…&type=signup`) or an
 * error (`#error=…&error_code=otp_expired`).
 *
 * The page shows the outcome and starts no session from it: the person signed
 * up for the Mentra App, not for this page.
 */
export type EmailLinkLanding = { kind: "verified" } | { kind: "failed" };

const VERIFIED_TYPES = new Set(["signup", "email_change", "invite"]);

export function readEmailLinkLanding(hash: string): EmailLinkLanding | null {
  if (!hash || hash === "#") return null;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (params.has("error") || params.has("error_code")) return { kind: "failed" };
  if (params.has("access_token") && VERIFIED_TYPES.has(params.get("type") ?? "")) return { kind: "verified" };
  return null;
}
