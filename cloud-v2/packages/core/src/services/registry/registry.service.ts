/**
 * @fileoverview Core's miniapp registry: registering a miniapp URL, the phone's status batch, re-verification and
 * archiving (`models/miniapp-registry.model.ts`).
 *
 * **Registering.** Every install of a miniapp URL registers it (`registerMiniappUrl`). Core verifies the URL itself:
 * it reads `<url>/miniapp.json` with its guarded fetcher (`miniapp-fetcher.ts`, the only way Core reaches a
 * developer's URL), validates it with `ServedMiniappManifestSchema`, and applies the domain rule. What Core read
 * from another domain after a redirect doesn't count as the URL's. The answer is one of:
 * - `accepted`, with the `miniapp.json` Core read; the entry is `verified`;
 * - `accepted_unverified`, when Core can't read the URL. A URL only the phone reaches (an intranet host, a host that
 *   resolves to a private address, a server that turns Core away, a redirect off the URL's domain) is recorded from
 *   the phone's report, after the same domain-rule check, as `phone_reported`; with no report it isn't a miniapp.
 *   A private server that refuses the person's token is recorded as private with only the package name its sign-in
 *   challenge named;
 * - `not_a_miniapp`: an invalid `miniapp.json`, a name that fails the domain rule, an HTTP URL, a local-network URL;
 * - `archived`.
 *
 * **Private miniapps.** A server that answers with the sign-in challenge makes the entry private. Core checks the
 * challenge's package against the URL's domain, mints that package's miniapp token for the person registering
 * (`mintMiniappTokenFor`, so the token names their workspace only when it assigned the package), and retries once,
 * following no redirects. Core shows a private entry's name, version, rating and icon only to someone its server
 * admitted in that same request: the phone's own request decides whether it installs. An accepted answer describes
 * what this caller's own read found, never what another read stored meanwhile.
 *
 * **What a later answer may change.** A verified entry keeps what Core read until Core reads the URL again; a failed
 * read, a phone's report or a refused token never replaces it. Concurrent reads of one URL land in the order they
 * started.
 *
 * **Archiving.** An entry is archived when its own status is, or when an archive rule names its URL, package name,
 * registrable domain or the account that first registered it. A rule also refuses URLs registered after it:
 * registration checks the rules before it reads anything and again once it knows the package, and creates no entry
 * for a URL a rule covers. It checks the stored entry and the rules once more after it writes, so a rule made while
 * Core was reading the URL still refuses the install. Archiving refuses installs and stops updates; installed copies
 * keep running.
 *
 * **Status.** One batch call answers `active`, `archived` or `unknown` for each installed URL. A version newer than
 * the one Core recorded, or any use of an entry Core hasn't verified, re-verifies the URL off the request path, at
 * most once an hour per URL across every Core instance, with the token of the person whose phone asked.
 */

import {createLogger} from "@mentra/cloud-shared"
import {
  isPackageNameAllowedForUrl,
  MINIAPP_AGE_RATINGS,
  MINIAPP_PACKAGE_NAME_PATTERN,
  MINIAPP_REGISTRY_STATUS_DEFAULT_TTL_SECONDS,
  MINIAPP_VERSION_PATTERN,
  normalizeMiniappUrl,
  packagePrefixForHost,
  registrableDomain,
  ServedMiniappManifestSchema,
  type MiniappAgeRating,
  type MiniappRegistryNotAMiniappReason,
  type MiniappRegistryUrlStatus,
  type RegistryEntryView,
  type RegistryReportedManifest,
  type RegistryStatusResponse,
  type ServedMiniappManifest,
} from "@mentra/cloud-protocol"
import {
  MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS,
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
  type MiniappRegistryArchiveRuleKind,
} from "../../models/miniapp-registry.model"
import {mintMiniappTokenFor} from "../miniapp-token.service"
import {fetchMiniappManifest, type FetchedManifest} from "./miniapp-fetcher"

const logger = createLogger("core").child({service: "registry.service"})

/** Re-verification of one URL happens at most this often. */
export const REGISTRY_REVERIFY_INTERVAL_MS = 60 * 60_000
/** Re-verifications run in the background, this many at once per Core process. */
const REVERIFY_CONCURRENCY = 4
/** URLs waiting for a background re-verification; more are dropped and come back at the next status call. */
const REVERIFY_MAX_PENDING = 1_000
/** The longest `validForSeconds` the setting may ask for: a week. */
const MAX_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_ICON_URL_LENGTH = 2048
const DUPLICATE_KEY = 11000

/** The person a registration or status call is made for. */
export interface RegistryRegistrant {
  mentraUserId: string
  tenantId: string
}

/** Supplies the miniapp token for the package a sign-in challenge named. */
export type ChallengeTokenSource = (packageName: string) => Promise<string>

