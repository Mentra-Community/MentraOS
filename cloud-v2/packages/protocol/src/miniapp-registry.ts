/**
 * @fileoverview The Mentra App's registry calls to Core: `/api/client/registry/register` and `/status`.
 *
 * Every install of a miniapp URL registers it. Core verifies the URL itself, with its own fetcher, and answers:
 * - `accepted`, with the `miniapp.json` Core read;
 * - `accepted_unverified`, when Core could not read it: the URL is reachable only from the phone, or its server asks
 *   for sign-in and refused the person's token. The phone's own request decides whether it installs;
 * - `not_a_miniapp`, which stops the install;
 * - `archived`, which stops it too.
 *
 * The updater sends one status batch for every installed URL and keeps the answer for `validForSeconds`. An archived
 * URL is never updated; installed copies keep running.
 *
 * Core validates requests with these schemas, and the Cloud Client validates Core's answers with them. Objects keep
 * only the fields they name, so a later Core can add fields without breaking an older phone.
 */
import {z} from "zod"
import {
  MINIAPP_AGE_RATINGS,
  MINIAPP_PACKAGE_NAME_PATTERN,
  MINIAPP_VERSION_PATTERN,
  ServedMiniappManifestSchema,
  type MiniappAgeRating,
  type ServedMiniappManifest,
} from "./miniapp-url"

/** The most URLs one status call may name. */
export const MINIAPP_REGISTRY_STATUS_MAX_ENTRIES = 500
/** How long the phone keeps a status answer when Core doesn't say: 6 hours. */
export const MINIAPP_REGISTRY_STATUS_DEFAULT_TTL_SECONDS = 21_600

const MAX_URL_LENGTH = 2048
const MAX_NAME_LENGTH = 500
const MAX_VERSION_LENGTH = 256

/** `verified`: Core read the URL's `miniapp.json` itself. `phone_reported`: Core could not, so it holds the phone's report. */
export type MiniappRegistryVerification = "verified" | "phone_reported"
/** An entry's own status. An archive rule can also cover an `active` entry; the status call answers for both. */
export type MiniappRegistryEntryStatus = "active" | "archived"

/** One registry entry, as Core shows it to a caller. */
export interface RegistryEntryView {
  /** The normalized miniapp URL: the entry's key. */
  url: string
  packageName: string
  registrableDomain: string
  /**
   * Null when Core knows only the package name: a private miniapp whose server refused Core's token, or a private
   * entry whose server hasn't admitted this caller.
   */
  name: string | null
  version: string | null
  ageRating: MiniappAgeRating | null
  iconUrl: string | null
  verification: MiniappRegistryVerification
  /** Its server asks for sign-in. */
  private: boolean
  status: MiniappRegistryEntryStatus
  /** ISO 8601. */
  firstRegisteredAt: string
  /** ISO 8601, or null when Core has never read it. */
  lastVerifiedAt: string | null
}

/** Why a URL isn't a miniapp. */
export const MINIAPP_REGISTRY_NOT_A_MINIAPP_REASONS = [
  "invalid_manifest",
  "domain_mismatch",
  "not_https",
  "local_network_url",
] as const
export type MiniappRegistryNotAMiniappReason = (typeof MINIAPP_REGISTRY_NOT_A_MINIAPP_REASONS)[number]

/** What the phone read from the URL, sent with every registration. Core keeps it only when it can't read the URL. */
export const RegistryReportedManifestSchema = z.object({
  packageName: z.string().regex(MINIAPP_PACKAGE_NAME_PATTERN),
  name: z
    .string()
    .max(MAX_NAME_LENGTH)
    .refine((name) => name.trim().length > 0, "must not be blank"),
  version: z.string().max(MAX_VERSION_LENGTH).regex(MINIAPP_VERSION_PATTERN),
  /** Absent (or null) when the miniapp declares none. */
  ageRating: z.enum(MINIAPP_AGE_RATINGS).nullish(),
})
export type RegistryReportedManifest = z.infer<typeof RegistryReportedManifestSchema>

export const RegistryRegisterRequestSchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
  reported: RegistryReportedManifestSchema.optional(),
})
export type RegistryRegisterRequest = z.infer<typeof RegistryRegisterRequestSchema>

const IsoTime = z.string().min(1)

export const RegistryEntryViewSchema: z.ZodType<RegistryEntryView> = z.object({
  url: z.string().min(1),
  packageName: z.string().min(1),
  registrableDomain: z.string().min(1),
  name: z.string().nullable(),
  version: z.string().nullable(),
  ageRating: z.enum(MINIAPP_AGE_RATINGS).nullable(),
  iconUrl: z.string().nullable(),
  verification: z.enum(["verified", "phone_reported"]),
  private: z.boolean(),
  status: z.enum(["active", "archived"]),
  firstRegisteredAt: IsoTime,
  lastVerifiedAt: IsoTime.nullable(),
})

export type RegistryRegisterResponse =
  | {result: "accepted"; entry: RegistryEntryView; manifest: ServedMiniappManifest}
  | {result: "accepted_unverified"; entry: RegistryEntryView}
  | {result: "not_a_miniapp"; reason: MiniappRegistryNotAMiniappReason}
  | {result: "archived"}

export const RegistryRegisterResponseSchema: z.ZodType<RegistryRegisterResponse> = z.discriminatedUnion("result", [
  z.object({result: z.literal("accepted"), entry: RegistryEntryViewSchema, manifest: ServedMiniappManifestSchema}),
  z.object({result: z.literal("accepted_unverified"), entry: RegistryEntryViewSchema}),
  z.object({result: z.literal("not_a_miniapp"), reason: z.enum(MINIAPP_REGISTRY_NOT_A_MINIAPP_REASONS)}),
  z.object({result: z.literal("archived")}),
])

export const RegistryStatusRequestSchema = z.object({
  entries: z
    .array(
      z.object({
        url: z.string().min(1).max(MAX_URL_LENGTH),
        /** The installed version. */
        version: z.string().min(1).max(MAX_VERSION_LENGTH),
      }),
    )
    .max(MINIAPP_REGISTRY_STATUS_MAX_ENTRIES),
})
export type RegistryStatusRequest = z.infer<typeof RegistryStatusRequestSchema>

/** `unknown`: the URL isn't in the registry, or isn't a miniapp URL. */
export type MiniappRegistryUrlStatus = "active" | "archived" | "unknown"

export interface RegistryStatusResponse {
  /** One per requested entry, in order, with the URL as the phone sent it. */
  statuses: Array<{url: string; status: MiniappRegistryUrlStatus}>
  /** How long the answer stays valid, in seconds. */
  validForSeconds: number
}

export const RegistryStatusResponseSchema: z.ZodType<RegistryStatusResponse> = z.object({
  statuses: z.array(z.object({url: z.string(), status: z.enum(["active", "archived", "unknown"])})),
  validForSeconds: z.number().int().positive(),
})
