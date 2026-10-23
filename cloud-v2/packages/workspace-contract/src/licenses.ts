/**
 * Licenses: what billing writes into Core (`PUT /api/internal/licenses/:licenseId`, the Store only) and
 * what Core shows of them, to billing (`GET /api/internal/licenses`), to people (the workspace routes'
 * `GET /:workspaceId/licenses`) and to Organization Admins (the admin portal's `GET /api/admin/licenses`).
 * See Core's `docs/licenses.md`.
 *
 * A license is a quantity of one product for a term, held by a workspace: its Admins and Owners assign the
 * seats to members, and a person has a license only through a seat. Core keeps a copy of each license as
 * billing last wrote it, and who holds each seat.
 */

/** The owners a license can have: a workspace, and nothing else. A typed field, so another could be added. */
export const LICENSE_OWNER_TYPES = ["workspace"] as const

/** Who holds a license: a workspace. */
export type LicenseOwner = {type: "workspace"; workspaceId: string}

/**
 * A feature a license unlocks (`call.unlimited`) and the packages it is for (`com.mentra.call`).
 * `packages` may be empty: a feature a service checks rather than a miniapp.
 */
export interface LicenseFeature {
  key: string
  packages: string[]
}

/**
 * One license as billing last computed it. Core applies it only if `revision` is newer than the one it
 * has: an equal revision is a repeat (200, nothing changes) and an older one is refused (409
 * {@link STALE_REVISION_ERROR}), so a write may be sent again until Core accepts it, in any order.
 */
export interface LicenseWrite {
  /** Billing's id for the license, a ULID. */
  licenseId: string
  /** A whole number above zero that grows with every change billing makes. */
  revision: number
  /** Never changes for a license. */
  owner: LicenseOwner
  /** The product, e.g. `mentra.call.unlimited`. */
  product: string
  features: LicenseFeature[]
  /** Seats, for the workspace's Admins and Owners to assign. */
  quantity: number
  /** RFC 3339, UTC (`Z`). */
  validFrom: string
  /** RFC 3339, UTC (`Z`). The features stop after it. */
  paidThrough: string
  /**
   * The purchase's buyer, by Core user ID, on every write of a subscription billing checked out, so the
   * first write to reach Core carries it whatever order they come in. Core gives them one seat only on the
   * write that creates the license, and only when they are an active member of the owner workspace, the
   * license has a seat to give (`quantity` of 1 or more), and they hold no seat of an in-term license of the
   * same product in that workspace; otherwise, and on every later write, it assigns nothing. A Core that
   * predates it ignores it.
   */
  assignTo?: {mentraUserId: string}
  /**
   * A person's request for one more seat for themselves: the request's id, their Core user ID, and the
   * quantity the license reaches once it is added. Billing names it on the write whose quantity reaches it,
   * and on every later write until Core accepts one that carries it. Core decides each request once, on the
   * first applied write (a new license or a newer revision) that carries an id it hasn't recorded: it records
   * the id whatever it decides, and gives the person one seat only when that write raises the quantity to the
   * request's (the quantity Core had, 0 for a new license, is below it, and the write's is at least it), the
   * person is an active member of the owner workspace, the license has a seat to give, and they hold no seat
   * of an in-term license of the same product in that workspace. Otherwise it assigns nothing, and a repeat or
   * an older revision decides nothing. A Core that predates it ignores it.
   */
  seatRequest?: {requestId: string; mentraUserId: string; quantity: number}
}

/** Core's answer to a license write that it accepted: whether it changed anything, and the revision it has. */
export interface LicenseWriteResponse {
  applied: boolean
  revision: number
}

/** One seat of a workspace license: the membership that holds it. Times are ISO 8601 UTC. */
export interface LicenseSeatView {
  membershipId: string
  mentraUserId: string
  assignedAt: string
}

