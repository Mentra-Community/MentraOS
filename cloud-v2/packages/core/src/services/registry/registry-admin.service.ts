/**
 * @fileoverview The admin portal's view of the miniapp registry (`api/admin/registry.api.ts`): every entry,
 * unredacted, for Organization Admins; what an archive rule would cover; the rules; the CSV export; and
 * registering URLs as an Organization Admin. Archiving itself is `registry.service.ts`'s `archive` and `unarchive`.
 *
 * **Status.** An entry shows as archived when its own status is, or when an archive rule covers it; `archivedBy`
 * names the kinds of the rules that do. Archiving also sets the status of the entries a rule covers, which is what
 * the `status` filter reads.
 *
 * **Paging.** Most recently registered first, by `_id` (an entry is inserted when it is first registered), 50 at a
 * time. The cursor is the last `_id` of a page and the next page is everything older, so an entry registered
 * meanwhile never moves a row from one page to the next. The rules page the same way.
 *
 * **Search.** A query is plain text, trimmed, compared case-insensitively as a substring (never a pattern) of the
 * URL, the package name, the name or the registrable domain, or equal to the Mentra user id that first registered
 * the entry. It scans the entries rather than an index: the registry is read this way only by Organization Admins.
 *
 * **Registering.** An Organization Admin's URLs are registered exactly as a phone's registration (`registerMiniappUrl`),
 * with the admin as the person registering: Core reads each URL, a sign-in challenge gets the admin's own miniapp
 * token, and the archive rules apply. There is no phone report, so a URL Core can't read records nothing.
 */

import {createLogger} from "@mentra/cloud-shared"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol"
import type {
  AdminRegistryCoverage,
  AdminRegistryEntriesResponse,
  AdminRegistryEntryView,
  AdminRegistryRegisterResult,
  AdminRegistryRuleKind,
  AdminRegistryRulesResponse,
} from "@mentra/workspace-contract"
import {Types} from "mongoose"
import {
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
  type MiniappRegistryArchiveRuleKind,
} from "../../models/miniapp-registry.model"
import {
  normalizeArchiveRule,
  registerMiniappUrl,
  RegistryRequestError,
  ruleEntryFilter,
  ruleKindsCovering,
  type RegistryArchiveRule,
  type RegistryEntryRow,
  type RegistryRegistrant,
} from "./registry.service"

const logger = createLogger("core").child({service: "registry-admin.service"})

/** How many entries a page holds. */
export const REGISTRY_ENTRY_PAGE_SIZE = 50
/** How many archive rules a page holds. */
export const REGISTRY_RULE_PAGE_SIZE = 100
/** Entries read at once for the export, each batch with one query for the rules that cover it. */
const EXPORT_BATCH_SIZE = 500
/**
 * URLs an Organization Admin's batch reads at once. Each read takes at most 5 seconds (twice for a sign-in challenge),
 * so 50 URLs answer well inside the admin portal's proxy timeout.
 */
const REGISTER_CONCURRENCY = 8

/** A cursor: the hex form of an entry's or a rule's `_id`. */
export const REGISTRY_CURSOR_PATTERN = /^[0-9a-f]{24}$/

type EntryRow = RegistryEntryRow & {_id: Types.ObjectId}

/** Everything but Core's verified copy of the manifest, which stays in Core. */
const ENTRY_FIELDS = {manifest: 0} as const

// --- The list ----------------------------------------------------------------

/** A page of entries, newest first; `cursor` is the `next` of the page before it. See the file comment. */
export async function listRegistryEntries(
  options: {
    q?: string
    status?: "active" | "archived"
    verification?: "verified" | "phone_reported"
    cursor?: string
  } = {},
): Promise<AdminRegistryEntriesResponse> {
  const conditions: Array<Record<string, unknown>> = []
  if (options.cursor) conditions.push({_id: {$lt: new Types.ObjectId(options.cursor)}})
  if (options.status) conditions.push({status: options.status})
  if (options.verification) conditions.push({verification: options.verification})
  const query = (options.q ?? "").trim()
  if (query) conditions.push(searchFilter(query))

  const rows = await MiniappRegistryEntryModel.find(conditions.length > 0 ? {$and: conditions} : {})
    .select(ENTRY_FIELDS)
    .sort({_id: -1})
    .limit(REGISTRY_ENTRY_PAGE_SIZE + 1)
    .lean<EntryRow[]>()
  const page = rows.slice(0, REGISTRY_ENTRY_PAGE_SIZE)
  const covering = await ruleKindsCovering(page)
  return {
    items: page.map((row) => adminEntryView(row, covering.get(row.url) ?? [])),
    next: rows.length > REGISTRY_ENTRY_PAGE_SIZE ? page[page.length - 1]!._id.toHexString() : null,
  }
}

