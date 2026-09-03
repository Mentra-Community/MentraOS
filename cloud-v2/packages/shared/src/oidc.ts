import * as jose from "jose"

export interface OidcProviderConfig {
  issuer: string
  jwksUrl: string
  audience: string
  algorithms?: string[]
  requiredScopes?: string[]
  allowedClientIds?: string[]
}

export class OidcTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OidcTokenError"
  }
}

const remoteJwks = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>()

export async function verifyOidcToken(token: string, config: OidcProviderConfig): Promise<jose.JWTPayload> {
  let keySet = remoteJwks.get(config.jwksUrl)
  if (!keySet) {
    let url: URL
    try {
      url = new URL(config.jwksUrl)
    } catch {
      throw new OidcTokenError("OIDC jwksUrl is not a valid URL")
    }
    if (url.protocol !== "https:") {
      throw new OidcTokenError("OIDC jwksUrl must use HTTPS")
    }
    keySet = jose.createRemoteJWKSet(url, {
      cooldownDuration: 30_000,
      cacheMaxAge: 5 * 60_000,
    })
    remoteJwks.set(config.jwksUrl, keySet)
  }

  let payload: jose.JWTPayload
  try {
    ;({payload} = await jose.jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms ?? ["RS256"],
      clockTolerance: "5 minutes",
    }))
  } catch (err) {
    throw new OidcTokenError(`OIDC token rejected: ${(err as Error).message}`)
  }

  const grantedScopes = new Set(typeof payload.scp === "string" ? payload.scp.split(" ").filter(Boolean) : [])
  for (const requiredScope of config.requiredScopes ?? []) {
    if (!grantedScopes.has(requiredScope)) {
      throw new OidcTokenError(`OIDC token missing required scope: ${requiredScope}`)
    }
  }

  if (config.allowedClientIds?.length) {
    const clientId = stringClaim(payload.azp) ?? stringClaim(payload.appid)
    if (!clientId || !config.allowedClientIds.includes(clientId)) {
      throw new OidcTokenError("OIDC token client is not allowed")
    }
  }

  return payload
}

export function resetOidcVerifierCache(): void {
  remoteJwks.clear()
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