/**
 * A license as Core holds it. `seatsUsed` is how many seats are assigned, and may exceed `quantity` after a
 * write lowered it: Core frees no seat on its own. `endedAt` is set when its workspace was deleted; Core then
 * refuses further writes for it.
 * `seats` is present where Core lists who holds them (the workspace routes).
 */
export interface LicenseView extends Omit<LicenseWrite, "licenseId" | "assignTo" | "seatRequest"> {
  licenseId: string
  seatsUsed: number
  endedAt: string | null
  seats?: LicenseSeatView[]
}

/** Response of `GET /api/internal/licenses?ownerType=workspace&ownerId=`: one workspace's licenses, ended ones included. */
export interface LicensesResponse {
  licenses: LicenseView[]
}

/**
 * Who holds a license, as the admin portal's list shows it: the workspace, by its name. The name is null when
 * Core has no record of the workspace, and the portal then shows the id.
 */
export type AdminLicenseOwner = {type: "workspace"; workspaceId: string; name: string | null}

/** One license in the admin portal's list. Times are ISO 8601 UTC; `endedAt` and `endedReason` are null while it stands. */
export interface AdminLicenseView {
  licenseId: string
  owner: AdminLicenseOwner
  product: string
  quantity: number
  seatsUsed: number
  validFrom: string
  paidThrough: string
  endedAt: string | null
  endedReason: LicenseEndedReason | null
}

/**
 * Response of `GET /api/admin/licenses?query=&cursor=`: a page of every license, newest first. `next` is the `cursor` of the page after this one, or null on the last page.
 */
export interface AdminLicensesResponse {
  items: AdminLicenseView[]
  next: string | null
}

/** Why a seat was freed, in a `seat.released` event's `after.reason`. */
export const SEAT_RELEASE_REASONS = [
  "unassigned",
  "member_removed",
  "member_left",
  "account_deleted",
  "workspace_deleted",
  "license_ended",
] as const
export type SeatReleaseReason = (typeof SEAT_RELEASE_REASONS)[number]

/** Why a license ended, in `license.ended`'s `after.reason`: its workspace was deleted. */
export const LICENSE_ENDED_REASONS = ["workspace_deleted"] as const
export type LicenseEndedReason = (typeof LICENSE_ENDED_REASONS)[number]

/** `error` of the 409 a license write older than the one Core has gets. The body's `revision` is Core's. */
export const STALE_REVISION_ERROR = "stale_revision"

/** `error` of the 404 a license write gets when its workspace is deleted or never existed. Retrying cannot help. */
export const OWNER_NOT_FOUND_ERROR = "owner_not_found"

/** The most pairs one `POST /api/portal/workspaces/:workspaceId/seat-assignments` takes. */
export const MAX_SEAT_ASSIGNMENTS = 500

/**
 * Body of `POST /api/portal/workspaces/:workspaceId/seat-assignments`: seats to give out at once, each a
 * license of that workspace and the membership that gets it, for 1 to {@link MAX_SEAT_ASSIGNMENTS} pairs.
 * Core assigns all of them or none: a pair that is repeated, or whose membership already holds that
 * license's seat, is dropped rather than refused.
 */
export interface SeatAssignmentsRequest {
  assignments: {licenseId: string; membershipId: string}[]
}

/** Response of `POST /api/portal/workspaces/:workspaceId/seat-assignments` (200): every license it touched, as Core now holds it. */
export interface SeatAssignmentsResponse {
  licenses: LicenseView[]
}

/**
 * How short one license is for a bulk assignment: `needed` new seats were asked for and `free` are left. The
 * 409 {@link NO_SEATS_AVAILABLE_ERROR} of the bulk route lists one per license that falls short, as `licenses`;
 * when it answers, nothing was assigned.
 */
export interface SeatShortfall {
  licenseId: string
  needed: number
  free: number
}

/** `error` of the 409 an assignment gets when a license has no free seat for it. */
export const NO_SEATS_AVAILABLE_ERROR = "no_seats_available"