/** What a registration came to. The API answers it as it is, without `unreachable`. */
export type RegisterMiniappUrlResult =
  | {result: "accepted"; entry: RegistryEntryView; manifest: ServedMiniappManifest}
  | {result: "accepted_unverified"; entry: RegistryEntryView}
  | {
      result: "not_a_miniapp"
      reason: MiniappRegistryNotAMiniappReason
      /** Core couldn't read the URL and had no report to keep: not proof that it isn't a miniapp. */
      unreachable?: true
    }
  | {result: "archived"}

/** What reading a miniapp URL came to. */
export type MiniappVerification =
  | {kind: "verified"; manifest: ServedMiniappManifest; private: boolean}
  | {kind: "not_a_miniapp"; reason: "invalid_manifest" | "domain_mismatch"}
  /** The server asked for sign-in and didn't serve the miniapp to the token Core sent (or Core had none to send). */
  | {kind: "private_refused"; packageName: string}
  | {kind: "unreachable"}

/** A request the registry can't act on: not a URL Core could ever register. Answered as 400. */
export class RegistryRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RegistryRequestError"
  }
}

/** An entry as stored. */
export interface RegistryEntryRow {
  url: string
  packageName: string
  registrableDomain: string
  name: string | null
  version: string | null
  ageRating: string | null
  iconUrl: string | null
  verification: "verified" | "phone_reported"
  manifest: string | null
  private: boolean
  status: "active" | "archived"
  firstRegisteredAt: Date
  firstRegisteredBy: string
  lastVerifiedAt: Date | null
  lastVerifyAttemptAt: Date | null
  lastSeenVersion: string | null
}

type ArchiveKeys = Pick<RegistryEntryRow, "url" | "registrableDomain"> & {
  packageNames: string[]
  firstRegisteredBy?: string | null
}

const ARCHIVED = {result: "archived"} as const
const UNREACHABLE: MiniappVerification = {kind: "unreachable"}

// --- Miniapp URLs ------------------------------------------------------------

/** A URL the registry can hold: public HTTPS, normalized, on a domain that owns package names. */
interface RegistrableUrl {
  url: string
  registrableDomain: string
}

/**
 * Sorts a URL a phone sent: one the registry can hold, one that isn't a miniapp URL (with the reason the phone is
 * told), or null for something that isn't a miniapp URL at all.
 */
function classifyUrl(
  input: string,
): {kind: "ok"; target: RegistrableUrl} | {kind: "not_a_miniapp"; reason: MiniappRegistryNotAMiniappReason} | null {
  const normalized = normalizeMiniappUrl(input)
  if (!normalized) {
    // The same URL over HTTPS would be a public miniapp URL.
    const trimmed = typeof input === "string" ? input.trim() : ""
    if (/^http:\/\//i.test(trimmed) && normalizeMiniappUrl(`https://${trimmed.slice("http://".length)}`)?.kind === "public") {
      return {kind: "not_a_miniapp", reason: "not_https"}
    }
    return null
  }
  if (normalized.kind === "local") return {kind: "not_a_miniapp", reason: "local_network_url"}
  const domain = registrableDomain(normalized.host)
  // No package name can pass the domain rule here (an IP address, a suffix nobody owns): nothing to read.
  if (!domain || !packagePrefixForHost(normalized.host)) return {kind: "not_a_miniapp", reason: "domain_mismatch"}
  return {kind: "ok", target: {url: normalized.url, registrableDomain: domain}}
}

/** The registry's key for a URL, or null when it isn't a public miniapp URL. */
function registryKey(input: string): string | null {
  const normalized = normalizeMiniappUrl(input)
  return normalized?.kind === "public" ? normalized.url : null
}

// --- Verifying ---------------------------------------------------------------

/**
 * Reads a miniapp URL through Core's fetcher and judges what it serves. `url` must be a normalized public miniapp
 * URL. A sign-in challenge whose package passes the domain rule gets that package's token from `tokenFor`, and one
 * retry that follows no redirects. Never throws for anything the URL serves.
 */
export async function verifyMiniappUrl(url: string, tokenFor: ChallengeTokenSource): Promise<MiniappVerification> {
  const normalized = normalizeMiniappUrl(url)
  if (normalized?.kind !== "public" || normalized.url !== url) {
    throw new TypeError("verifyMiniappUrl: not a normalized public miniapp URL")
  }

  const first = await fetchMiniappManifest(url)
  switch (first.kind) {
    case "ok":
      return judgeManifest(url, first.manifest, null)
    case "unreachable":
      return UNREACHABLE
    case "refused":
      // 404 and 410 say there is nothing here. A 401 without the challenge, or a 403, turns Core away while the
      // phone may still be let in (an access-controlled intranet host), as an unreachable URL would.
      return first.status === 404 || first.status === 410 ? notAMiniapp("invalid_manifest") : UNREACHABLE
    case "challenge": {
      const packageName = first.packageName
      if (!isPackageNameAllowedForUrl(packageName, url)) return notAMiniapp("domain_mismatch")
      let token: string
      try {
        token = await tokenFor(packageName)
      } catch (error) {
        logger.warn({url, packageName, error: (error as Error)?.message}, "registry: no miniapp token for a sign-in challenge")
        return {kind: "private_refused", packageName}
      }
      const retry = await fetchMiniappManifest(url, {bearer: token})
      if (retry.kind === "ok") return judgeManifest(url, retry.manifest, packageName)
      return {kind: "private_refused", packageName}
    }
  }
}

