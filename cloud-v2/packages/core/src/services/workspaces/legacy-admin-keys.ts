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
 *  - the operator scopes (`OPERATOR_KEY_SCOPES`);
 *  - created by `api-key@<keyId>.local`, so, like every operator key, it works
 *    exactly while that address stays on the allowlist.
 *
 * The legacy collection is only read. The step runs on every start and inserts
 * only: a key that already has a row (converted before, revoked since, or a
 * workspace credential) keeps it, and a legacy row that is revoked or could never
 * validate is not converted. A legacy revocation does carry over: an operator key
 * converted from a key that is now revoked there is revoked too. Each conversion
 * and each carried revocation records its audit event as the system.
 */

import {createLogger} from "@mentra/cloud-shared"
import {OPERATOR_KEY_SCOPES} from "@mentra/workspace-contract"
import mongoose from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel, type AccessCredentialRow} from "../../models/access-credential.model"
import {markRevoked, recordCreated} from "./credential.service"
import {configuredAdminAllowlist, credentialEnvironmentLabels} from "./organization"

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
  const ids = configuredAdminAllowlist().emails.flatMap(email => {
    const match = KEY_ADDRESS.exec(email)
    return match ? [match[1]!.toUpperCase()] : []
  })
  return [...new Set(ids)]
}

/**
 * Give every allowlisted legacy admin key its operator credential (see the file header). Returns the
 * ids converted and revoked by this run. Only a database failure throws.
 */
export async function convertLegacyAdminKeys(): Promise<{converted: string[]; revoked: string[]}> {
  const converted: string[] = []
  const revoked: string[] = []
  for (const keyId of allowlistedLegacyKeyIds()) {
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
        continue
      }
      if (legacy?.revokedAt && !existing.revokedAt) {
        await withTransaction(session => markRevoked(session, existing, SYSTEM))
        revoked.push(keyId)
        logger.info({credentialId: keyId}, "revoked the operator key of a revoked legacy admin key")
      }
      continue
    }

    if (!legacy) {
      logger.info({credentialId: keyId}, "an allowlisted legacy admin key is not in this Core's database")
      continue
    }
    if (legacy.revokedAt) continue
    if (
      typeof legacy.hash !== "string" ||
      !KEY_HASH.test(legacy.hash) ||
      typeof legacy.env !== "string" ||
      !KEY_ENV.test(legacy.env) ||
      typeof legacy.last4 !== "string"
    ) {
      logger.warn({credentialId: keyId}, "an allowlisted legacy admin key could never validate; not converting it")
      continue
    }
    const {hash, env, last4} = legacy

    const inserted = await withTransaction(async session => {
      const now = new Date()
      const result = await AccessCredentialModel.updateOne(
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
        {upsert: true, session, timestamps: false},
      )
      if (result.upsertedCount !== 1) return false
      const row = await AccessCredentialModel.findOne({credentialId: keyId}).session(session).lean<AccessCredentialRow>()
      await recordCreated(session, row!, SYSTEM)
      return true
    })
    if (!inserted) continue
    converted.push(keyId)
    logger.info({credentialId: keyId}, "converted a legacy admin key to an operator key")
    if (!credentialEnvironmentLabels().includes(env)) {
      logger.warn(
        {credentialId: keyId, env},
        "a converted legacy admin key carries an environment label this Core does not accept; list it in " +
          "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS or the key does not validate",
      )
    }
  }
  return {converted, revoked}
}
