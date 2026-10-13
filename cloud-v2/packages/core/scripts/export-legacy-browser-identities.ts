/**
 * @fileoverview Export the verified emails of the Store's WorkOS users, for the membership claim.
 *
 * Usage:
 *
 *   WORKOS_API_KEY=… bun packages/core/scripts/export-legacy-browser-identities.ts \
 *     --target <core mongo url> [--apply] [--i-understand-remote]
 *
 * Run it after `migrate-store-developer-orgs.ts`, against the same Core database.
 * It collects the WorkOS user ids that still matter to Core: those of active
 * memberships imported from the Store and waiting for their person
 * (`workspace_memberships.pendingWorkosUserId`), and enterprise org owners that are
 * not Core users (`enterprise_orgs.ownerUserId` not starting `mu_`). It reads each
 * user from WorkOS (`GET https://api.workos.com/user_management/users/:id`, with
 * `WORKOS_API_KEY` from the operator's shell; Core itself does not use it) and
 * writes `legacy_browser_identities` only where WorkOS reports the email verified:
 * the WorkOS user id and the email, lowercased. A person's first sign-in or Core
 * request with that verified email then claims what waits under the id
 * (`membership-claim.service.ts`).
 *
 * Without `--apply` it writes nothing: it reads the target through a read-only
 * connection, asks WorkOS, and prints what an apply would write. Every run prints a
 * JSON report on stdout (progress goes to stderr): counts, the users skipped as
 * unverified and the users WorkOS does not know, by WorkOS id only. A WorkOS user
 * without a verified email is never exported; a workspace admin re-invites them.
 *
 * It is idempotent: rows are keyed on the WorkOS user id, an unchanged row is not
 * written, an unclaimed row whose email WorkOS changed is updated, and an identity
 * someone has claimed is neither asked about again nor changed. WorkOS is read for
 * every user before anything is written, so a WorkOS failure (anything but a user
 * it does not know, after retrying rate limits and server errors) stops the export
 * with nothing written.
 *
 * Safety: `--apply` refuses unless the URL is local (`mongodb://` on 127.0.0.1,
 * localhost or [::1], without credentials) or `--i-understand-remote` is given, the
 * same guard as `migrate-store-developer-orgs.ts`.
 */

import mongoose, {type Connection} from "mongoose"
import {LegacyBrowserIdentityModel} from "../src/models/legacy-browser-identity.model"
import {isLocalMongoUrl, splitMongoUrl} from "./mongo-url"

const WORKOS_USERS_URL = "https://api.workos.com/user_management/users/"
const COLLECTIONS = {
  memberships: "workspace_memberships",
  enterpriseOrgs: "enterprise_orgs",
  identities: "legacy_browser_identities",
} as const
/** Attempts per WorkOS user when WorkOS rate-limits or fails on its side. */
const MAX_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 1_000

/** The export cannot finish, for a reason the operator has to act on. Nothing was written. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExportError"
  }
}

/** The command line is wrong or unsafe. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export type ExportReport = {
  mode: "dry-run" | "apply"
  /**
   * `workosUsers`: the WorkOS user ids collected. `verified`: those WorkOS reports with a verified email,
   * which are `inserted`, `updated` (an unclaimed row whose email changed) or `unchanged`. In a dry run,
   * what an apply would do.
   */
  counts: {
    workosUsers: number
    verified: number
    inserted: number
    updated: number
    unchanged: number
    skippedUnverified: number
    notFound: number
    alreadyClaimed: number
  }
  /** WorkOS users without a verified email: never exported. */
  skippedUnverified: string[]
  /** WorkOS user ids WorkOS does not know. */
  notFound: string[]
  /** WorkOS users whose identity a person has already claimed: left as they are. */
  alreadyClaimed: string[]
}

export type ExportOptions = {
  apply: boolean
  /** A dry run: a read-only connection to the target. An apply uses the default mongoose connection. */
  target?: Connection
  /** The WorkOS API key. */
  apiKey: string
  /** WorkOS is reached through this (tests stub it). */
  fetch?: typeof fetch
  /** The base delay between retries of a rate-limited or failed WorkOS request (tests use 0). */
  retryDelayMs?: number
  log?: (message: string) => void
}

