/**
 * @fileoverview Admin API keys made before operator keys, kept working as operator keys.
 *
 * Those keys are developer-organization API keys (`msk_<env>_<keyId>.<secret>`),
 * rows of this Core's own `developer_org_api_keys` collection. A key is an admin
 * key when its address, `api-key@<keyId>.local`, is on `CLOUD_CORE_ADMIN_EMAILS`.
 * At startup Core gives each such key an `access_credentials` row as an
 * organization operator credential, so the same token keeps working:
 *  - the same credential id, hash, environment label and last 4, with
 *    `prefix: "msk"`: validation binds the token's prefix to the row and takes the
 *    kind from the row;
 *  - every operator scope (`OPERATOR_KEY_SCOPES`): a legacy admin key could do
 *    whatever an Organization Admin could, so its operator key may too;
 *  - created by `api-key@<keyId>.local`, so, like every operator key, it works
 *    exactly while that address stays on the allowlist.
 *
 * The legacy collection is only read. The step runs on every start. A key with
 * no row yet is converted; a key that already has one (converted before, revoked
 * since, or a workspace credential) keeps it, and a legacy row that is revoked or
 * could never validate is not converted. Two changes do carry over to an
 * operator key converted earlier:
 *  - a legacy revocation: an operator key converted from a key that is now
 *    revoked there is revoked too;
 *  - the operator scopes: a converted key that is not revoked and lacks any of
 *    them (it was converted when operator keys held fewer) is given every one, so
 *    it gains what later scopes allow at the next start. Only these keys widen:
 *    an operator key made as one (`mak_`) keeps the scopes it was created with.
 * Each conversion, carried revocation and widening records its audit event as
 * the system (`credential.created`, `credential.revoked`,
 * `credential.scopes_changed`).
 *
 * Each conversion is one upsert of one document, with its audit event written
 * after it, so it needs no transaction (some databases a Private Cloud uses
 * cannot run one across collections). A key that fails to convert is logged and
 * skipped, and the next start tries again: one admin key must never keep Core
 * from serving.
 */

import {createLogger} from "@mentra/cloud-shared"
import {OPERATOR_KEY_SCOPES} from "@mentra/workspace-contract"
import mongoose from "mongoose"
import {AccessCredentialModel, type AccessCredentialRow} from "../../models/access-credential.model"
import {recordOrganizationEvent} from "./audit.service"
import {auditTarget, createdEvent, markRevoked} from "./credential.service"
import {getAdminEmailAllowlist} from "../admin-email-policy"
import {credentialEnvironmentLabels} from "./organization"

const logger = createLogger("core").child({service: "legacy-admin-keys"})

/** Core's developer-organization API keys, read but never written. */
const LEGACY_KEYS = "developer_org_api_keys"
/** An allowlisted key address. The allowlist is lowercase, so the key id is too. */
const KEY_ADDRESS = /^api-key@([0-9a-hjkmnp-tv-z]{26})\.local$/
const KEY_HASH = /^[0-9a-f]{64}$/
const KEY_ENV = /^[a-z0-9]+$/
const SYSTEM = {kind: "system"} as const

type LegacyKey = {
  keyId: string
  name?: string | null
  env?: unknown
  hash?: unknown
  last4?: unknown
  lastUsedAt?: Date | null
  revokedAt?: Date | null
  createdAt?: Date | null
}

/** The address an admin key stands for on the allowlist, and the creator of its operator key. */
export function legacyAdminKeyAddress(keyId: string): string {
  return `api-key@${keyId}.local`
}

/** The key ids whose addresses are on `CLOUD_CORE_ADMIN_EMAILS`, in the canonical (uppercase) form. */
export function allowlistedLegacyKeyIds(): string[] {
  const ids = getAdminEmailAllowlist().emails.flatMap(email => {
    const match = KEY_ADDRESS.exec(email)
    return match ? [match[1]!.toUpperCase()] : []
  })
  return [...new Set(ids)]
}

/** What one run of {@link convertLegacyAdminKeys} did, by key id. */
export interface LegacyAdminKeysResult {
  converted: string[]
  revoked: string[]
  /** Converted earlier, and given every operator scope by this run. */
  widened: string[]
  failed: string[]
}

/**
 * Give every allowlisted legacy admin key its operator credential, with every operator scope (see the file
 * header). Returns the ids converted, revoked, widened and failed by this run. Never throws: a key that
 * fails is logged and listed.
 */
