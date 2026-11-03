/**
 * @fileoverview What the registry answers over Core's signed service API (`api/internal/registry.api.ts`): Fleet's
 * `check` and `lookup`, and the directory's entry reads and archiving. The registry itself is
 * `registry.service.ts`.
 *
 * **Check (Fleet).** An admin assigning miniapp URLs to a workspace. A URL the registry holds is answered from its
 * entry. Core registers a URL it doesn't know as the admin's own install would, with the admin as the person
 * registering: the same archive rules, the same hourly allowance, the same read and domain rule. Fleet decides who may
 * assign (`miniapps.assign`, which an Organization Admin holds in any workspace); Core decides what the token claims. A
 * sign-in challenge from an active member of the workspace gets a token that names the assigning workspace, because
 * that workspace is assigning the package. Anyone else, such as an Organization Admin who isn't a member, gets their
 * own token under the ordinary rules, which never claims a workspace they aren't in: a server that admits only the
 * workspace's members refuses it, and the URL is assignable with its package only. A private entry is read again each
 * time, with that check's token, so its name goes only to a workspace its server admits. A URL Core can't
 * read and no phone has reported is `unreachable`: no entry is made, and it can be assigned once a phone has
 * installed it. Core reads at most 8 URLs at once and answers within 10 seconds; a URL it hasn't finished is
 * `unknown`, and its read finishes in the background.
 *
 * **Lookup (Fleet).** Names for a workspace's views: per package, the most recently verified active entry (a
 * phone-reported one when none is verified), or the most recent archived one when every entry is archived. A private
 * miniapp is named only for a workspace whose assigned set (Fleet's last push) holds the package.
 *
 * **Entries and archiving (the directory).** The directory reads an entry and Core's verified `miniapp.json`, and
 * shows no developer text Core didn't verify: a private or phone-reported entry comes with its URL and package only.
 * It archives for a staff member, recorded in the admin action audit log beside the admin portal's archives
 * (`miniapp_registry.archive`), with the Store as the service and the staff member as the actor.
 */

import {createLogger} from "@mentra/cloud-shared"
import {
  MINIAPP_PACKAGE_NAME_PATTERN,
  normalizeMiniappUrl,
  type RegistryEntryView as PhoneRegistryEntryView,
} from "@mentra/cloud-protocol"
import type {
  RegistryArchiveResponse,
  RegistryArchiveRule,
  RegistryCheckResult,
  RegistryCheckStatus,
  RegistryEntryDetail,
  RegistryEntryView,
  RegistryLookupEntry,
  RegistryManifest,
} from "@mentra/workspace-contract"
import {AdminActionAuditLogModel} from "../../models/admin-action-audit-log.model"
import {MiniappRegistryEntryModel} from "../../models/miniapp-registry.model"
import {WorkspaceAssignedPackagesModel} from "../../models/workspace-assigned-packages.model"
import {mintMiniappTokenFor} from "../miniapp-token.service"
import {getUser, isDeletedAccountId} from "../user.service"
import {getActiveMembership, getWorkspace} from "../workspaces/workspace.service"
import {
  answerWithoutReading,
  archive,
  archivedUrls,
  consumeRegistration,
  entryView,
  isArchived,
  registerMiniappUrl,
  RegistryRequestError,
  type ChallengeTokenSource,
  type RegisterMiniappUrlResult,
  type RegistryEntryRow,
  type RegistryRegistrant,
} from "./registry.service"

const logger = createLogger("core").child({service: "registry-service-api"})

/** URLs one check reads at once. */
export const REGISTRY_CHECK_CONCURRENCY = 8
/** How long one check may take; a URL not finished by then is `unknown`. */
export const REGISTRY_CHECK_DEADLINE_MS = 10_000

// The service API shows entries exactly as the phone's calls do: this fails to compile if the two drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameEntryView: Same<RegistryEntryView, PhoneRegistryEntryView> = true
void sameEntryView

/**
 * The workspace a check names isn't an active one, or the person isn't a live account: no one there to check for.
 * Answered `403 not_a_member`.
 */
export class RegistryCheckRefused extends Error {
  readonly code = "not_a_member"
  constructor() {
    super("the workspace is not active, or the person is not a live account")
    this.name = "RegistryCheckRefused"
  }
}

