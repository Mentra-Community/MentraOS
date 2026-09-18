import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

/**
 * Per-(org, user) role, stored and owned entirely in our DB. Roles are uniform:
 * owner | admin | member — there is no special "creator". `DeveloperOrg.ownerUserId`
 * is only a created-by pointer and does NOT grant the owner role. An org may have
 * many owners; the console enforces that at least one owner always remains (you
 * cannot demote or remove the last owner).
 *
 * Keyed by WorkOS userId. A user with no row resolves to `member` by default.
 * WorkOS is not consulted for roles — it remains identity/login + the member
 * roster only. The permission tier is a Mentra console concept.
 */
export const DEVELOPER_ORG_ROLES = ["owner", "admin", "member"] as const
export type DeveloperOrgRole = (typeof DEVELOPER_ORG_ROLES)[number]

const DeveloperOrgMembershipSchema = new Schema(
  {
    orgId: {type: String, required: true, index: true},
    userId: {type: String, required: true},
    role: {type: String, enum: DEVELOPER_ORG_ROLES, required: true, default: "member"},
    // Roster display fields, backfilled from the session/invite/WorkOS identity.
    email: {type: String, default: null},
    name: {type: String, default: null},
    status: {type: String, default: "active"},
  },
  {timestamps: true, collection: "developer_org_memberships"},
)

DeveloperOrgMembershipSchema.index({orgId: 1, userId: 1}, {unique: true})
DeveloperOrgMembershipSchema.index({userId: 1, createdAt: 1})

export type DeveloperOrgMembership = InferSchemaType<typeof DeveloperOrgMembershipSchema>
export const DeveloperOrgMembershipModel = registerModel("DeveloperOrgMembership", DeveloperOrgMembershipSchema)
