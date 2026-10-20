/**
 * @fileoverview The admin portal's license list: every license, workspace and personal, with who holds it.
 *
 * Read-only. It lists what billing last wrote (`license.service.ts`) and changes nothing: no seat, no term.
 *
 * **Who holds a license.** A workspace shows by its name (`workspaces`), also after it is deleted. A person
 * shows by the name and email of their latest sign-in through Core's sign-in server (`signin_identities`), and
 * by Core's copy of their verified email (`account_emails`) when they have not signed in through it. Core's
 * `users` collection holds no name or email. Both rows go with a deleted account, so its license shows the id.
 * The owners of a page are read in one query per collection, however many rows the page has.
 *
 * **Paging.** Newest first by license id (a ULID, so by creation), `LICENSE_PAGE_SIZE` at a time. The cursor is
 * the last id of a page and the next page is everything older, so a license written meanwhile never moves a
 * row from one page to the next. Both are served by the `_id` index.
 *
 * **Search.** A query is plain text, trimmed and compared case-insensitively as a substring (never a pattern)
 * of the owner's name, email or id, or of the product. The licenses collection is small (one row per paying
 * owner), so a search does not index owners' names: it reads the distinct owners that hold a license (the
 * owner indexes cover that) and their names in one batch per collection, picks the ones whose text contains the
 * query, and asks `licenses` for theirs with the same ordering and cursor as the unfiltered list. A search
 * therefore costs a read of every owner that holds a license, however few match, which is what a few
 * thousand licenses can afford and a few hundred thousand cannot; past that, store the owner's display text on
 * the license when billing writes it. No index is added to a populated collection.
 */

import type {AdminLicenseOwner, AdminLicenseView, AdminLicensesResponse} from "@mentra/workspace-contract"
import {AccountEmailModel} from "../../models/account-email.model"
import {LicenseModel, type LicenseRow} from "../../models/license.model"
import {SigninIdentityModel} from "../../models/signin-identity.model"
import {WorkspaceModel} from "../../models/workspace.model"

/** How many licenses a page holds. */
export const LICENSE_PAGE_SIZE = 50
/** The longest search text, in characters. */
export const LICENSE_QUERY_MAX_LENGTH = 100
/** The longest cursor, in characters: a license id is 26. */
export const LICENSE_CURSOR_MAX_LENGTH = 64

/** What Core knows to call each owner of a set of licenses. */
interface OwnerNames {
  workspaces: Map<string, string>
  people: Map<string, {name: string | null; email: string | null}>
}

/** A page of licenses, `options.cursor` being the `next` of the page before it, and `options.query` the search text. */
export async function listAllLicenses(options: {query?: string; cursor?: string} = {}): Promise<AdminLicensesResponse> {
  const conditions: Array<Record<string, unknown>> = []
  if (options.cursor) conditions.push({_id: {$lt: options.cursor}})
  const query = (options.query ?? "").trim().toLowerCase()
  if (query) {
    const matching = await matchingLicenses(query)
    if (!matching) return {items: [], next: null}
    conditions.push(matching)
  }

  const rows = await LicenseModel.find(conditions.length > 0 ? {$and: conditions} : {})
    .sort({_id: -1})
    .limit(LICENSE_PAGE_SIZE + 1)
    .lean<LicenseRow[]>()
  const page = rows.slice(0, LICENSE_PAGE_SIZE)
  const names = await ownerNames(
    unique(page.flatMap(row => (row.owner.type === "workspace" && row.owner.workspaceId ? [row.owner.workspaceId] : []))),
    unique(page.flatMap(row => (row.owner.type === "person" && row.owner.mentraUserId ? [row.owner.mentraUserId] : []))),
  )
  return {
    items: page.map(row => licenseView(row, names)),
    next: rows.length > LICENSE_PAGE_SIZE ? page[page.length - 1]!._id : null,
  }
}

/** Whether Core holds any license at all, ended ones included. */
export async function anyLicenseExists(): Promise<boolean> {
  return (await LicenseModel.exists({})) !== null
}

const unique = (ids: string[]) => [...new Set(ids)]

// --- Search ------------------------------------------------------------------