// --- Check -------------------------------------------------------------------

/** Registrations a check started that are still running, so tests and shutdown can wait for them. */
const backgroundReads = new Set<Promise<void>>()

/** Resolves once no read a check started is still running. */
export async function registryChecksIdle(): Promise<void> {
  while (backgroundReads.size > 0) await Promise.allSettled([...backgroundReads])
}

type CheckAnswer = Omit<RegistryCheckResult, "url">

/**
 * What the registry says of each URL an admin of `workspaceId` is assigning, in order, with each URL as sent (see
 * the file comment). Throws `RegistryCheckRefused` when `workspaceId` isn't active or `mentraUserId` isn't a live
 * account.
 */
export async function checkRegistryUrls(
  input: {urls: string[]; workspaceId: string; mentraUserId: string},
  options: {concurrency?: number; deadlineMs?: number} = {},
): Promise<RegistryCheckResult[]> {
  const startedAt = Date.now()
  const {registrant, member} = await assigningAdmin(input.workspaceId, input.mentraUserId)
  const tokenFor: ChallengeTokenSource = async (packageName) =>
    (
      await mintMiniappTokenFor({
        mentraUserId: registrant.mentraUserId,
        tenantId: registrant.tenantId,
        packageName,
        // Only a member's token names the workspace: a claim is never false.
        ...(member ? {assigningWorkspaceId: input.workspaceId} : {}),
      })
    ).token

  // Each distinct registry key once; anything that can't be one is never read.
  const keys = input.urls.map((url) => {
    const normalized = normalizeMiniappUrl(url)
    return normalized?.kind === "public" ? normalized.url : null
  })
  const distinct = [...new Set(keys.filter((key): key is string => key !== null))]
  const rows =
    distinct.length > 0 ? await MiniappRegistryEntryModel.find({url: {$in: distinct}}).lean<RegistryEntryRow[]>() : []
  const byUrl = new Map(rows.map((row) => [row.url, row]))
  const archived = await archivedUrls(rows)

  const answers = new Map<string, CheckAnswer>()
  const toRead: string[] = []
  for (const key of distinct) {
    const row = byUrl.get(key)
    if (row && archived.has(key)) answers.set(key, fromRow("archived", row))
    // A private entry is read again with this workspace's token: only its server says whether it may be named.
    else if (row && !row.private) {
      answers.set(key, fromRow(row.verification === "verified" ? "accepted" : "accepted_unverified", row))
    } else toRead.push(key)
  }

  await readWithin(toRead, {
    concurrency: options.concurrency ?? REGISTRY_CHECK_CONCURRENCY,
    deadlineAt: startedAt + (options.deadlineMs ?? REGISTRY_CHECK_DEADLINE_MS),
    read: async (key) => answers.set(key, await registerForCheck(key, registrant, tokenFor, byUrl.get(key) ?? null)),
  })

  return input.urls.map((url, index) => {
    const key = keys[index]
    const answer = key ? answers.get(key) : notAMiniapp()
    return {url, ...(answer ?? blank("unknown"))}
  })
}

/** The admin as the person registering, with their tenant, in an active workspace; and whether they are its member. */
async function assigningAdmin(
  workspaceId: string,
  mentraUserId: string,
): Promise<{registrant: RegistryRegistrant; member: boolean}> {
  const [workspace, membership, deleted, user] = await Promise.all([
    getWorkspace(workspaceId),
    getActiveMembership(workspaceId, mentraUserId),
    isDeletedAccountId(mentraUserId),
    getUser(mentraUserId),
  ])
  if (workspace?.status !== "active" || deleted || !user) throw new RegistryCheckRefused()
  return {registrant: {mentraUserId, tenantId: user.tenantId}, member: membership !== null}
}

/**
 * Runs `read` for each key, at most `concurrency` at once, starting none after `deadlineAt`, and resolves by
 * `deadlineAt` whatever is still running. A read that fails is logged and leaves its key unanswered.
 */