export async function convertLegacyAdminKeys(): Promise<LegacyAdminKeysResult> {
  const result: LegacyAdminKeysResult = {converted: [], revoked: [], widened: [], failed: []}
  for (const keyId of allowlistedLegacyKeyIds()) {
    try {
      await convertOne(keyId, result)
    } catch (err) {
      result.failed.push(keyId)
      logger.error({err, credentialId: keyId}, "could not convert a legacy admin key; it does not validate until a later start converts it")
    }
  }
  return result
}

async function convertOne(keyId: string, result: LegacyAdminKeysResult): Promise<void> {
  const legacy = await mongoose.connection.collection<LegacyKey>(LEGACY_KEYS).findOne({keyId})
  const existing = await AccessCredentialModel.findOne({credentialId: keyId}).lean<AccessCredentialRow>()

  if (existing) {
    if (existing.credentialKind !== "organization" || existing.createdByEmail !== legacyAdminKeyAddress(keyId)) {
      if (!existing.revokedAt) {
        logger.warn(
          {credentialId: keyId, credentialKind: existing.credentialKind},
          "an allowlisted legacy admin key is already another credential; it is not an operator key",
        )
      }
      return
    }
    if (existing.revokedAt) return
    if (legacy?.revokedAt) {
      await markRevoked(null, existing, SYSTEM)
      result.revoked.push(keyId)
      logger.info({credentialId: keyId}, "revoked the operator key of a revoked legacy admin key")
      return
    }
    if (await widen(existing)) {
      result.widened.push(keyId)
      logger.info({credentialId: keyId}, "gave a converted legacy admin key every operator scope")
    }
    return
  }

  if (!legacy) {
    logger.info({credentialId: keyId}, "an allowlisted legacy admin key is not in this Core's database")
    return
  }
  if (legacy.revokedAt) return
  if (
    typeof legacy.hash !== "string" ||
    !KEY_HASH.test(legacy.hash) ||
    typeof legacy.env !== "string" ||
    !KEY_ENV.test(legacy.env) ||
    typeof legacy.last4 !== "string"
  ) {
    logger.warn({credentialId: keyId}, "an allowlisted legacy admin key could never validate; not converting it")
    return
  }
  const {hash, env, last4} = legacy

  const now = new Date()
  const upserted = await AccessCredentialModel.updateOne(
    {credentialId: keyId},
    {
      $setOnInsert: {
        credentialId: keyId,
        prefix: "msk",
        credentialKind: "organization",
        workspaceId: null,
        name: legacy.name?.trim() || "Admin API key",
        env,
        hash,
        last4,
        scopes: [...OPERATOR_KEY_SCOPES],
        packageNames: [],
        createdByMembershipId: null,
        createdByMentraUserId: null,
        createdByEmail: legacyAdminKeyAddress(keyId),
        issuedByService: null,
        expiresAt: null,
        lastUsedAt: legacy.lastUsedAt ?? null,
        revokedAt: null,
        createdAt: legacy.createdAt ?? now,
        updatedAt: now,
      },
    },
    // The legacy creation time carries over, and a row that exists is left exactly as it is.
    {upsert: true, timestamps: false},
  )
  if (upserted.upsertedCount !== 1) return
  const row = await AccessCredentialModel.findOne({credentialId: keyId}).lean<AccessCredentialRow>()
  if (row) await recordOrganizationEvent(createdEvent(row, SYSTEM))
  result.converted.push(keyId)
  logger.info({credentialId: keyId}, "converted a legacy admin key to an operator key")
  if (!credentialEnvironmentLabels().includes(env)) {
    logger.warn(
      {credentialId: keyId, env},
      "a converted legacy admin key carries an environment label this Core does not accept; list it in " +
        "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS or the key does not validate",
    )
  }
}

/**
 * Give a converted legacy admin key every operator scope when it lacks any, and record
 * `credential.scopes_changed` as the system. Whether this run changed it: the write matches only the scopes
 * read, so two Cores starting at once widen it, and record it, once.
 */
async function widen(row: AccessCredentialRow): Promise<boolean> {
  const before = [...row.scopes]
  if (OPERATOR_KEY_SCOPES.every(scope => before.includes(scope))) return false
  const after = [...new Set([...OPERATOR_KEY_SCOPES, ...before])]
  const changed = await AccessCredentialModel.updateOne(
    {credentialId: row.credentialId, credentialKind: "organization", revokedAt: null, scopes: before},
    {$set: {scopes: after}},
  )
  if (changed.modifiedCount !== 1) return false
  await recordOrganizationEvent({
    workspaceId: null,
    action: "credential.scopes_changed",
    actor: SYSTEM,
    target: auditTarget(row),
    before: {scopes: before},
    after: {scopes: after, reason: "legacy_admin_key"},
  })
  return true
}
