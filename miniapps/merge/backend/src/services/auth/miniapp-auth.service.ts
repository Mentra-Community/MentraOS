import * as jose from "jose"

export interface VerifiedMiniappAuth {
  mentraUserId: string
  oemId?: string
  packageName: string
}

export class MiniappAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MiniappAuthError"
  }
}

const DEFAULT_PACKAGE_NAME = "com.mentra.local-merge"
const DEFAULT_CORE_URL = "http://localhost:3000"
const DEFAULT_ISSUER = "mentra"
const ALGORITHMS = ["EdDSA"] as const

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null
let jwksUrlCache = ""

function packageName(): string {
  return process.env.MERGE_PACKAGE_NAME?.trim() || DEFAULT_PACKAGE_NAME
}

function issuer(): string {
  return process.env.MENTRA_MINIAPP_TOKEN_ISSUER?.trim() || DEFAULT_ISSUER
}

function jwksUrl(): string {
  const explicit = process.env.MENTRA_JWKS_URL?.trim()
  if (explicit) return explicit

  const coreUrl = (process.env.MENTRA_CORE_URL?.trim() || DEFAULT_CORE_URL).replace(/\/+$/, "")
  return `${coreUrl}/.well-known/jwks.json`
}

function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
  const url = jwksUrl()
  if (!jwks || jwksUrlCache !== url) {
    jwksUrlCache = url
    jwks = jose.createRemoteJWKSet(new URL(url), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    })
  }
  return jwks
}

export async function verifyMiniappAuthHeader(header: string | undefined): Promise<VerifiedMiniappAuth> {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "")
  if (!match) {
    throw new MiniappAuthError("missing bearer token")
  }

  let payload: jose.JWTPayload
  try {
    const result = await jose.jwtVerify(match[1]!, getJwks(), {
      issuer: issuer(),
      audience: packageName(),
      algorithms: [...ALGORITHMS],
      clockTolerance: "2 minutes",
    })
    payload = result.payload
  } catch (err) {
    throw new MiniappAuthError(`miniapp token rejected: ${(err as Error).message}`)
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new MiniappAuthError("miniapp token missing subject")
  }

  return {
    mentraUserId: payload.sub,
    oemId: typeof payload.oemId === "string" ? payload.oemId : undefined,
    packageName: packageName(),
  }
}

