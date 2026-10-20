/**
 * Licenses: what billing writes into Core (`PUT /api/internal/licenses/:licenseId`, the Store only) and
 * what Core shows of them, to billing (`GET /api/internal/licenses`) and to people (the workspace routes'
 * `GET /:workspaceId/licenses`). See Core's `docs/licenses.md`.
 *
 * A license is a quantity of one product for a term, held by a workspace (its Admins and Owners assign
 * the seats to members) or by a person (who holds its one seat). Core keeps a copy of each license as
 * billing last wrote it, and who holds each seat.
 */

/** The owners a license can have. */
export const LICENSE_OWNER_TYPES = ["workspace", "person"] as const

/** Who holds a license: a workspace, or a person by Core user ID. */
export type LicenseOwner = {type: "workspace"; workspaceId: string} | {type: "person"; mentraUserId: string}

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
  /** Seats: always 1 for a person. */
  quantity: number
  /** RFC 3339, UTC (`Z`). */
  validFrom: string
  /** RFC 3339, UTC (`Z`). The features stop after it. */
  paidThrough: string
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
 * A license as Core holds it. `seatsUsed` is how many seats are assigned (a personal license's one seat
 * is always its owner's, so it is 1), and may exceed `quantity` after a write lowered it: Core frees no
 * seat on its own. `endedAt` is set when its owner was deleted; Core then refuses further writes for it.
 * `seats` is present where Core lists who holds them (the workspace routes).
 */
export interface LicenseView extends Omit<LicenseWrite, "licenseId"> {
  licenseId: string
  seatsUsed: number
  endedAt: string | null
  seats?: LicenseSeatView[]
}

/** Response of `GET /api/internal/licenses?ownerType=&ownerId=`: one owner's licenses, ended ones included. */
export interface LicensesResponse {
  licenses: LicenseView[]
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

/** Why a license ended, in `license.ended`'s `after.reason`: its owner was deleted. */
export const LICENSE_ENDED_REASONS = ["workspace_deleted", "account_deleted"] as const
export type LicenseEndedReason = (typeof LICENSE_ENDED_REASONS)[number]

/** `error` of the 409 a license write older than the one Core has gets. The body's `revision` is Core's. */
export const STALE_REVISION_ERROR = "stale_revision"

/** `error` of the 404 a license write gets when its owner is deleted or never existed. Retrying cannot help. */
export const OWNER_NOT_FOUND_ERROR = "owner_not_found"
