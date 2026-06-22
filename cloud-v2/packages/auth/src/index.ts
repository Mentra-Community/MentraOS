import * as jose from "jose";

const DEFAULT_JWKS_URL = "https://core.mentraglass.com/.well-known/jwks.json";
const DEFAULT_ISSUER = "cloud-core";
const DEFAULT_CLOCK_TOLERANCE = "2 minutes";
const DEFAULT_ALGORITHMS = ["EdDSA"] as const;
const DEFAULT_CONTEXT_KEY = "mentraAuth";

export interface VerifiedMentraAuth {
  mentraUserId: string;
  oemId?: string;
  packageName: string;
  tokenId?: string;
  expiresAt?: number;
  issuedAt?: number;
  claims: jose.JWTPayload;
}

export interface MentraAuthOptions {
  /**
   * The packageName this backend serves. Miniapp auth tokens are audience-pinned
   * to exactly one packageName, so this should be the miniapp's packageName.
   */
  packageName?: string;
  /**
   * Explicit JWKS URL. Defaults to the production Cloud Core JWKS endpoint.
   * Override for local, staging, test, or self-hosted Core deployments.
   */
  jwksUrl?: string;
  /**
   * Expected token issuer.
   */
  issuer?: string | string[];
  /**
   * Allowed signature algorithms. Defaults to EdDSA.
   */
  algorithms?: string[];
  /**
   * jose clockTolerance option. Defaults to two minutes for mobile clock skew.
   */
  clockTolerance?: string | number;
  /**
   * Remote JWKS fetch timeout in milliseconds.
   */
  timeoutMs?: number;
  /**
   * Remote JWKS cache max age in milliseconds.
   */
  cacheMaxAgeMs?: number;
  /**
   * Remote JWKS cooldown duration in milliseconds.
   */
  cooldownMs?: number;
}

export interface MentraAuthVariables {
  mentraAuth: VerifiedMentraAuth;
}

export interface MentraHonoOptions {
  /**
   * Hono context variable key. Defaults to "mentraAuth".
   */
  contextKey?: string;
  /**
   * Custom response for missing or rejected auth. Defaults to JSON 401.
   */
  onUnauthorized?: (error: MentraAuthError, c: HonoLikeContext) => Response | Promise<Response>;
}

export interface HonoLikeContext {
  req: {
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
  json(body: unknown, status?: number): Response;
}

export type HonoLikeNext = () => Promise<void>;
export type HonoLikeMiddleware = (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | void>;

export class MentraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MentraAuthError";
  }
}

export class MentraAuth {
  private readonly packageName: string;
  private readonly issuer: string | string[];
  private readonly algorithms: string[];
  private readonly clockTolerance: string | number;
  private readonly jwksUrl: string;
  private readonly jwks: ReturnType<typeof jose.createRemoteJWKSet>;

  constructor(options: MentraAuthOptions = {}) {
    this.packageName = resolvePackageName(options.packageName);
    this.issuer = resolveIssuer(options.issuer);
    this.algorithms = options.algorithms ?? [...DEFAULT_ALGORITHMS];
    this.clockTolerance = options.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
    this.jwksUrl = resolveJwksUrl(options);
    this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUrl), {
      timeoutDuration: options.timeoutMs ?? 5_000,
      cacheMaxAge: options.cacheMaxAgeMs,
      cooldownDuration: options.cooldownMs ?? 30_000,
    });
  }

  async verifyToken(token: string): Promise<VerifiedMentraAuth> {
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, this.getJwks(), {
        issuer: this.issuer,
        audience: this.packageName,
        algorithms: this.algorithms,
        clockTolerance: this.clockTolerance,
      });
      payload = result.payload;
    } catch (err) {
      throw new MentraAuthError(`miniapp token rejected: ${(err as Error).message}`);
    }

    const subject = stringClaim(payload.sub);
    if (!subject) {
      throw new MentraAuthError("miniapp token missing subject");
    }

    return {
      mentraUserId: subject,
      oemId: stringClaim(payload.oemId),
      packageName: this.packageName,
      tokenId: stringClaim(payload.jti),
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
      claims: payload,
    };
  }

  async verifyAuthHeader(header: string | undefined | null): Promise<VerifiedMentraAuth> {
    return this.verifyToken(extractBearerToken(header));
  }

  async verifyRequest(request: Request): Promise<VerifiedMentraAuth> {
    return this.verifyAuthHeader(request.headers.get("Authorization"));
  }

  hono(options: MentraHonoOptions = {}): HonoLikeMiddleware {
    const contextKey = options.contextKey ?? DEFAULT_CONTEXT_KEY;
    return async (c, next) => {
      try {
        c.set(contextKey, await this.verifyAuthHeader(c.req.header("Authorization")));
        return await next();
      } catch (error) {
        if (error instanceof MentraAuthError) {
          return options.onUnauthorized?.(error, c) ?? c.json({ error: error.message }, 401);
        }
        throw error;
      }
    };
  }

  private getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
    return this.jwks;
  }
}

export function createMentraAuth(options: MentraAuthOptions = {}): MentraAuth {
  return new MentraAuth(options);
}

export async function verifyMentraToken(
  token: string,
  options: MentraAuthOptions = {},
): Promise<VerifiedMentraAuth> {
  return createMentraAuth(options).verifyToken(token);
}

export async function verifyMentraAuthHeader(
  header: string | undefined | null,
  options: MentraAuthOptions = {},
): Promise<VerifiedMentraAuth> {
  return createMentraAuth(options).verifyAuthHeader(header);
}

export function extractBearerToken(header: string | undefined | null): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) {
    throw new MentraAuthError("missing bearer token");
  }
  return match[1];
}

export function mentraJwksUrl(options: Pick<MentraAuthOptions, "jwksUrl"> = {}): string {
  return resolveJwksUrl(options);
}

function resolvePackageName(packageName?: string): string {
  const value =
    packageName ??
    env("MENTRA_PACKAGE_NAME") ??
    env("MINIAPP_PACKAGE_NAME") ??
    env("PACKAGE_NAME");
  if (!value) {
    throw new MentraAuthError("packageName is required");
  }
  return value;
}

function resolveJwksUrl(options: Pick<MentraAuthOptions, "jwksUrl">): string {
  return options.jwksUrl ?? env("MENTRA_AUTH_JWKS_URL") ?? DEFAULT_JWKS_URL;
}

function resolveIssuer(issuer?: string | string[]): string | string[] {
  if (Array.isArray(issuer)) return issuer;
  if (issuer) return issuer;

  const issuers = env("MENTRA_AUTH_ISSUERS")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (issuers && issuers.length > 0) return issuers;

  return env("MENTRA_AUTH_ISSUER") ?? DEFAULT_ISSUER;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