/**
 * The filter for the licenses whose owner's name, email or id, or whose product, contains `needle` (lowercase),
 * or null when nothing can match.
 */
async function matchingLicenses(needle: string): Promise<Record<string, unknown> | null> {
  const [workspaceIds, mentraUserIds, products] = await Promise.all([
    LicenseModel.distinct("owner.workspaceId", {"owner.type": "workspace"}),
    LicenseModel.distinct("owner.mentraUserId", {"owner.type": "person"}),
    LicenseModel.distinct("product"),
  ])
  const workspaces = (workspaceIds as unknown[]).filter((id): id is string => typeof id === "string")
  const people = (mentraUserIds as unknown[]).filter((id): id is string => typeof id === "string")
  const names = await ownerNames(workspaces, people)

  const contains = (...texts: Array<string | null | undefined>) =>
    texts.some(text => typeof text === "string" && text.toLowerCase().includes(needle))
  const matchingWorkspaces = workspaces.filter(id => contains(id, names.workspaces.get(id)))
  const matchingPeople = people.filter(id => {
    const person = names.people.get(id)
    return contains(id, person?.name, person?.email)
  })
  const matchingProducts = (products as unknown[]).filter(
    (product): product is string => typeof product === "string" && contains(product),
  )

  const either: Array<Record<string, unknown>> = []
  if (matchingWorkspaces.length > 0) {
    either.push({"owner.type": "workspace", "owner.workspaceId": {$in: matchingWorkspaces}})
  }
  if (matchingPeople.length > 0) either.push({"owner.type": "person", "owner.mentraUserId": {$in: matchingPeople}})
  if (matchingProducts.length > 0) either.push({product: {$in: matchingProducts}})
  return either.length > 0 ? {$or: either} : null
}

// --- Owners ------------------------------------------------------------------

/** The names of these workspaces and people, one query per collection. An owner Core knows nothing of is absent. */
async function ownerNames(workspaceIds: string[], mentraUserIds: string[]): Promise<OwnerNames> {
  const [workspaces, identities, emails] = await Promise.all([
    workspaceIds.length > 0
      ? WorkspaceModel.find({workspaceId: {$in: workspaceIds}}, {workspaceId: 1, name: 1}).lean()
      : [],
    mentraUserIds.length > 0
      ? SigninIdentityModel.find({mentraUserId: {$in: mentraUserIds}}, {mentraUserId: 1, name: 1, email: 1}).lean()
      : [],
    mentraUserIds.length > 0
      ? AccountEmailModel.find({mentraUserId: {$in: mentraUserIds}, deletedAt: null}, {mentraUserId: 1, email: 1}).lean()
      : [],
  ])

  const identityOf = new Map(identities.map(row => [row.mentraUserId, row]))
  const emailOf = new Map(emails.map(row => [row.mentraUserId, row.email ?? null]))
  const people = new Map<string, {name: string | null; email: string | null}>()
  for (const id of mentraUserIds) {
    const identity = identityOf.get(id)
    const name = identity?.name ?? null
    const email = identity?.email ?? emailOf.get(id) ?? null
    if (name !== null || email !== null) people.set(id, {name, email})
  }
  return {workspaces: new Map(workspaces.map(row => [row.workspaceId, row.name])), people}
}

function ownerView(owner: LicenseRow["owner"], names: OwnerNames): AdminLicenseOwner {
  if (owner.type === "workspace") {
    const workspaceId = owner.workspaceId ?? ""
    return {type: "workspace", workspaceId, name: names.workspaces.get(workspaceId) ?? null}
  }
  const mentraUserId = owner.mentraUserId ?? ""
  const person = names.people.get(mentraUserId)
  return {type: "person", mentraUserId, name: person?.name ?? null, email: person?.email ?? null}
}

function licenseView(row: LicenseRow, names: OwnerNames): AdminLicenseView {
  return {
    licenseId: row._id,
    owner: ownerView(row.owner, names),
    product: row.product,
    quantity: row.quantity,
    seatsUsed: row.seatsUsed,
    validFrom: row.validFrom.toISOString(),
    paidThrough: row.paidThrough.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedReason: row.endedReason ?? null,
  }
}
