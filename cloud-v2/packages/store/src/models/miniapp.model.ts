import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const MINIAPP_STATUSES = ["active", "archived", "suspended"] as const
export const MINIAPP_REVIEW_TIERS = ["community", "verified"] as const
export const MINIAPP_BETA_ACCESS_MODES = ["private", "public"] as const
export const MINIAPP_VISIBILITIES = ["public", "private"] as const

const StoreListingSchema = new Schema(
  {
    subtitle: {type: String, default: null},
    longDescription: {type: String, default: null},
    categories: {type: [String], default: []},
    privacyPolicyUrl: {type: String, default: null},
    supportUrl: {type: String, default: null},
    websiteUrl: {type: String, default: null},
    reviewTier: {type: String, enum: MINIAPP_REVIEW_TIERS, default: "community"},
    featured: {type: Boolean, default: false},
    iconAssetId: {type: String, default: null},
    coverAssetId: {type: String, default: null},
    screenshotAssetIds: {type: [String], default: []},
  },
  {_id: false},
)

const StoreListingOperationLeaseSchema = new Schema(
  {
    token: {type: String, required: true},
    expiresAt: {type: Date, required: true},
  },
  {_id: false},
)

const PendingStorePublicationSchema = new Schema(
  {
    releaseId: {type: String, required: true},
    releaseTrack: {type: String, enum: ["stable", "beta"], required: true},
    storeListing: {type: StoreListingSchema, required: true},
  },
  {_id: false},
)

const MiniAppSchema = new Schema(
  {
    orgId: {type: String, required: true, index: true},
    packageName: {type: String, required: true, unique: true},
    displayName: {type: String, required: true},
    description: {type: String, default: null},
    /** Developer-editable draft. Copied to publishedStoreListing only after admin publication. */
    storeListing: {type: StoreListingSchema, default: () => ({})},
    /** Immutable public snapshot from the latest publication decision. */
    publishedStoreListing: {type: StoreListingSchema, default: null},
    /** Immutable public snapshot paired with the active beta release. */
    publishedBetaStoreListing: {type: StoreListingSchema, default: null},
    /**
     * Database-backed lease shared by draft writes, submission, moderation,
     * and publication so listing snapshots remain ordered across Core pods.
     */
    storeListingOperationLease: {type: StoreListingOperationLeaseSchema, default: null},
    /** Recoverable journal entry used while promoting a release across documents. */
    pendingStorePublication: {type: PendingStorePublicationSchema, default: null},
    status: {type: String, enum: MINIAPP_STATUSES, default: "active", index: true},
    /** Public listings are globally discoverable; private listings require a per-user invitation. */
    visibility: {type: String, enum: MINIAPP_VISIBILITIES, default: "public", index: true},
    /** Active stable release. Kept under the original name for deployed-row compatibility. */
    activeReleaseId: {type: String, default: null},
    /** Active beta release, independently published from stable. */
    activeBetaReleaseId: {type: String, default: null},
    /** Closed by default. Public betas must be an explicit developer choice. */
    betaAccessMode: {type: String, enum: MINIAPP_BETA_ACCESS_MODES, default: "private"},
    /** First verified production bundle signer. Immutable without an explicit future rotation flow. */
    publisherKeyFingerprint: {type: String, default: null, index: true},
    publisherPublicKeyJwk: {type: Schema.Types.Mixed, default: null},
    createdBy: {type: String, required: true},
  },
  {timestamps: true, collection: "miniapps"},
)

MiniAppSchema.index({orgId: 1, packageName: 1}, {unique: true})

export type MiniApp = InferSchemaType<typeof MiniAppSchema>
export const MiniAppModel = registerModel("MiniApp", MiniAppSchema)
