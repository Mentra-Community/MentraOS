/**
 * @fileoverview `access_credentials` collection. One document per API key.
 *
 * Workspace credentials (`msk_<env>_<ulid>.<secret>`, `credentialKind:
 * "workspace"`) belong to a workspace and are minted by a member, or by a
 * trusted service such as the Store for package keys. Organization operator
 * credentials (`mak_<env>_<ulid>.<secret>`, `credentialKind: "organization"`)
 * have no workspace.
 *
 * Only the SHA-256 hex of `<secret>` is stored (`hash`), plus `last4` for
 * display. The plaintext is shown once at creation.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const ACCESS_CREDENTIAL_PREFIXES = ["msk", "mak"] as const
export type AccessCredentialPrefix = (typeof ACCESS_CREDENTIAL_PREFIXES)[number]

export const ACCESS_CREDENTIAL_KINDS = ["workspace", "organization"] as const
export type AccessCredentialKind = (typeof ACCESS_CREDENTIAL_KINDS)[number]

const AccessCredentialSchema = new Schema(
  {
    /** The `<ulid>` segment of the key, so a key can be located without its secret. */
    credentialId: {type: String, required: true, unique: true},
    prefix: {type: String, enum: ACCESS_CREDENTIAL_PREFIXES, required: true},
    credentialKind: {type: String, enum: ACCESS_CREDENTIAL_KINDS, required: true},
    organizationId: {type: String, required: true},
    workspaceId: {type: String, default: null, index: true},
    name: {type: String, required: true},
    env: {type: String, required: true},
    hash: {type: String, required: true},
    last4: {type: String, required: true},
    scopes: {type: [String], default: []},
    packageNames: {type: [String], default: []},
    /** Workspace credentials minted by a member. */
    createdByMembershipId: {type: String, default: null},
    createdByMentraUserId: {type: String, default: null},
    createdByEmail: {type: String, default: null},
    /** Set for service-issued keys, e.g. `"store"` for staff-issued package keys. */
    issuedByService: {type: String, default: null},
    expiresAt: {type: Date, default: null},
    lastUsedAt: {type: Date, default: null},
    revokedAt: {type: Date, default: null},
  },
  {timestamps: true, collection: "access_credentials"},
)

AccessCredentialSchema.index({workspaceId: 1, revokedAt: 1})
AccessCredentialSchema.index({credentialKind: 1, revokedAt: 1})

export type AccessCredentialRow = InferSchemaType<typeof AccessCredentialSchema>
export const AccessCredentialModel = registerModel("AccessCredential", AccessCredentialSchema)