function notAMiniapp(reason: "invalid_manifest" | "domain_mismatch"): MiniappVerification {
  return {kind: "not_a_miniapp", reason}
}

/** Judges a `miniapp.json` Core read from `url`. `challengePackage` is the package of the challenge answered. */
function judgeManifest(url: string, fetched: FetchedManifest, challengePackage: string | null): MiniappVerification {
  // Read from another domain (a redirect off the URL's domain, such as a sign-in page in front of an intranet
  // host): Core hasn't seen what the URL serves, and the phone refuses such a redirect itself.
  if (registrableDomainOfUrl(fetched.finalUrl) !== registrableDomainOfUrl(url)) return UNREACHABLE
  let json: unknown
  try {
    json = JSON.parse(fetched.body)
  } catch {
    return notAMiniapp("invalid_manifest")
  }
  const parsed = ServedMiniappManifestSchema.safeParse(json)
  if (!parsed.success) return notAMiniapp("invalid_manifest")
  const manifest = parsed.data
  // Where it was read is on the same domain, so the rule for the URL is the rule for both.
  if (!isPackageNameAllowedForUrl(manifest.packageName, url)) return notAMiniapp("domain_mismatch")
  // The token Core sent was for the challenge's package; a manifest for another package isn't the one it asked for.
  if (challengePackage !== null && manifest.packageName !== challengePackage) return notAMiniapp("invalid_manifest")
  return {kind: "verified", manifest, private: challengePackage !== null}
}

function registrableDomainOfUrl(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname)
  } catch {
    return null
  }
}

/** The person's own miniapp token for a challenge's package, under the token service's rules. */
function tokensFor(registrant: RegistryRegistrant): ChallengeTokenSource {
  return async (packageName) =>
    (await mintMiniappTokenFor({mentraUserId: registrant.mentraUserId, tenantId: registrant.tenantId, packageName}))
      .token
}

// --- Registering -------------------------------------------------------------

/**
 * A registration's answer when Core can give it without reading the URL: `not_a_miniapp` for a URL that can't be one
 * (HTTP, local network, no domain that owns names), or `archived` for one an archive rule or its entry's status
 * covers. The package the phone reported counts too: the phone stops at `archived` for its own install, so its word
 * is enough to refuse. Null when Core has to read the URL. Needs no verified email, so archiving holds for every
 * signed-in phone. Throws `RegistryRequestError` for something that isn't a miniapp URL at all.
 */
export async function answerWithoutReading(input: {
  url: string
  reportedPackageName?: string
  registrant: RegistryRegistrant
}): Promise<RegisterMiniappUrlResult | null> {
  const classified = classifyUrl(input.url)
  if (!classified) throw new RegistryRequestError("url must be an HTTPS miniapp URL without credentials, a query or a fragment")
  if (classified.kind === "not_a_miniapp") return {result: "not_a_miniapp", reason: classified.reason}
  const target = classified.target
  const existing = await findEntry(target.url)
  if (existing?.status === "archived") return ARCHIVED
  const archived = await archivedBy({
    ...target,
    packageNames: [existing?.packageName, input.reportedPackageName].filter((name): name is string => Boolean(name)),
    firstRegisteredBy: existing?.firstRegisteredBy ?? input.registrant.mentraUserId,
  })
  return archived ? ARCHIVED : null
}

/**
 * Registers a miniapp URL for `registrant`, verifying it first (see the file comment). `reported` is what the phone
 * read; Core keeps it only when it can't read the URL itself. `tokenFor` answers a sign-in challenge; it defaults to
 * the registrant's own miniapp token. Throws `RegistryRequestError` for something that isn't a miniapp URL at all.
 */