/** Collect, ask WorkOS, and (with `apply`) write. Returns the report. */
export async function exportLegacyBrowserIdentities(options: ExportOptions): Promise<ExportReport> {
  const log = options.log ?? (() => {})
  if (!options.apiKey) throw new UsageError("WORKOS_API_KEY is required")
  const db = options.apply ? mongoose.connection.db : options.target?.db
  if (!db) {
    throw new ExportError(
      options.apply ? "--apply needs the default mongoose connection connected to the target" : "the target connection is not open",
    )
  }

  const pending = await db
    .collection(COLLECTIONS.memberships)
    .distinct("pendingWorkosUserId", {status: "active", pendingWorkosUserId: {$type: "string"}})
  const owners = await db
    .collection(COLLECTIONS.enterpriseOrgs)
    .distinct("ownerUserId", {ownerUserId: {$type: "string", $not: /^mu_/}})
  const workosUserIds = [...new Set([...pending, ...owners].filter(isNonEmptyString))].sort()

  const existing = new Map(
    (
      await db
        .collection(COLLECTIONS.identities)
        .find({workosUserId: {$in: workosUserIds}}, {projection: {_id: 0, workosUserId: 1, email: 1, claimedAt: 1}})
        .toArray()
    ).map(row => [String(row.workosUserId), {email: String(row.email), claimed: row.claimedAt != null}]),
  )

  const report: ExportReport = {
    mode: options.apply ? "apply" : "dry-run",
    counts: {
      workosUsers: workosUserIds.length,
      verified: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skippedUnverified: 0,
      notFound: 0,
      alreadyClaimed: 0,
    },
    skippedUnverified: [],
    notFound: [],
    alreadyClaimed: [],
  }

  // Ask WorkOS about everyone first: a failure stops the export before anything is written.
  const writes: Array<{workosUserId: string; email: string; insert: boolean}> = []
  for (const workosUserId of workosUserIds) {
    const known = existing.get(workosUserId)
    if (known?.claimed) {
      report.alreadyClaimed.push(workosUserId)
      continue
    }
    const user = await readWorkosUser(workosUserId, options)
    if (!user) {
      report.notFound.push(workosUserId)
      continue
    }
    const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : ""
    if (user.email_verified !== true || !email) {
      report.skippedUnverified.push(workosUserId)
      continue
    }
    report.counts.verified += 1
    if (!known) writes.push({workosUserId, email, insert: true})
    else if (known.email !== email) writes.push({workosUserId, email, insert: false})
    else report.counts.unchanged += 1
  }
  report.counts.skippedUnverified = report.skippedUnverified.length
  report.counts.notFound = report.notFound.length
  report.counts.alreadyClaimed = report.alreadyClaimed.length

  if (options.apply) {
    // Created empty, with its unique index, if Core's startup has not made it yet.
    await LegacyBrowserIdentityModel.createCollection()
    await LegacyBrowserIdentityModel.createIndexes()
  }
  for (const write of writes) {
    if (!options.apply) {
      report.counts[write.insert ? "inserted" : "updated"] += 1
      continue
    }
    // Keyed on the WorkOS user id, and never touching an identity someone has claimed meanwhile.
    const result = await LegacyBrowserIdentityModel.updateOne(
      {workosUserId: write.workosUserId, claimedAt: null},
      {$set: {email: write.email}, $setOnInsert: {claimedBy: null}},
      {upsert: true},
    ).catch((err: unknown) => {
      if ((err as {code?: number})?.code === 11000) return null
      throw err
    })
    if (!result) {
      report.alreadyClaimed.push(write.workosUserId)
      report.counts.alreadyClaimed += 1
      report.counts.verified -= 1
      continue
    }
    report.counts[result.upsertedCount === 1 ? "inserted" : "updated"] += 1
  }
  log(
    `${report.counts.workosUsers} WorkOS user(s): ${report.counts.verified} verified, ` +
      `${report.counts.skippedUnverified} unverified, ${report.counts.notFound} not found, ${report.counts.alreadyClaimed} already claimed`,
  )
  return report
}