/** The entries whose URL, package, name or domain contains `query` as plain text, or that `query`'s account registered. */
function searchFilter(query: string): Record<string, unknown> {
  const contains = {$regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i"}
  return {
    $or: [
      {url: contains},
      {packageName: contains},
      {name: contains},
      {registrableDomain: contains},
      {firstRegisteredBy: query},
    ],
  }
}

/** An entry as an Organization Admin sees it: nothing redacted, archived by its status or by the rules `archivedBy`. */
export function adminEntryView(row: RegistryEntryRow, archivedBy: readonly MiniappRegistryArchiveRuleKind[]): AdminRegistryEntryView {
  return {
    url: row.url,
    packageName: row.packageName,
    registrableDomain: row.registrableDomain,
    name: row.name ?? null,
    version: row.version ?? null,
    ageRating: row.ageRating ?? null,
    iconUrl: row.iconUrl ?? null,
    verification: row.verification,
    private: row.private === true,
    status: row.status === "archived" || archivedBy.length > 0 ? "archived" : "active",
    archivedBy: [...archivedBy] as AdminRegistryRuleKind[],
    firstRegisteredAt: row.firstRegisteredAt.toISOString(),
    firstRegisteredBy: row.firstRegisteredBy,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
  }
}

// --- Rules -------------------------------------------------------------------

/** `rule` in the form Core keeps it. Throws `RegistryRequestError` for one that can't name any entry. */
export function requireArchiveRule(rule: RegistryArchiveRule): RegistryArchiveRule {
  const normalized = normalizeArchiveRule(rule)
  if (!normalized) throw new RegistryRequestError(`not a valid ${String(rule?.kind)} archive rule`)
  return normalized
}

/** What archiving `rule` would cover today: every entry it names, how many of them are active, and whether it exists. */
export async function registryCoverage(rule: RegistryArchiveRule): Promise<AdminRegistryCoverage> {
  const normalized = requireArchiveRule(rule)
  const filter = ruleEntryFilter(normalized)
  const [entries, activeEntries, existing] = await Promise.all([
    MiniappRegistryEntryModel.countDocuments(filter),
    MiniappRegistryEntryModel.countDocuments({...filter, status: "active"}),
    MiniappRegistryArchiveRuleModel.exists(normalized),
  ])
  return {rule: normalized, entries, activeEntries, exists: existing !== null}
}

/** A page of archive rules, newest first; `cursor` is the `next` of the page before it. */
export async function listArchiveRules(options: {cursor?: string} = {}): Promise<AdminRegistryRulesResponse> {
  const rows = await MiniappRegistryArchiveRuleModel.find(
    options.cursor ? {_id: {$lt: new Types.ObjectId(options.cursor)}} : {},
  )
    .sort({_id: -1})
    .limit(REGISTRY_RULE_PAGE_SIZE + 1)
    .lean<
      Array<{_id: Types.ObjectId; kind: MiniappRegistryArchiveRuleKind; value: string; reason?: string | null; createdBy: string; createdAt: Date}>
    >()
  const page = rows.slice(0, REGISTRY_RULE_PAGE_SIZE)
  return {
    items: page.map((row) => ({
      kind: row.kind,
      value: row.value,
      reason: row.reason ?? "",
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    })),
    next: rows.length > REGISTRY_RULE_PAGE_SIZE ? page[page.length - 1]!._id.toHexString() : null,
  }
}

// --- The export --------------------------------------------------------------

const CSV_COLUMNS = [
  "url",
  "package_name",
  "name",
  "version",
  "age_rating",
  "verification",
  "private",
  "status",
  "first_registered_at",
  "last_verified_at",
] as const

/**
 * Every entry as CSV lines (CRLF), oldest first, after a header: the index of every miniapp the Mentra App has
 * installed, for App Review. A batch of entries at a time, each with one query for the rules that cover it. It names
 * no account.
 */
export async function* registryCsv(): AsyncGenerator<string> {
  yield csvLine(CSV_COLUMNS)
  const cursor = MiniappRegistryEntryModel.find({})
    .select(ENTRY_FIELDS)
    .sort({_id: 1})
    .lean<EntryRow[]>()
    .cursor({batchSize: EXPORT_BATCH_SIZE})
  let batch: EntryRow[] = []
  try {
    for await (const row of cursor) {
      batch.push(row as unknown as EntryRow)
      if (batch.length >= EXPORT_BATCH_SIZE) {
        yield await csvLines(batch)
        batch = []
      }
    }
    if (batch.length > 0) yield await csvLines(batch)
  } finally {
    await cursor.close()
  }
}

async function csvLines(rows: EntryRow[]): Promise<string> {
  const covering = await ruleKindsCovering(rows)
  return rows
    .map((row) => {
      const view = adminEntryView(row, covering.get(row.url) ?? [])
      return csvLine([
        view.url,
        view.packageName,
        view.name,
        view.version,
        view.ageRating,
        view.verification,
        view.private,
        view.status,
        view.firstRegisteredAt,
        view.lastVerifiedAt,
      ])
    })
    .join("")
}

function csvLine(cells: ReadonlyArray<string | boolean | null>): string {
  return `${cells.map(csvCell).join(",")}\r\n`
}

/**
 * One CSV cell. Text a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage
 * return) gets a leading apostrophe: names come from developers' manifests. A cell with a quote, a comma or a line
 * break is quoted.
 */
export function csvCell(value: string | boolean | null): string {
  if (value === null) return ""
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// --- Registering -------------------------------------------------------------

/**
 * The distinct URLs of an Organization Admin's list, in order: each trimmed, blank lines left out, and a URL that
 * normalizes to one already listed left out too. `key` is the registry's form when the URL has one.
 */
export function distinctUrls(urls: readonly string[]): Array<{input: string; key: string}> {
  const seen = new Set<string>()
  const distinct: Array<{input: string; key: string}> = []
  for (const input of urls) {
    const trimmed = input.trim()
    if (!trimmed) continue
    const key = normalizeMiniappUrl(trimmed)?.url ?? trimmed
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push({input, key})
  }
  return distinct
}

/**
 * Registers each URL as `registrant` (an Organization Admin), as a phone's registration would, a few at a time.
 * One result per URL, in order (see `AdminRegistryRegisterOutcome`).
 */
export async function registerUrlsAsAdmin(
  urls: ReadonlyArray<{input: string; key: string}>,
  registrant: RegistryRegistrant,
): Promise<AdminRegistryRegisterResult[]> {
  const results: AdminRegistryRegisterResult[] = new Array(urls.length)
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const index = next++
      results[index] = await registerOne(urls[index]!.input, registrant)
    }
  }
  await Promise.all(Array.from({length: Math.min(REGISTER_CONCURRENCY, urls.length)}, worker))
  return results
}

async function registerOne(input: string, registrant: RegistryRegistrant): Promise<AdminRegistryRegisterResult> {
  try {
    const outcome = await registerMiniappUrl({url: input.trim(), registrant})
    switch (outcome.result) {
      case "accepted":
      case "accepted_unverified":
        return {
          input,
          result: outcome.result,
          url: outcome.entry.url,
          packageName: outcome.entry.packageName,
          name: outcome.entry.name,
        }
      case "not_a_miniapp":
        return outcome.unreachable ? {input, result: "unreachable"} : {input, result: "not_a_miniapp", reason: outcome.reason}
      case "archived":
        return {input, result: "archived"}
    }
  } catch (error) {
    if (error instanceof RegistryRequestError) return {input, result: "invalid_url"}
    logger.error({input, error: (error as Error)?.message}, "registry: an Organization Admin's registration failed")
    return {input, result: "failed"}
  }
}