export async function registerMiniappUrl(input: {
  url: string
  reported?: RegistryReportedManifest
  registrant: RegistryRegistrant
  tokenFor?: ChallengeTokenSource
}): Promise<RegisterMiniappUrlResult> {
  const classified = classifyUrl(input.url)
  if (!classified) throw new RegistryRequestError("url must be an HTTPS miniapp URL without credentials, a query or a fragment")
  if (classified.kind === "not_a_miniapp") return {result: "not_a_miniapp", reason: classified.reason}
  const target = classified.target
  const registrant = input.registrant.mentraUserId

  const existing = await findEntry(target.url)
  // A new URL would be registered by this person, so an account rule for them covers it.
  const firstRegisteredBy = existing?.firstRegisteredBy ?? registrant
  const archivedFor = (packageName: string | null | undefined) =>
    archivedBy({...target, packageNames: packageName ? [packageName] : [], firstRegisteredBy})
  if (existing?.status === "archived" || (await archivedFor(existing?.packageName))) return ARCHIVED

  const startedAt = new Date()
  const outcome = await verifyMiniappUrl(target.url, input.tokenFor ?? tokensFor(input.registrant))
  logger.info({url: target.url, outcome: outcome.kind}, "registry: registration verified")

  switch (outcome.kind) {
    case "not_a_miniapp":
      if (existing) await stampAttempt(target.url, startedAt)
      return {result: "not_a_miniapp", reason: outcome.reason}

    case "verified": {
      const packageName = outcome.manifest.packageName
      if (await archivedFor(packageName)) return ARCHIVED
      await writeVerified(target, outcome, registrant, startedAt)
      const entry = await acceptableEntry(target, packageName, registrant)
      if (!entry) return ARCHIVED
      // What this caller was served, not whatever another read stored meanwhile: a private entry's details go
      // only to someone its server admitted.
      return {result: "accepted", entry: verifiedView(entry, outcome, startedAt), manifest: outcome.manifest}
    }

    case "private_refused": {
      if (await archivedFor(outcome.packageName)) return ARCHIVED
      await writePrivateRefused(target, outcome.packageName, registrant, startedAt)
      const entry = await acceptableEntry(target, outcome.packageName, registrant)
      if (!entry) return ARCHIVED
      return {result: "accepted_unverified", entry: entryView(entry, {redact: true})}
    }

    case "unreachable": {
      const reported = input.reported
      // What Core read before, or a private entry, isn't replaced by a phone's report.
      if (existing && (existing.verification === "verified" || existing.private || !reported)) {
        await stampAttempt(target.url, startedAt)
        const entry = await acceptableEntry(target, existing.packageName, registrant)
        if (!entry) return ARCHIVED
        return {result: "accepted_unverified", entry: entryView(entry, {redact: entry.private})}
      }
      if (!reported) return {result: "not_a_miniapp", reason: "invalid_manifest", unreachable: true}
      if (!isPackageNameAllowedForUrl(reported.packageName, target.url)) {
        return {result: "not_a_miniapp", reason: "domain_mismatch"}
      }
      if (await archivedFor(reported.packageName)) return ARCHIVED
      await writeReported(target, reported, registrant, startedAt)
      const entry = await acceptableEntry(target, reported.packageName, registrant)
      if (!entry) return ARCHIVED
      return {result: "accepted_unverified", entry: entryView(entry, {redact: entry.private})}
    }
  }
}

/**
 * The last check before a registration is accepted, after everything it wrote: the entry as stored now, or null
 * when it is archived, by its own status or by a rule covering it or `packageName`. A rule archived while Core was
 * reading the URL is seen here.
 */
async function acceptableEntry(
  target: RegistrableUrl,
  packageName: string,
  registrant: string,
): Promise<RegistryEntryRow | null> {
  const entry = await findEntry(target.url)
  if (!entry) throw new Error(`registry: the entry for ${target.url} is gone`)
  if (entry.status === "archived") return null
  const archived = await archivedBy({
    ...target,
    packageNames: [...new Set([packageName, entry.packageName])],
    firstRegisteredBy: entry.firstRegisteredBy ?? registrant,
  })
  return archived ? null : entry
}

/** The entry as this caller's own verified read describes it, with the stored entry's registration dates. */
function verifiedView(
  entry: RegistryEntryRow,
  outcome: Extract<MiniappVerification, {kind: "verified"}>,
  startedAt: Date,
): RegistryEntryView {
  const manifest = outcome.manifest
  return {
    url: entry.url,
    packageName: manifest.packageName,
    registrableDomain: entry.registrableDomain,
    name: manifest.name,
    version: manifest.version,
    ageRating: manifest.ageRating ?? null,
    iconUrl: absoluteIconUrl(manifest.icon, entry.url),
    verification: "verified",
    private: outcome.private,
    status: "active",
    firstRegisteredAt: entry.firstRegisteredAt.toISOString(),
    lastVerifiedAt: startedAt.toISOString(),
  }
}

