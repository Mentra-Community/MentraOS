/**
 * @fileoverview `signin_identities`: how each person last signed in to Core's
 * sign-in server (its OpenID Connect provider).
 *
 * One row per Core user, written at every sign-in through the provider: the
 * sign-in source (tenant and source id), the subject at that source, and the
 * email with its verification as that source vouched for it at sign-in time.
 * The provider's ID tokens and userinfo, and the people behind Core access
 * tokens, take their email from here, so a changed email takes effect at the
 * next sign-in. The row is deleted with the account.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const SigninIdentitySchema = new Schema(
  {
    mentraUserId: {type: String, required: true, unique: true},
    /** Sign-in source: the tenant half of the Core user key, and the source (provider) id. */
    tenantId: {type: String, required: true},
    sourceId: {type: String, required: true},
    subject: {type: String, required: true},
    email: {type: String, default: null},
    emailVerified: {type: Boolean, required: true},
    name: {type: String, default: null},
    signedInAt: {type: Date, required: true},
  },
  {collection: "signin_identities", versionKey: false},
)

export type SigninIdentity = InferSchemaType<typeof SigninIdentitySchema>
export const SigninIdentityModel = registerModel("SigninIdentity", SigninIdentitySchema)
