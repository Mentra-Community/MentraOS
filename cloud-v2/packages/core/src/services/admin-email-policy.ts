/** Shared by admin authorization and incident categorization. Read at use time. */
export function getAdminEmailAllowlist() {
  return {
    emails: parseList(process.env.CLOUD_CORE_ADMIN_EMAILS),
    domains: parseList(process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS).map(domain => domain.replace(/^@/, "")),
  };
}

export function isAdminEmail(email: string, allowlist = getAdminEmailAllowlist()): boolean {
  const normalized = email.trim().toLowerCase();
  const [local, domain, ...extra] = normalized.split("@");
  if (!local || !domain || extra.length || /\s/.test(normalized)) return false;
  const plus = local.indexOf("+");
  // Only the submitted address loses its tag. An explicitly allowlisted tagged
  // address must not grant access to its base mailbox or sibling tags.
  const base = plus > 0 && plus < local.length - 1 ? `${local.slice(0, plus)}@${domain}` : normalized;
  return allowlist.emails.includes(normalized)
    || allowlist.emails.includes(base)
    || allowlist.domains.includes(domain);
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
}