/** Re-reads an entry's URL, as the person whose phone asked; see `registryStatus`. No-op within the hour. */
export async function verifyEntry(url: string, caller: RegistryRegistrant): Promise<MiniappVerification | null> {
  const startedAt = new Date()
  // Claim the attempt first, so every Core instance together reads a URL at most once an hour.
  const claimed = await MiniappRegistryEntryModel.findOneAndUpdate(
    {
      url,
      status: "active",
      $or: [
        {lastVerifyAttemptAt: null},
        {lastVerifyAttemptAt: {$lte: new Date(startedAt.getTime() - REGISTRY_REVERIFY_INTERVAL_MS)}},
      ],
    },
    {$set: {lastVerifyAttemptAt: startedAt}},
    {new: true},
  ).lean<RegistryEntryRow>()
  if (!claimed || (await isArchived(claimed))) return null
  const target = {url: claimed.url, registrableDomain: claimed.registrableDomain}
  const outcome = await verifyMiniappUrl(claimed.url, tokensFor(caller))
  logger.info({url, outcome: outcome.kind}, "registry: entry re-verified")
  if (outcome.kind === "verified") await writeVerified(target, outcome, claimed.firstRegisteredBy, startedAt)
  else if (outcome.kind === "private_refused") await writePrivateRefused(target, outcome.packageName, claimed.firstRegisteredBy, startedAt)
  return outcome
}

// --- Writes ------------------------------------------------------------------

async function findEntry(url: string): Promise<RegistryEntryRow | null> {
  return MiniappRegistryEntryModel.findOne({url}).lean<RegistryEntryRow>()
}

/** What a new entry starts with; an existing one keeps its own. */
function onInsert(registrant: string, at: Date) {
  return {firstRegisteredAt: at, firstRegisteredBy: registrant, status: "active"}
}

/** Records what Core read. Replaces an entry only if no read that started later has landed. */
async function writeVerified(
  target: RegistrableUrl,
  outcome: Extract<MiniappVerification, {kind: "verified"}>,
  registrant: string,
  startedAt: Date,
): Promise<void> {
  const manifest = outcome.manifest
  await upsertUnlessTaken(
    {url: target.url, $or: [{lastVerifiedAt: null}, {lastVerifiedAt: {$lte: startedAt}}]},
    {
      $set: {
        packageName: manifest.packageName,
        registrableDomain: target.registrableDomain,
        name: manifest.name,
        version: manifest.version,
        ageRating: manifest.ageRating ?? null,
        iconUrl: absoluteIconUrl(manifest.icon, target.url),
        verification: "verified",
        manifest: JSON.stringify(manifest),
        private: outcome.private,
        lastVerifiedAt: startedAt,
        lastSeenVersion: manifest.version,
      },
      $max: {lastVerifyAttemptAt: startedAt},
      $setOnInsert: onInsert(registrant, startedAt),
    },
  )
}

/**
 * Records a private server that didn't serve the miniapp to Core's token: the entry is private, with only the
 * package name its challenge named. A verified entry keeps what Core read, and becomes private.
 */
async function writePrivateRefused(
  target: RegistrableUrl,
  packageName: string,
  registrant: string,
  at: Date,
): Promise<void> {
  const markVerified = () =>
    MiniappRegistryEntryModel.updateOne(
      {url: target.url, verification: "verified"},
      {$set: {private: true}, $max: {lastVerifyAttemptAt: at}},
    )
  if ((await markVerified()).matchedCount > 0) return
  const written = await upsertUnlessTaken(
    {url: target.url, verification: "phone_reported"},
    {
      $set: {
        packageName,
        registrableDomain: target.registrableDomain,
        name: null,
        version: null,
        ageRating: null,
        iconUrl: null,
        manifest: null,
        private: true,
      },
      $max: {lastVerifyAttemptAt: at},
      $setOnInsert: onInsert(registrant, at),
    },
  )
  // A read that verified the URL landed in between.
  if (!written) await markVerified()
}

/** Records the phone's report of a URL Core can't read. Never replaces a verified or a private entry. */
async function writeReported(
  target: RegistrableUrl,
  reported: RegistryReportedManifest,
  registrant: string,
  at: Date,
): Promise<void> {
  await upsertUnlessTaken(
    {url: target.url, verification: "phone_reported", private: false},
    {
      $set: {
        packageName: reported.packageName,
        registrableDomain: target.registrableDomain,
        name: reported.name,
        version: reported.version,
        ageRating: reported.ageRating ?? null,
        iconUrl: null,
        manifest: null,
        lastSeenVersion: reported.version,
      },
      $max: {lastVerifyAttemptAt: at},
      $setOnInsert: onInsert(registrant, at),
    },
  )
}

async function stampAttempt(url: string, at: Date): Promise<void> {
  await MiniappRegistryEntryModel.updateOne({url}, {$max: {lastVerifyAttemptAt: at}})
}

/**
 * Applies `update` to the entry `filter` matches, inserting the URL's entry when it has none. When an entry exists
 * that the filter doesn't match, the insert collides with it on the unique URL and nothing is written: false.
 */