async function readWithin(
  keys: string[],
  options: {concurrency: number; deadlineAt: number; read: (key: string) => Promise<unknown>},
): Promise<void> {
  if (keys.length === 0) return
  const queue = [...keys]
  let expired = false
  const worker = async () => {
    while (!expired && queue.length > 0) {
      const key = queue.shift()!
      const running = options.read(key).then(
        () => {},
        (error) => logger.warn({url: key, error: (error as Error)?.message}, "registry: check could not finish a URL"),
      )
      backgroundReads.add(running)
      void running.finally(() => backgroundReads.delete(running))
      await running
    }
  }
  const workers = Promise.all(Array.from({length: Math.min(options.concurrency, queue.length)}, worker))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, options.deadlineAt - Date.now()))
  })
  try {
    await Promise.race([workers, deadline])
  } finally {
    expired = true
    clearTimeout(timer)
  }
}

/**
 * Registers one URL for a check, as a phone's registration would: answered without reading when it can be (archived,
 * not a miniapp URL), then counted against the admin's hourly allowance, then read.
 */
async function registerForCheck(
  url: string,
  registrant: RegistryRegistrant,
  tokenFor: ChallengeTokenSource,
  known: RegistryEntryRow | null,
): Promise<CheckAnswer> {
  let result: RegisterMiniappUrlResult | OverAllowance
  try {
    result =
      (await answerWithoutReading({url, registrant})) ?? (await readUnlessOverAllowance(url, registrant, tokenFor))
  } catch (error) {
    if (error instanceof RegistryRequestError) return notAMiniapp()
    throw error
  }
  switch (result.result) {
    case "accepted":
    case "accepted_unverified":
      return fromView(result.result, result.entry)
    case "not_a_miniapp":
      return blank(result.unreachable ? "unreachable" : "not_a_miniapp")
    case "archived":
      return known ? fromRow("archived", known) : blank("archived")
    case "over_allowance":
      return blank("unknown")
  }
}

/** The admin has used this hour's registrations: the URL isn't read, and is asked about again later. */
type OverAllowance = {result: "over_allowance"}

async function readUnlessOverAllowance(
  url: string,
  registrant: RegistryRegistrant,
  tokenFor: ChallengeTokenSource,
): Promise<RegisterMiniappUrlResult | OverAllowance> {
  if ((await consumeRegistration(registrant.mentraUserId)) !== null) {
    logger.info({url, mentraUserId: registrant.mentraUserId}, "registry: check over the hourly registration allowance")
    return {result: "over_allowance"}
  }
  return registerMiniappUrl({url, registrant, tokenFor})
}

/** An entry Core holds, answered without a read. A private one is described by its URL and package only. */
function fromRow(status: RegistryCheckStatus, row: RegistryEntryRow): CheckAnswer {
  return fromView(status, entryView(row, {redact: row.private === true}))
}

function fromView(status: RegistryCheckStatus, entry: PhoneRegistryEntryView): CheckAnswer {
  return {
    status,
    packageName: entry.packageName,
    name: entry.name,
    iconUrl: entry.iconUrl,
    private: entry.private,
    checkedAt: new Date().toISOString(),
  }
}

function blank(status: RegistryCheckStatus): CheckAnswer {
  return {status, packageName: null, name: null, iconUrl: null, private: false, checkedAt: new Date().toISOString()}
}

const notAMiniapp = () => blank("not_a_miniapp")

// --- Lookup ------------------------------------------------------------------

