/**
 * @fileoverview `identity_links` collection. Maps an external identity-provider
 * subject to a Mentra user, so a person keeps one `mentraUserId` across sign-in
 * methods.
 *
 * `linkedVia` records why the link was made: the provider asserted a verified
 * email that matched an existing user, or the subject arrived through a WorkOS
 * tenant that Core already trusts.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const IDENTITY_LINK_PROVIDERS = ["workos"] as const
export type IdentityLinkProvider = (typeof IDENTITY_LINK_PROVIDERS)[number]

export const IDENTITY_LINK_METHODS = ["verified_email", "workos_tenant"] as const
export type IdentityLinkMethod = (typeof IDENTITY_LINK_METHODS)[number]

const IdentityLinkSchema = new Schema(
  {
    provider: {type: String, enum: IDENTITY_LINK_PROVIDERS, required: true},
    subject: {type: String, required: true},
    mentraUserId: {type: String, required: true},
    email: {type: String, default: null},
    linkedVia: {type: String, enum: IDENTITY_LINK_METHODS, required: true},
  },
  {timestamps: true, collection: "identity_links"},
)

IdentityLinkSchema.index({provider: 1, subject: 1}, {unique: true})
IdentityLinkSchema.index({mentraUserId: 1})

export type IdentityLinkRow = InferSchemaType<typeof IdentityLinkSchema>
export const IdentityLinkModel = registerModel("IdentityLink", IdentityLinkSchema)
