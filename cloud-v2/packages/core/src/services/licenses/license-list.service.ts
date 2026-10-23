/**
 * @fileoverview The admin portal's license list: every license, with the workspace that holds it.
 *
 * Read-only. It lists what billing last wrote (`license.service.ts`) and changes nothing: no seat, no term.
 *
 * **Who holds a license.** A workspace, the only owner a license has, shown by its name (`workspaces`), also
 * after it is deleted; a workspace Core has no record of shows by its id. The workspaces of a page are read in
 * one query, however many rows the page has.
 *
 * **Paging.** Newest first by license id (a ULID, so by creation), `LICENSE_PAGE_SIZE` at a time. The cursor is
 * the last id of a page and the next page is everything older, so a license written meanwhile never moves a
 * row from one page to the next. Both are served by the `_id` index.
 *
 * **Search.** A query is plain text, trimmed and compared case-insensitively as a substring (never a pattern)
 * of the workspace's name or id, or of the product. The licenses collection is small (one row per paying
 * workspace and product), so a search does not index workspaces' names: it reads the distinct workspaces that
 * hold a license (the owner index covers that) and their names in one batch, picks the ones whose text
 * contains the query, and asks `licenses` for theirs with the same ordering and cursor as the unfiltered list.
 * A search therefore costs a read of every workspace that holds a license, however few match, which is what a
 * few thousand licenses can afford and a few hundred thousand cannot; past that, store the workspace's name on
 * the license when billing writes it. No index is added to a populated collection.
 */

import type {AdminLicenseOwner, AdminLicenseView, AdminLicensesResponse} from "@mentra/workspace-contract"
import {LicenseModel, type LicenseRow} from "../../models/license.model"
import {WorkspaceModel} from "../../models/workspace.model"

/** How many licenses a page holds. */
export const LICENSE_PAGE_SIZE = 50
/** The longest search text, in characters. */
export const LICENSE_QUERY_MAX_LENGTH = 100
/** The longest cursor, in characters: a license id is 26. */
export const LICENSE_CURSOR_MAX_LENGTH = 64

/** What Core calls each workspace of a set of licenses, by workspace id. */
type WorkspaceNames = Map<string, string>

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
  const names = await workspaceNames(unique(page.flatMap(row => (row.owner.workspaceId ? [row.owner.workspaceId] : []))))
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
 * The filter for the licenses whose workspace's name or id, or whose product, contains `needle` (lowercase), or
 * null when nothing can match.
 */
async function matchingLicenses(needle: string): Promise<Record<string, unknown> | null> {
  const [workspaceIds, products] = await Promise.all([
    LicenseModel.distinct("owner.workspaceId", {"owner.type": "workspace"}),
    LicenseModel.distinct("product"),
  ])
  const workspaces = (workspaceIds as unknown[]).filter((id): id is string => typeof id === "string")
  const names = await workspaceNames(workspaces)

  const contains = (...texts: Array<string | null | undefined>) =>
    texts.some(text => typeof text === "string" && text.toLowerCase().includes(needle))
  const matchingWorkspaces = workspaces.filter(id => contains(id, names.get(id)))
  const matchingProducts = (products as unknown[]).filter(
    (product): product is string => typeof product === "string" && contains(product),
  )

  const either: Array<Record<string, unknown>> = []
  if (matchingWorkspaces.length > 0) {
    either.push({"owner.type": "workspace", "owner.workspaceId": {$in: matchingWorkspaces}})
  }
  if (matchingProducts.length > 0) either.push({product: {$in: matchingProducts}})
  return either.length > 0 ? {$or: either} : null
}

// --- Owners ------------------------------------------------------------------

/** The names of these workspaces, in one query. A workspace Core has no record of is absent. */
async function workspaceNames(workspaceIds: string[]): Promise<WorkspaceNames> {
  if (workspaceIds.length === 0) return new Map()
  const rows = await WorkspaceModel.find({workspaceId: {$in: workspaceIds}}, {workspaceId: 1, name: 1}).lean()
  return new Map(rows.map(row => [row.workspaceId, row.name]))
}

function ownerView(owner: LicenseRow["owner"], names: WorkspaceNames): AdminLicenseOwner {
  const workspaceId = owner.workspaceId ?? ""
  return {type: "workspace", workspaceId, name: names.get(workspaceId) ?? null}
}

function licenseView(row: LicenseRow, names: WorkspaceNames): AdminLicenseView {
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