type WorkosUser = {id?: string; email?: unknown; email_verified?: unknown}

/** One user from WorkOS, or null when WorkOS does not know the id. Retries rate limits and server errors. */
async function readWorkosUser(workosUserId: string, options: ExportOptions): Promise<WorkosUser | null> {
  const doFetch = options.fetch ?? fetch
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await doFetch(`${WORKOS_USERS_URL}${encodeURIComponent(workosUserId)}`, {
        headers: {authorization: `Bearer ${options.apiKey}`, accept: "application/json"},
      })
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new ExportError(`WorkOS could not be reached for ${workosUserId}: ${(err as Error)?.message ?? String(err)}`)
      }
      await sleep(baseDelay * 2 ** (attempt - 1))
      continue
    }
    if (response.status === 404) return null
    if (response.ok) return (await response.json()) as WorkosUser
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new ExportError(`WorkOS answered ${response.status} for ${workosUserId}; nothing was written`)
    }
    const retryAfter = Number(response.headers.get("retry-after"))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** (attempt - 1))
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

// --- Command line ----------------------------------------------------------

export type CliOptions = {target: string; apply: boolean; allowRemote: boolean}

const USAGE = `Usage: WORKOS_API_KEY=… bun packages/core/scripts/export-legacy-browser-identities.ts \\
  --target <core mongo url> [--apply] [--i-understand-remote]

Without --apply the script prints a JSON report and writes nothing. --apply refuses a non-local
--target; --i-understand-remote lifts that and is for the operator only.`

/** Parse the command line, refusing anything unsafe before any connection is opened. */
export function parseArgs(argv: string[]): CliOptions {
  let target: string | undefined
  let apply = false
  let allowRemote = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const equals = token.indexOf("=")
    const flag = token.startsWith("--") && equals !== -1 ? token.slice(0, equals) : token
    const inline = token.startsWith("--") && equals !== -1 ? token.slice(equals + 1) : undefined
    if (flag === "--target") {
      const value = inline ?? argv[++i]
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError("--target needs a value")
      if (target !== undefined) throw new UsageError("--target was given more than once")
      target = value
    } else if ((flag === "--apply" || flag === "--i-understand-remote") && inline === undefined) {
      if (flag === "--apply") apply = true
      else allowRemote = true
    } else {
      throw new UsageError(`unknown argument ${token}`)
    }
  }
  if (target === undefined) throw new UsageError("--target is required")
  const parts = splitMongoUrl(target)
  if (!parts) throw new UsageError("--target must be a mongodb:// or mongodb+srv:// URL")
  if (apply && !allowRemote && !isLocalMongoUrl(target)) {
    throw new UsageError(
      `--apply refuses a non-local --target (${parts.hosts.join(",")}): it must be mongodb:// on 127.0.0.1, ` +
        "localhost or [::1] without credentials. Operators can pass --i-understand-remote.",
    )
  }
  return {target, apply, allowRemote}
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE)
    return
  }
  let options: CliOptions
  try {
    options = parseArgs(argv)
    if (!process.env.WORKOS_API_KEY?.trim()) throw new UsageError("WORKOS_API_KEY is required in the environment")
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    if (err instanceof UsageError) console.error(`\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.apply && options.allowRemote) {
    console.error("warning: --i-understand-remote is set; --apply may write to a non-local database")
  }

  const apiKey = process.env.WORKOS_API_KEY!.trim()
  let readOnly: Connection | undefined
  try {
    let report: ExportReport
    if (options.apply) {
      // No automatic collections or indexes: the export creates only the one it writes.
      await mongoose.connect(options.target, {serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false})
      report = await exportLegacyBrowserIdentities({apply: true, apiKey, log: message => console.error(message)})
    } else {
      readOnly = await mongoose
        .createConnection(options.target, {serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false})
        .asPromise()
      report = await exportLegacyBrowserIdentities({apply: false, target: readOnly, apiKey, log: message => console.error(message)})
    }
    console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await readOnly?.close()
    await mongoose.disconnect()
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