async function upsertUnlessTaken(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<boolean> {
  try {
    await MiniappRegistryEntryModel.updateOne(filter, update, {upsert: true})
    return true
  } catch (error) {
    if ((error as {code?: unknown})?.code === DUPLICATE_KEY) return false
    throw error
  }
}

/** The manifest's icon as an absolute HTTPS URL, or null. Relative paths are relative to the miniapp URL. */
function absoluteIconUrl(icon: string | undefined, base: string): string | null {
  if (!icon) return null
  try {
    const url = new URL(icon, base)
    if (url.protocol !== "https:" || url.username || url.password) return null
    const text = url.toString()
    return text.length <= MAX_ICON_URL_LENGTH ? text : null
  } catch {
    return null
  }
}

// --- Views -------------------------------------------------------------------

function isAgeRating(value: unknown): value is MiniappAgeRating {
  return typeof value === "string" && (MINIAPP_AGE_RATINGS as readonly string[]).includes(value)
}

/**
 * An entry as callers see it. `redact` leaves out everything but the URL and package: for a private entry whose
 * server hasn't admitted the caller. `archived` reports an entry an archive rule covers as archived.
 */
export function entryView(entry: RegistryEntryRow, options: {redact?: boolean; archived?: boolean} = {}): RegistryEntryView {
  const redact = options.redact === true
  return {
    url: entry.url,
    packageName: entry.packageName,
    registrableDomain: entry.registrableDomain,
    name: redact ? null : (entry.name ?? null),
    version: redact ? null : (entry.version ?? null),
    ageRating: redact || !isAgeRating(entry.ageRating) ? null : entry.ageRating,
    iconUrl: redact ? null : (entry.iconUrl ?? null),
    verification: entry.verification,
    private: entry.private === true,
    status: options.archived === true || entry.status === "archived" ? "archived" : "active",
    firstRegisteredAt: entry.firstRegisteredAt.toISOString(),
    lastVerifiedAt: entry.lastVerifiedAt ? entry.lastVerifiedAt.toISOString() : null,
  }
}

// --- Status ------------------------------------------------------------------

/** `validForSeconds` for status answers: `CLOUD_CORE_REGISTRY_STATUS_TTL_SEC`, 6 hours by default. */
export function registryStatusTtlSeconds(): number {
  const raw = process.env.CLOUD_CORE_REGISTRY_STATUS_TTL_SEC?.trim()
  if (!raw) return MINIAPP_REGISTRY_STATUS_DEFAULT_TTL_SECONDS
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (seconds >= 1 && seconds <= MAX_STATUS_TTL_SECONDS) return seconds
  logger.warn({value: raw}, "CLOUD_CORE_REGISTRY_STATUS_TTL_SEC is not a whole number of seconds up to a week; using 6 hours")
  return MINIAPP_REGISTRY_STATUS_DEFAULT_TTL_SECONDS
}

/**
 * The status of each URL in a phone's batch, in order. `reverify` lets the call start background re-verifications
 * (see the file comment), made with `caller`'s miniapp tokens.
 */
export async function registryStatus(input: {
  entries: Array<{url: string; version: string}>
  caller: RegistryRegistrant
  reverify: boolean
}): Promise<RegistryStatusResponse> {
  const keys = input.entries.map((entry) => registryKey(entry.url))
  const urls = [...new Set(keys.filter((key): key is string => key !== null))]
  const rows = urls.length > 0 ? await MiniappRegistryEntryModel.find({url: {$in: urls}}).lean<RegistryEntryRow[]>() : []
  const byUrl = new Map(rows.map((row) => [row.url, row]))
  const archived = await archivedUrls(rows)

  const now = Date.now()
  const statuses = input.entries.map((entry, index) => {
    const key = keys[index]
    const row = key ? byUrl.get(key) : undefined
    let status: MiniappRegistryUrlStatus = "unknown"
    if (row) {
      status = archived.has(row.url) ? "archived" : "active"
      if (status === "active" && input.reverify && needsReverification(row, entry.version, now)) {
        scheduleReverification(row.url, input.caller)
      }
    }
    return {url: entry.url, status}
  })
  return {statuses, validForSeconds: registryStatusTtlSeconds()}
}

/** Whether a phone's installed `version` should make Core read the URL again now. */
function needsReverification(row: RegistryEntryRow, version: string, now: number): boolean {
  if (row.lastVerifyAttemptAt && now - row.lastVerifyAttemptAt.getTime() < REGISTRY_REVERIFY_INTERVAL_MS) return false
  // Core verifies a URL it couldn't read as soon as it becomes reachable.
  if (row.verification !== "verified" || !row.lastSeenVersion) return true
  return isNewerVersion(version, row.lastSeenVersion)
}

const pendingReverifications = new Set<string>()
const reverifyQueue: Array<() => Promise<void>> = []
let reverifyRunning = 0
let idleWaiters: Array<() => void> = []

function scheduleReverification(url: string, caller: RegistryRegistrant): void {
  if (pendingReverifications.has(url) || pendingReverifications.size >= REVERIFY_MAX_PENDING) return
  pendingReverifications.add(url)
  reverifyQueue.push(async () => {
    try {
      await verifyEntry(url, caller)
    } catch (error) {
      logger.warn({url, error: (error as Error)?.message}, "registry: re-verification failed")
    } finally {
      pendingReverifications.delete(url)
    }
  })
  drainReverifications()
}

function drainReverifications(): void {
  while (reverifyRunning < REVERIFY_CONCURRENCY && reverifyQueue.length > 0) {
    const job = reverifyQueue.shift()!
    reverifyRunning++
    void job().finally(() => {
      reverifyRunning--
      drainReverifications()
      if (reverifyRunning === 0 && reverifyQueue.length === 0) for (const resolve of idleWaiters.splice(0)) resolve()
    })
  }
}

/** Resolves once no background re-verification is queued or running. */
export function reverificationsIdle(): Promise<void> {
  if (reverifyRunning === 0 && reverifyQueue.length === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

// --- Versions ----------------------------------------------------------------

/** Whether `candidate` is newer than `known` by SemVer precedence; versions that aren't SemVer are newer when different. */
export function isNewerVersion(candidate: string, known: string): boolean {
  const a = parseSemver(candidate)
  const b = parseSemver(known)
  if (!a || !b) return candidate !== known
  return compareSemver(a, b) > 0
}

interface ParsedSemver {
  core: [string, string, string]
  prerelease: string[]
}

function parseSemver(version: string): ParsedSemver | null {
  if (!MINIAPP_VERSION_PATTERN.test(version)) return null
  const withoutBuild = version.split("+")[0]!
  const dash = withoutBuild.indexOf("-")
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split(".") as [string, string, string]
  return {core, prerelease: dash < 0 ? [] : withoutBuild.slice(dash + 1).split(".")}
}

/** Numeric identifiers have no leading zeros, so a longer one is larger. */
function compareNumeric(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let index = 0; index < 3; index++) {
    const order = compareNumeric(a.core[index]!, b.core[index]!)
    if (order !== 0) return order
  }
  // A release ranks above its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    const order =
      xNumeric && yNumeric ? compareNumeric(x, y) : xNumeric ? -1 : yNumeric ? 1 : x < y ? -1 : x > y ? 1 : 0
    if (order !== 0) return order
  }
  return 0
}

// --- Archiving ---------------------------------------------------------------

/** An archive rule: a URL, a package name, a registrable domain, or the `mentraUserId` of an account. */
export interface RegistryArchiveRule {
  kind: MiniappRegistryArchiveRuleKind
  value: string
}

/** A rule's value in the form entries store it, or null when it can't name any entry. */
export function normalizeArchiveRule(rule: RegistryArchiveRule): RegistryArchiveRule | null {
  if (typeof rule?.value !== "string") return null
  const value = rule.value.trim()
  switch (rule.kind) {
    case "url": {
      const url = registryKey(value)
      return url ? {kind: "url", value: url} : null
    }
    case "package":
      return MINIAPP_PACKAGE_NAME_PATTERN.test(value) ? {kind: "package", value} : null
    case "domain": {
      const domain = value.toLowerCase().replace(/\.$/, "")
      return registrableDomain(domain) === domain ? {kind: "domain", value: domain} : null
    }
    case "account":
      return /^[A-Za-z0-9_:.-]{1,128}$/.test(value) ? {kind: "account", value} : null
    default:
      return null
  }
}

/** The entries a rule covers. */
export function ruleEntryFilter(rule: RegistryArchiveRule): Record<string, string> {
  switch (rule.kind) {
    case "url":
      return {url: rule.value}
    case "package":
      return {packageName: rule.value}
    case "domain":
      return {registrableDomain: rule.value}
    case "account":
      return {firstRegisteredBy: rule.value}
  }
}

function requireRule(rule: RegistryArchiveRule): RegistryArchiveRule {
  const normalized = normalizeArchiveRule(rule)
  if (!normalized) throw new RegistryRequestError(`not a valid ${String(rule?.kind)} archive rule`)
  return normalized
}

/**
 * Archives every entry `rule` covers, now and registered later. Idempotent: archiving a rule that exists keeps the
 * first one's reason and author (`created: false`). Answers how many entries it moved to archived.
 */
export async function archive(
  rule: RegistryArchiveRule,
  meta: {reason: string; createdBy: string},
): Promise<{rule: RegistryArchiveRule; created: boolean; entriesArchived: number}> {
  const normalized = requireRule(rule)
  let created = true
  try {
    await MiniappRegistryArchiveRuleModel.create({
      ...normalized,
      reason: meta.reason,
      createdBy: meta.createdBy,
      createdAt: new Date(),
    })
  } catch (error) {
    if ((error as {code?: unknown})?.code !== DUPLICATE_KEY) throw error
    created = false
  }
  const updated = await MiniappRegistryEntryModel.updateMany(
    {...ruleEntryFilter(normalized), status: "active"},
    {$set: {status: "archived"}},
  )
  logger.info({rule: normalized, created, entriesArchived: updated.modifiedCount}, "registry: archived")
  return {rule: normalized, created, entriesArchived: updated.modifiedCount}
}

/** Removes `rule`, and makes active again the entries it covered that no other rule covers. */
export async function unarchive(
  rule: RegistryArchiveRule,
): Promise<{rule: RegistryArchiveRule; removed: boolean; entriesRestored: number}> {
  const normalized = requireRule(rule)
  const removed = (await MiniappRegistryArchiveRuleModel.deleteOne(normalized)).deletedCount > 0
  let entriesRestored = 0
  const cursor = MiniappRegistryEntryModel.find({...ruleEntryFilter(normalized), status: "archived"})
    .select({url: 1, packageName: 1, registrableDomain: 1, firstRegisteredBy: 1})
    .lean<RegistryEntryRow[]>()
    .cursor()
  let batch: RegistryEntryRow[] = []
  const restore = async () => {
    const covered = await urlsCoveredByRules(batch)
    const urls = batch.map((row) => row.url).filter((url) => !covered.has(url))
    batch = []
    if (urls.length === 0) return
    const updated = await MiniappRegistryEntryModel.updateMany(
      {url: {$in: urls}, status: "archived"},
      {$set: {status: "active"}},
    )
    entriesRestored += updated.modifiedCount
  }
  for await (const row of cursor) {
    batch.push(row as unknown as RegistryEntryRow)
    if (batch.length >= 500) await restore()
  }
  await restore()
  logger.info({rule: normalized, removed, entriesRestored}, "registry: unarchived")
  return {rule: normalized, removed, entriesRestored}
}

/** Whether an entry is archived: its own status, or a rule that names its URL, package, domain or first registrant. */
export async function isArchived(
  entry: Pick<RegistryEntryRow, "url" | "packageName" | "registrableDomain" | "firstRegisteredBy" | "status">,
): Promise<boolean> {
  return (
    entry.status === "archived" ||
    (await archivedBy({...entry, packageNames: entry.packageName ? [entry.packageName] : []}))
  )
}

/** Whether any rule covers these keys. */
async function archivedBy(keys: ArchiveKeys): Promise<boolean> {
  const clauses: Array<{kind: MiniappRegistryArchiveRuleKind; value: string}> = [
    {kind: "url", value: keys.url},
    {kind: "domain", value: keys.registrableDomain},
  ]
  for (const packageName of keys.packageNames) clauses.push({kind: "package", value: packageName})
  if (keys.firstRegisteredBy) clauses.push({kind: "account", value: keys.firstRegisteredBy})
  return (await MiniappRegistryArchiveRuleModel.exists({$or: clauses})) !== null
}

/** The URLs of `rows` that are archived, by their own status or by a rule. */
async function archivedUrls(rows: RegistryEntryRow[]): Promise<Set<string>> {
  const covered = await urlsCoveredByRules(rows)
  for (const row of rows) if (row.status === "archived") covered.add(row.url)
  return covered
}

/** The URLs of `rows` that some rule covers, with one query. */
async function urlsCoveredByRules(
  rows: Array<Pick<RegistryEntryRow, "url" | "packageName" | "registrableDomain" | "firstRegisteredBy">>,
): Promise<Set<string>> {
  return new Set((await ruleKindsCovering(rows)).keys())
}

/**
 * The kinds of the rules that cover each of `rows`, by URL, with one query: a URL no rule covers is absent. Kinds are
 * in `MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS` order.
 */
export async function ruleKindsCovering(
  rows: Array<Pick<RegistryEntryRow, "url" | "packageName" | "registrableDomain" | "firstRegisteredBy">>,
): Promise<Map<string, MiniappRegistryArchiveRuleKind[]>> {
  if (rows.length === 0) return new Map()
  const values = (pick: (row: (typeof rows)[number]) => string) => [...new Set(rows.map(pick))]
  const rules = await MiniappRegistryArchiveRuleModel.find({
    $or: [
      {kind: "url", value: {$in: values((row) => row.url)}},
      {kind: "package", value: {$in: values((row) => row.packageName)}},
      {kind: "domain", value: {$in: values((row) => row.registrableDomain)}},
      {kind: "account", value: {$in: values((row) => row.firstRegisteredBy)}},
    ],
  })
    .select({kind: 1, value: 1})
    .lean<Array<{kind: MiniappRegistryArchiveRuleKind; value: string}>>()
  const ruled = new Set(rules.map((rule) => `${rule.kind}\u0000${rule.value}`))
  const covering = new Map<string, MiniappRegistryArchiveRuleKind[]>()
  for (const row of rows) {
    const keys: Record<MiniappRegistryArchiveRuleKind, string> = {
      url: row.url,
      package: row.packageName,
      domain: row.registrableDomain,
      account: row.firstRegisteredBy,
    }
    const kinds = MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS.filter((kind) => ruled.has(`${kind}\u0000${keys[kind]}`))
    if (kinds.length > 0) covering.set(row.url, kinds)
  }
  return covering
}