/** The newest first: most recently verified, then most recently reported or read, then registered. */
function newerFirst(a: RegistryEntryRow, b: RegistryEntryRow): number {
  const time = (date: Date | null | undefined) => (date instanceof Date ? date.getTime() : -Infinity)
  return (
    time(b.lastVerifiedAt) - time(a.lastVerifiedAt) ||
    time(b.lastVerifyAttemptAt) - time(a.lastVerifyAttemptAt) ||
    time(b.firstRegisteredAt) - time(a.firstRegisteredAt) ||
    (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
  )
}

/** Names for `workspaceId`'s views, for every package asked about (see the file comment). */
export async function lookupRegistryPackages(input: {
  workspaceId: string
  packageNames: string[]
}): Promise<Record<string, RegistryLookupEntry | null>> {
  const names = [...new Set(input.packageNames.filter((name) => MINIAPP_PACKAGE_NAME_PATTERN.test(name)))]
  const [rows, assigned] = await Promise.all([
    names.length > 0
      ? MiniappRegistryEntryModel.find({packageName: {$in: names}})
          .select({
            _id: 0,
            url: 1,
            packageName: 1,
            registrableDomain: 1,
            name: 1,
            iconUrl: 1,
            private: 1,
            status: 1,
            verification: 1,
            firstRegisteredAt: 1,
            firstRegisteredBy: 1,
            lastVerifiedAt: 1,
            lastVerifyAttemptAt: 1,
          })
          .lean<RegistryEntryRow[]>()
      : Promise.resolve([] as RegistryEntryRow[]),
    WorkspaceAssignedPackagesModel.findOne({workspaceId: input.workspaceId})
      .select({_id: 0, packageNames: 1})
      .lean<{packageNames?: string[]}>(),
  ])
  const archived = await archivedUrls(rows)
  const assignedHere = new Set(assigned?.packageNames ?? [])
  const byPackage = new Map<string, RegistryEntryRow[]>()
  for (const row of rows) byPackage.set(row.packageName, [...(byPackage.get(row.packageName) ?? []), row])

  // Built from the names asked about, so a name such as `__proto__` is an own entry like any other.
  return Object.fromEntries(
    input.packageNames.map((packageName): [string, RegistryLookupEntry | null] => {
      const entries = [...(byPackage.get(packageName) ?? [])].sort(newerFirst)
      const chosen = entries.find((row) => !archived.has(row.url)) ?? entries[0]
      if (!chosen) return [packageName, null]
      const named = chosen.private !== true || assignedHere.has(packageName)
      return [
        packageName,
        {
          name: named ? (chosen.name ?? null) : null,
          iconUrl: named ? (chosen.iconUrl ?? null) : null,
          private: chosen.private === true,
          archived: archived.has(chosen.url),
        },
      ]
    }),
  )
}

// --- The directory -----------------------------------------------------------

/**
 * The registry's entry for a miniapp URL as the directory sees it, or null when the registry has none. A private or
 * phone-reported entry comes with its URL and package only, and no manifest.
 */
export async function registryEntryForDirectory(input: string): Promise<RegistryEntryDetail | null> {
  const normalized = normalizeMiniappUrl(input)
  if (normalized?.kind !== "public") return null
  const row = await MiniappRegistryEntryModel.findOne({url: normalized.url}).lean<RegistryEntryRow>()
  if (!row) return null
  const hidden = row.private === true || row.verification !== "verified"
  const view = entryView(row, {redact: hidden, archived: await isArchived(row)})
  return {...view, manifest: hidden ? null : storedManifest(row)}
}

/** Core's verified copy of the entry's `miniapp.json`, or null when it can't be read back. */
function storedManifest(row: RegistryEntryRow): RegistryManifest | null {
  if (!row.manifest) return null
  try {
    const manifest: unknown = JSON.parse(row.manifest)
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) return manifest as RegistryManifest
  } catch {
    // Logged below.
  }
  logger.error({url: row.url}, "registry: an entry's stored manifest is not a JSON object")
  return null
}

/**
 * Archives `rule` for a staff member acting through the directory, and records it in the admin action audit log as
 * the admin portal records its own archives (`miniapp_registry.archive`), with the Store as the service and
 * `actorEmail` as the actor. Throws `RegistryRequestError` for a rule that can't name any entry.
 */
export async function archiveForDirectory(input: {
  rule: RegistryArchiveRule
  reason: string
  actorEmail: string
}): Promise<RegistryArchiveResponse> {
  const actor = `store:${input.actorEmail}`
  const reason = input.reason.trim()
  const result = await archive(input.rule, {reason, createdBy: actor})
  await AdminActionAuditLogModel.create({
    adminId: actor,
    action: "miniapp_registry.archive",
    targetType: "miniapp_registry_rule",
    targetId: `${result.rule.kind}:${result.rule.value}`,
    reason: reason || null,
    metadata: {
      service: "store",
      actorEmail: input.actorEmail,
      created: result.created,
      entriesArchived: result.entriesArchived,
    },
  })
  return {rule: result.rule, created: result.created, entriesArchived: result.entriesArchived}
}
