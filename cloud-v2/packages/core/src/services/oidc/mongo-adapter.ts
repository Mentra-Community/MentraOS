/**
 * @fileoverview MongoDB storage for Core's OpenID Connect provider.
 *
 * One collection per provider model, `oidc_<model>` (`oidc_session`,
 * `oidc_grant`, `oidc_authorization_code`, `oidc_refresh_token`, ...). Each
 * document is `{_id, payload, expiresAt, consumedAt?, grantId?, uid?,
 * accountId?}`; `expiresAt` carries a TTL index, and `grantId`, `uid` and
 * `accountId` are indexed for revocation and session lookup.
 *
 * - Bearer values (authorization codes, refresh tokens, opaque access tokens)
 *   are stored only as their SHA-256: a database read yields nothing a client
 *   could present.
 * - Consumption is atomic: a code or refresh token is consumed by one
 *   conditional update. The library checks `consumed` before calling
 *   `consume`, so two concurrent redemptions could both pass that check; the
 *   loser of the update ends the whole grant and fails with `invalid_grant`,
 *   exactly as a replay does.
 * - Clients are not stored here: the `Client` model reads Core's client
 *   registry (`clients.ts`).
 *
 * The adapter uses Core's Mongoose connection at call time, so it follows
 * whichever database Core is connected to.
 */

import {createHash} from "node:crypto"

import mongoose from "mongoose"
import {errors} from "oidc-provider"

import {findClient, providerClientMetadata} from "./clients"

/** Models whose ids are bearer values: stored hashed. */
const HASHED_MODELS = new Set(["AccessToken", "AuthorizationCode", "RefreshToken"])
/** Models that belong to a grant and end with it. */
const GRANT_MEMBER_MODELS = ["AccessToken", "AuthorizationCode", "RefreshToken"] as const
/** Every model this adapter stores, with the secondary indexes it needs. */
export const OIDC_STORED_MODELS: ReadonlyArray<{model: string; indexes: ReadonlyArray<"grantId" | "uid" | "accountId">}> = [
  {model: "Session", indexes: ["uid", "accountId"]},
  {model: "Interaction", indexes: []},
  {model: "Grant", indexes: ["accountId"]},
  {model: "AuthorizationCode", indexes: ["grantId"]},
  {model: "RefreshToken", indexes: ["grantId"]},
  {model: "AccessToken", indexes: ["grantId"]},
  {model: "ReplayDetection", indexes: []},
]

export function oidcCollectionName(model: string): string {
  return `oidc_${model.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`
}

interface StoredDocument {
  _id: string
  payload: Record<string, unknown>
  expiresAt?: Date
  consumedAt?: number
  grantId?: string
  uid?: string
  accountId?: string
}

function collection(model: string) {
  const db = mongoose.connection.db
  if (!db) throw new Error("the provider's storage is not connected")
  return db.collection<StoredDocument>(oidcCollectionName(model))
}

function storageKey(model: string, id: string): string {
  return HASHED_MODELS.has(model) ? createHash("sha256").update(id).digest("hex") : id
}

/** Create the provider's collections and indexes (startup migration). Idempotent. */
export async function ensureOidcCollections(): Promise<void> {
  for (const {model, indexes} of OIDC_STORED_MODELS) {
    const target = collection(model)
    await target.createIndex({expiresAt: 1}, {expireAfterSeconds: 0})
    for (const field of indexes) await target.createIndex({[field]: 1})
  }
}

/** End one grant: its codes, tokens and the grant itself. */
export async function revokeGrantEverywhere(grantId: string): Promise<void> {
  await Promise.all([
    ...GRANT_MEMBER_MODELS.map(model => collection(model).deleteMany({grantId})),
    collection("Grant").deleteOne({_id: grantId}),
  ])
}

/**
 * End every provider session and grant of a person: the sign-in site asks for
 * credentials again, and every client's next refresh fails.
 */
export async function revokeProviderSessionsAndGrants(accountId: string): Promise<{sessions: number; grants: number}> {
  const grants = await collection("Grant").find({accountId}, {projection: {_id: 1}}).toArray()
  await Promise.all(grants.map(grant => revokeGrantEverywhere(grant._id)))
  const sessions = await collection("Session").deleteMany({accountId})
  await collection("Interaction").deleteMany({"payload.result.login.accountId": accountId})
  return {sessions: sessions.deletedCount, grants: grants.length}
}

/** `oidc-provider`'s storage adapter, one instance per model. */
export class MongoAdapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    if (this.model === "Client") throw new Error("clients come from Core's client registry")
    const stored: Record<string, unknown> = {...payload}
    if (HASHED_MODELS.has(this.model)) delete stored.jti
    const set: Partial<StoredDocument> = {payload: stored}
    if (typeof expiresIn === "number") set.expiresAt = new Date(Date.now() + expiresIn * 1000)
    if (typeof payload.grantId === "string") set.grantId = payload.grantId
    if (typeof payload.uid === "string") set.uid = payload.uid
    if (typeof payload.accountId === "string") set.accountId = payload.accountId
    await collection(this.model).updateOne({_id: storageKey(this.model, id)}, {$set: set}, {upsert: true})
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    if (this.model === "Client") {
      const client = await findClient(id)
      return client ? providerClientMetadata(client) : undefined
    }
    const document = await collection(this.model).findOne({_id: storageKey(this.model, id)})
    return this.toPayload(document, id)
  }

  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const document = await collection(this.model).findOne({uid})
    return this.toPayload(document, document?._id)
  }

  async findByUserCode(): Promise<undefined> {
    return undefined
  }

  async consume(id: string): Promise<void> {
    const key = storageKey(this.model, id)
    const won = await collection(this.model).findOneAndUpdate(
      {_id: key, consumedAt: {$exists: false}},
      {$set: {consumedAt: Math.floor(Date.now() / 1000)}},
    )
    if (won) return
    // Lost a concurrent redemption: the same rule as a replay.
    const document = await collection(this.model).findOne({_id: key}, {projection: {grantId: 1}})
    if (document?.grantId) await revokeGrantEverywhere(document.grantId)
    throw new errors.InvalidGrant(`${this.model === "RefreshToken" ? "refresh token" : "grant"} already used`)
  }

  async destroy(id: string): Promise<void> {
    await collection(this.model).deleteOne({_id: storageKey(this.model, id)})
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await collection(this.model).deleteMany({grantId})
  }

  private toPayload(document: StoredDocument | null, id: string | undefined): Record<string, unknown> | undefined {
    if (!document) return undefined
    if (document.expiresAt && document.expiresAt.getTime() <= Date.now()) return undefined
    const payload: Record<string, unknown> = {...document.payload}
    if (HASHED_MODELS.has(this.model) && id !== undefined) payload.jti = id
    if (document.consumedAt !== undefined) payload.consumed = document.consumedAt
    return payload
  }
}
