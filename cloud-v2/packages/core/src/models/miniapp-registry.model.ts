/**
 * @fileoverview The miniapp registry: `miniapp_registry_entries` and `miniapp_registry_archive_rules`
 * (`services/registry/registry.service.ts`).
 *
 * The registry is Core's index of every miniapp URL the Mentra App has installed. Each install registers its URL,
 * and Core verifies it with its own fetcher. An entry is keyed by its normalized URL; one package name can have
 * several URLs on its domain.
 *
 * - `verification: "verified"`: Core read the URL's `miniapp.json` and keeps it in `manifest`.
 * - `verification: "phone_reported"`: Core couldn't read it. The entry holds the phone's report (an intranet URL),
 *   or, for a private server that refused Core's token, only the package name its sign-in challenge named.
 *
 * An entry is archived when its own `status` is, or when an archive rule names its URL, package name, registrable
 * domain or the account that first registered it. A rule covers entries registered after it too. Archiving a rule
 * also sets `status` on the entries it covers, so lists can filter on it; the rules are what decide.
 *
 * Both collections are built empty at startup with their unique indexes.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS = ["url", "package", "domain", "account"] as const
export type MiniappRegistryArchiveRuleKind = (typeof MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS)[number]

const MiniappRegistryEntrySchema = new Schema(
  {
    /** The normalized miniapp URL (`normalizeMiniappUrl`): HTTPS, a path that ends in `/`. */
    url: {type: String, required: true},
    packageName: {type: String, required: true},
    /** From the Public Suffix List, for archiving a whole domain. */
    registrableDomain: {type: String, required: true},
    /** Null when Core knows only the package name. */
    name: {type: String, default: null},
    version: {type: String, default: null},
    ageRating: {type: String, default: null},
    /** The manifest's icon as an absolute HTTPS URL. Never fetched by Core. */
    iconUrl: {type: String, default: null},
    verification: {type: String, enum: ["verified", "phone_reported"], required: true},
    /**
     * Core's verified copy of the served `miniapp.json`, as JSON text (the manifest may hold keys such as `$schema`
     * that a document field can't). Null unless verified.
     */
    manifest: {type: String, default: null},
    /** Its server asks for sign-in. */
    private: {type: Boolean, default: false},
    status: {type: String, enum: ["active", "archived"], default: "active"},
    firstRegisteredAt: {type: Date, required: true},
    /** The `mentraUserId` that first registered the URL. */
    firstRegisteredBy: {type: String, required: true},
    lastVerifiedAt: {type: Date, default: null},
    /** When Core last tried to read the URL; re-verification is at most once an hour per URL. */
    lastVerifyAttemptAt: {type: Date, default: null},
    /** The newest version Core has recorded for the URL, from its own read or a phone's registration. */
    lastSeenVersion: {type: String, default: null},
  },
  {collection: "miniapp_registry_entries", versionKey: false, timestamps: {createdAt: false, updatedAt: true}},
)

MiniappRegistryEntrySchema.index({url: 1}, {unique: true})
MiniappRegistryEntrySchema.index({packageName: 1})
MiniappRegistryEntrySchema.index({registrableDomain: 1})
MiniappRegistryEntrySchema.index({firstRegisteredBy: 1})
MiniappRegistryEntrySchema.index({status: 1, verification: 1})

export type MiniappRegistryEntry = InferSchemaType<typeof MiniappRegistryEntrySchema>
export const MiniappRegistryEntryModel = registerModel("MiniappRegistryEntry", MiniappRegistryEntrySchema)

const MiniappRegistryArchiveRuleSchema = new Schema(
  {
    kind: {type: String, enum: MINIAPP_REGISTRY_ARCHIVE_RULE_KINDS, required: true},
    /** A normalized URL, a package name, a registrable domain, or a `mentraUserId`. */
    value: {type: String, required: true},
    reason: {type: String, default: ""},
    /** Who archived: an Organization Admin, or a service and the person acting through it. */
    createdBy: {type: String, required: true},
    createdAt: {type: Date, required: true},
  },
  {collection: "miniapp_registry_archive_rules", versionKey: false},
)

// One rule per kind and value; also the lookup every archive check makes.
MiniappRegistryArchiveRuleSchema.index({kind: 1, value: 1}, {unique: true})

export type MiniappRegistryArchiveRule = InferSchemaType<typeof MiniappRegistryArchiveRuleSchema>
export const MiniappRegistryArchiveRuleModel = registerModel(
  "MiniappRegistryArchiveRule",
  MiniappRegistryArchiveRuleSchema,
)
