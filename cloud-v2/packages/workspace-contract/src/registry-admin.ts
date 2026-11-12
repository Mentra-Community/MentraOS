/**
 * The admin portal's miniapp registry (`/api/admin/registry`, Core's `docs/registry.md`): every miniapp URL the
 * Mentra App has installed, for Organization Admins, who archive entries and register URLs themselves. It needs
 * `organization.registry.administer`, which only an Organization Admin holds: no operator key carries it.
 *
 * An archive rule names a URL, a package name, a registrable domain or the account that first registered entries.
 * It archives the entries it covers and refuses the URLs registered after it. Archiving refuses installs and stops
 * updates; installed copies keep running. Times are ISO 8601 UTC.
 */

/** What an archive rule names: a miniapp URL, a package name, a registrable domain, or an account (a Mentra user id). */
export const ADMIN_REGISTRY_RULE_KINDS = ["url", "package", "domain", "account"] as const
export type AdminRegistryRuleKind = (typeof ADMIN_REGISTRY_RULE_KINDS)[number]

/** An archive rule. Core normalizes `value` (a URL ends in `/`, a domain is lowercase) and answers with its form. */
export interface AdminRegistryRule {
  kind: AdminRegistryRuleKind
  value: string
}

/** An archive rule as Core keeps it: why, and who made it (an Organization Admin's email, or a service and its actor). */
export interface AdminRegistryRuleView extends AdminRegistryRule {
  reason: string
  createdBy: string
  createdAt: string
}

/** `verified`: Core read the URL's `miniapp.json` itself. `phone_reported`: Core couldn't, so it holds a phone's report. */
export type AdminRegistryVerification = "verified" | "phone_reported"

/** One registry entry, as an Organization Admin sees it: nothing is redacted. */
export interface AdminRegistryEntryView {
  /** The normalized miniapp URL: the entry's key. */
  url: string
  packageName: string
  registrableDomain: string
  /** Null when Core knows only the package name (a private server that refused Core's token). */
  name: string | null
  version: string | null
  ageRating: string | null
  /** The manifest's icon, an absolute HTTPS URL on the developer's host. Core never fetches it. */
  iconUrl: string | null
  verification: AdminRegistryVerification
  /** Its server asks for sign-in. */
  private: boolean
  /** `archived` when the entry's own status is, or an archive rule covers it. */
  status: "active" | "archived"
  /** The kinds of the archive rules that cover it, in `ADMIN_REGISTRY_RULE_KINDS` order; empty when none does. */
  archivedBy: AdminRegistryRuleKind[]
  firstRegisteredAt: string
  /** The Mentra user id of the account that first registered it: the value of an `account` rule. */
  firstRegisteredBy: string
  /** Null when Core has never read it. */
  lastVerifiedAt: string | null
}

/** The `status` filter of `GET /api/admin/registry/entries`. */
export const ADMIN_REGISTRY_STATUSES = ["active", "archived"] as const
/** The `verification` filter of `GET /api/admin/registry/entries`. */
export const ADMIN_REGISTRY_VERIFICATIONS = ["verified", "phone_reported"] as const

/** The longest search text, in characters. */
export const ADMIN_REGISTRY_QUERY_MAX_LENGTH = 200

/**
 * Response of `GET /api/admin/registry/entries?q=&status=&verification=&cursor=`: a page of entries, most recently
 * registered first. `next` is the `cursor` of the page after this one, or null on the last page.
 */
export interface AdminRegistryEntriesResponse {
  items: AdminRegistryEntryView[]
  next: string | null
}

/** Response of `GET /api/admin/registry/rules?cursor=`: archive rules, newest first. */
export interface AdminRegistryRulesResponse {
  items: AdminRegistryRuleView[]
  next: string | null
}

/**
 * Response of `GET /api/admin/registry/coverage?kind=&value=`, asked before archiving: the rule in Core's form, how
 * many entries it covers today and how many of those are active, and whether the rule exists already.
 */
export interface AdminRegistryCoverage {
  rule: AdminRegistryRule
  entries: number
  activeEntries: number
  exists: boolean
}

/** `POST /api/admin/registry/archive` with `{rule, reason?}`. */
export interface AdminRegistryArchiveRequest {
  rule: AdminRegistryRule
  /** Shown with the rule. At most `ADMIN_REGISTRY_REASON_MAX_LENGTH` characters. */
  reason?: string
}

/** The longest archive reason, in characters. */
export const ADMIN_REGISTRY_REASON_MAX_LENGTH = 500

/** The answer to an archive: `created` is false for a rule that existed (its reason and author stay). */
export interface AdminRegistryArchiveResponse {
  rule: AdminRegistryRule
  created: boolean
  entriesArchived: number
}

/** The answer to `POST /api/admin/registry/unarchive` with `{rule}`: entries no other rule covers are active again. */
export interface AdminRegistryUnarchiveResponse {
  rule: AdminRegistryRule
  removed: boolean
  entriesRestored: number
}

/** The most URLs one `POST /api/admin/registry/register` may name. */
export const ADMIN_REGISTRY_REGISTER_MAX_URLS = 50

/**
 * What registering one URL came to, as a phone's registration would, with the Organization Admin as the person
 * registering it:
 * - `accepted`: Core read a valid `miniapp.json` whose package passes the domain rule;
 * - `accepted_unverified`: a private server that refused the admin's token, or a URL Core already holds that it
 *   couldn't read this time;
 * - `not_a_miniapp`, with `reason`;
 * - `unreachable`: Core couldn't read the URL and holds no report of it, so nothing was recorded;
 * - `archived`: an archive rule covers it;
 * - `invalid_url`: not a miniapp URL at all;
 * - `failed`: Core couldn't finish; nothing changed that a retry wouldn't redo.
 */
export type AdminRegistryRegisterOutcome =
  | "accepted"
  | "accepted_unverified"
  | "not_a_miniapp"
  | "unreachable"
  | "archived"
  | "invalid_url"
  | "failed"

export interface AdminRegistryRegisterResult {
  /** The URL as it was sent. */
  input: string
  result: AdminRegistryRegisterOutcome
  /** The normalized URL, for `accepted` and `accepted_unverified`. */
  url?: string
  /** For `not_a_miniapp`: `invalid_manifest`, `domain_mismatch`, `not_https` or `local_network_url`. */
  reason?: string
  /** For `accepted` and `accepted_unverified`. */
  packageName?: string
  name?: string | null
}

/** Response of `POST /api/admin/registry/register` with `{urls}`: one result per distinct URL, in order. */
export interface AdminRegistryRegisterResponse {
  results: AdminRegistryRegisterResult[]
}
