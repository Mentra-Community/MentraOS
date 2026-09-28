/** Shared by admin authorization and incident categorization. Read at use time. */
export function getAdminEmailAllowlist() {
  return {
    emails: parseList(process.env.CLOUD_CORE_ADMIN_EMAILS),
    domains: parseList(process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS).map(domain => domain.replace(/^@/, "")),
  };
}

export function isAdminEmail(email: string, allowlist = getAdminEmailAllowlist()): boolean {
  const normalized = email.trim().toLowerCase();
  return allowlist.emails.includes(normalized)
    || allowlist.domains.some(domain => normalized.endsWith(`@${domain}`));
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
}
