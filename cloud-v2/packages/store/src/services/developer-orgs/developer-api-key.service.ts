import {createHash, randomBytes, timingSafeEqual} from "node:crypto"
import {ulid} from "ulid"
import {DeveloperOrgApiKeyModel} from "../../models/developer-org-api-key.model"

export interface ApiKeyRecord {
  id: string // keyId — what the console uses to revoke
  name: string
  obfuscatedValue: string
  value: string | null // full token, only returned on creation
  permissions: string[]
  createdAt: string | null
  updatedAt: string | null
  lastUsedAt: string | null
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

// Token env segment must be a single [a-z0-9] word (no `_` / `.` which the token
// format uses as separators).
function safeEnv(env: string): string {
  return env.replace(/[^a-z0-9]/gi, "").toLowerCase() || "local"
}

/**
 * Mints and validates org API keys in our DB. Tokens are env-pinned so a key
 * minted in one environment can never authenticate against another.
 */
export class DeveloperApiKeyService {
  async create(orgId: string, name: string, createdByUserId: string, env: string): Promise<ApiKeyRecord> {
    const keyId = ulid()
    const secret = randomBytes(32).toString("base64url")
    const token = `msk_${safeEnv(env)}_${keyId}.${secret}`
    const doc = await DeveloperOrgApiKeyModel.create({
      keyId,
      orgId,
      name,
      env: safeEnv(env),
      hash: sha256Hex(secret),
      last4: secret.slice(-4),
      createdByUserId,
    })
    return {...serializeApiKey(doc.toObject(), env), value: token}
  }

  async list(orgId: string, env: string): Promise<ApiKeyRecord[]> {
    // Scope to the current environment, matching create/validate which pin env.
    const rows = await DeveloperOrgApiKeyModel.find({orgId, env: safeEnv(env), revokedAt: null})
      .sort({createdAt: -1})
      .lean()
    return rows.map((row) => serializeApiKey(row, env))
  }

  async revoke(orgId: string, keyId: string): Promise<boolean> {
    const result = await DeveloperOrgApiKeyModel.updateOne(
      {orgId, keyId, revokedAt: null},
      {$set: {revokedAt: new Date()}},
    )
    return result.matchedCount > 0
  }

  /** Validate a presented bearer token (env-pinned). Returns the owning org or null. */
  async validate(token: string, env: string): Promise<{orgId: string; keyId: string} | null> {
    if (!token.startsWith("msk_")) return null
    const dot = token.indexOf(".")
    if (dot < 0) return null
    const parts = token.slice(0, dot).split("_") // ["msk", "<env>", "<keyId>"]
    const secret = token.slice(dot + 1)
    if (parts.length !== 3) return null
    const [, tokenEnv, keyId] = parts
    if (!keyId || !secret || tokenEnv !== safeEnv(env)) return null

    const row = await DeveloperOrgApiKeyModel.findOne({keyId, revokedAt: null}).lean()
    if (!row) return null
    // Env is bound to the stored row, not just the client-supplied prefix.
    if (row.env !== safeEnv(env)) return null
    const expected = Buffer.from(row.hash, "hex")
    const actual = Buffer.from(sha256Hex(secret), "hex")
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

    // Throttled last-used update (≤ once/min), fire-and-forget — never block auth.
    if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > 60_000) {
      void DeveloperOrgApiKeyModel.updateOne({keyId}, {$set: {lastUsedAt: new Date()}}).catch(() => {})
    }
    return {orgId: row.orgId, keyId}
  }
}

function serializeApiKey(
  row: {
    keyId: string
    name: string
    last4: string
    createdAt?: Date
    updatedAt?: Date
    lastUsedAt?: Date | null
  },
  env: string,
): ApiKeyRecord {
  return {
    id: row.keyId,
    name: row.name,
    obfuscatedValue: `msk_${safeEnv(env)}_…${row.last4}`,
    value: null,
    permissions: [],
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  }
}
