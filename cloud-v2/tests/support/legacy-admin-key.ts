/**
 * @fileoverview Admin API keys as Core made them before operator keys, for tests.
 *
 * Such a key was a developer-organization API key (`msk_<env>_<keyId>.<secret>`),
 * a row of Core's own `developer_org_api_keys` collection. Core only reads that
 * collection now (`legacy-admin-keys.ts` turns an allowlisted key into an operator
 * key at startup), so tests write the rows the way the earlier Core did.
 */

import {createHash, randomBytes} from "node:crypto"
import {WorkspaceModel} from "../../packages/core/src/models/workspace.model"

/** The collection the earlier Core kept these keys in. */
export const LEGACY_KEYS = "developer_org_api_keys"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A key id of the shape the earlier Core minted (a ULID). */
export function legacyKeyId(): string {
  return [...randomBytes(26)].map((byte, index) => CROCKFORD[index === 0 ? byte % 8 : byte % 32]).join("")
}

export interface LegacyAdminKey {
  keyId: string
  /** The bearer the key's holder sends. */
  token: string
  hash: string
  last4: string
}

/** The legacy key collection, through the connection Core's models use. */
export function legacyKeys() {
  return WorkspaceModel.db.collection(LEGACY_KEYS)
}

/**
 * Write one developer-organization API key row as the earlier Core wrote it, and return its token.
 * Its allowlist address is `api-key@<keyId>.local` (`legacyKeyAddress`).
 */
export async function legacyAdminKey(
  options: {env?: string; revokedAt?: Date | null; name?: string; orgId?: string} = {},
): Promise<LegacyAdminKey> {
  const env = options.env ?? "local"
  const keyId = legacyKeyId()
  const secret = randomBytes(32).toString("base64url")
  const hash = createHash("sha256").update(secret).digest("hex")
  await legacyKeys().insertOne({
    keyId,
    orgId: options.orgId ?? "org_legacy",
    name: options.name ?? "Incident triage",
    env,
    hash,
    last4: secret.slice(-4),
    createdByUserId: "user_legacy",
    lastUsedAt: null,
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  })
  return {keyId, token: `msk_${env}_${keyId}.${secret}`, hash, last4: secret.slice(-4)}
}

/** The address that puts a legacy key on `CLOUD_CORE_ADMIN_EMAILS`. */
export function legacyKeyAddress(key: {keyId: string}): string {
  return `api-key@${key.keyId}.local`
}
