/**
 * @fileoverview `website_clients`: the miniapp websites registered to sign people in with Mentra.
 *
 * Each is a third-party client of Core's sign-in server, bound to one package: its tokens are that package's
 * miniapp tokens and nothing else (`services/oidc/website-clients.service.ts`). A package can have several,
 * such as a production site and a development client.
 *
 * Only the SHA-256 hex of a server client's secret is stored (`secretHash`), plus `secretLast4` for display.
 * The plaintext is shown once, at creation or regeneration.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const WEBSITE_CLIENT_TYPES = ["browser", "server"] as const
export type WebsiteClientType = (typeof WEBSITE_CLIENT_TYPES)[number]

export const WEBSITE_CLIENT_ENVIRONMENTS = ["production", "development"] as const
export type WebsiteClientEnvironment = (typeof WEBSITE_CLIENT_ENVIRONMENTS)[number]

export const WEBSITE_CLIENT_ACCESS = ["public", "private"] as const
export type WebsiteClientAccess = (typeof WEBSITE_CLIENT_ACCESS)[number]

const WebsiteClientSchema = new Schema(
  {
    /** Allocated by Core: `mwc_<ulid>`. */
    clientId: {type: String, required: true, unique: true},
    /**
     * Shown on the consent screen. An Organization Admin's client carries the name the admin gave; a
     * developer's carries the name Core read from the miniapp's own `miniapp.json`, never one they typed.
     */
    name: {type: String, required: true},
    type: {type: String, enum: WEBSITE_CLIENT_TYPES, required: true},
    environment: {type: String, enum: WEBSITE_CLIENT_ENVIRONMENTS, required: true},
    /** Matched exactly. */
    redirectUris: {type: [String], required: true},
    /** The one package the client acts for: the audience of its tokens. */
    packageName: {type: String, required: true, index: true},
    /**
     * The developer who registered it for a package on their own domain, by `mentraUserId`: only they may
     * change it. Null for a client an Organization Admin registered.
     */
    ownerUserId: {type: String, default: null, index: true},
    /** `public`: anyone with a Mentra account. `private`: active members of `accessWorkspaceIds` only. */
    access: {type: String, enum: WEBSITE_CLIENT_ACCESS, required: true},
    accessWorkspaceIds: {type: [String], default: []},
    status: {type: String, enum: ["active", "disabled"], default: "active"},
    /** Server clients only. */
    secretHash: {type: String, default: null},
    secretLast4: {type: String, default: null},
    /** Who acted, as the admin audit log names them: an email, or a `mentraUserId`. */
    createdBy: {type: String, required: true},
    updatedBy: {type: String, required: true},
  },
  {collection: "website_clients", versionKey: false, timestamps: true},
)

export type WebsiteClient = InferSchemaType<typeof WebsiteClientSchema>
export const WebsiteClientModel = registerModel("WebsiteClient", WebsiteClientSchema)
