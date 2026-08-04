import * as jose from "jose";

/**
 * Public JWKS endpoints for every Mentra-hosted environment, in fallback order.
 * A miniapp token is signed by exactly one environment, but environments reuse
 * the same `kid`s with different key material, so we cannot pick the right key
 * by `kid` alone. Verification tries each endpoint in order and accepts the
 * first whose key validates the signature. See docs/issues/017.
 */
export const MENTRA_JWKS_URLS = [
  "https://core.mentraglass.com/.well-known/jwks.json", // prod
  "https://core.staging.us-west-2.mentraglass.com/.well-known/jwks.json", // staging
  "https://core.dev.us-west-2.mentraglass.com/.well-known/jwks.json", // dev
  "https://core.debug.us-west-2.mentraglass.com/.well-known/jwks.json", // debug
];
const DEFAULT_ISSUER = "cloud-core";
const DEFAULT_CLOCK_TOLERANCE = "2 minutes";
const DEFAULT_ALGORITHMS = ["EdDSA"] as const;
const DEFAULT_CONTEXT_KEY = "mentraAuth";

export interface VerifiedMentraAuth {
  mentraUserId: string;
  tenantId?: string;
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
   * Explicit single JWKS URL. Overrides the built-in Mentra environment list and
   * disables fallback (only this URL is tried). Use for local or self-hosted Core.
   */
  jwksUrl?: string;
  /**
   * Explicit ordered list of JWKS URLs to try, first success wins. Overrides the
   * built-in Mentra environment list. Use for self-hosted multi-environment setups
   * or tests. Takes precedence over `jwksUrl`. Defaults to {@link MENTRA_JWKS_URLS}.
   */
  jwksUrls?: string[];
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
  private readonly jwksUrls: string[];
  private readonly jwksSets: ReturnType<typeof jose.createRemoteJWKSet>[];

  constructor(options: MentraAuthOptions = {}) {
    this.packageName = resolvePackageName(options.packageName);
    this.issuer = resolveIssuer(options.issuer);
    this.algorithms = options.algorithms ?? [...DEFAULT_ALGORITHMS];
    this.clockTolerance = options.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
    this.jwksUrls = resolveJwksUrls(options);
    const remoteOptions = {
      timeoutDuration: options.timeoutMs ?? 5_000,
      cacheMaxAge: options.cacheMaxAgeMs,
      cooldownDuration: options.cooldownMs ?? 30_000,
    };
    this.jwksSets = this.jwksUrls.map((url) =>
      jose.createRemoteJWKSet(new URL(url), remoteOptions),
    );
  }

  async verifyToken(token: string): Promise<VerifiedMentraAuth> {
    const payload = await this.verifyAcrossEnvironments(token);

    const subject = stringClaim(payload.sub);
    if (!subject) {
      throw new MentraAuthError("miniapp token missing subject");
    }

    return {
      mentraUserId: subject,
      tenantId: stringClaim(payload.tenantId),
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

  /**
   * Verify the token against each environment JWKS in order. A key-mismatch
   * (the token was signed by a different Mentra environment that happens to use
   * the same `kid`) falls through to the next endpoint. Any other failure means
   * the correct key already verified the signature and a claim (audience,
   * issuer, expiry) was rejected, so we stop and surface that immediately rather
   * than pointlessly retrying every environment.
   */
  private async verifyAcrossEnvironments(token: string): Promise<jose.JWTPayload> {
    const verifyOptions = {
      issuer: this.issuer,
      audience: this.packageName,
      algorithms: this.algorithms,
      clockTolerance: this.clockTolerance,
    };

    let lastKeyMismatch: Error | undefined;
    for (let i = 0; i < this.jwksSets.length; i++) {
      const isLast = i === this.jwksSets.length - 1;
      try {
        const result = await jose.jwtVerify(token, this.jwksSets[i], verifyOptions);
        return result.payload;
      } catch (err) {
        if (isKeyMismatchError(err) && !isLast) {
          lastKeyMismatch = err as Error;
          continue;
        }
        throw new MentraAuthError(`miniapp token rejected: ${(err as Error).message}`);
      }
    }

    // Only reachable if the URL list is empty; the loop otherwise returns or throws.
    throw new MentraAuthError(
      `miniapp token rejected: ${lastKeyMismatch?.message ?? "no JWKS endpoint configured"}`,
    );
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

type JwksUrlOptions = Pick<MentraAuthOptions, "jwksUrl" | "jwksUrls">;

/**
 * The first JWKS URL that would be tried for these options (the production
 * Mentra endpoint by default). Provided for back-compat and diagnostics; the
 * verifier itself tries every URL in {@link mentraJwksUrls}.
 */
export function mentraJwksUrl(options: JwksUrlOptions = {}): string {
  return resolveJwksUrls(options)[0];
}

/**
 * The full ordered list of JWKS URLs that verification will try for these
 * options. Defaults to {@link MENTRA_JWKS_URLS} (all Mentra environments).
 */
export function mentraJwksUrls(options: JwksUrlOptions = {}): string[] {
  return resolveJwksUrls(options);
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

function resolveJwksUrls(options: JwksUrlOptions): string[] {
  if (options.jwksUrls && options.jwksUrls.length > 0) {
    return [...options.jwksUrls];
  }
  if (options.jwksUrl) {
    return [options.jwksUrl];
  }

  const envList = env("MENTRA_AUTH_JWKS_URLS")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (envList && envList.length > 0) {
    return envList;
  }

  const single = env("MENTRA_AUTH_JWKS_URL");
  if (single) {
    return [single];
  }

  return [...MENTRA_JWKS_URLS];
}

/**
 * True when a verification failure means the token was minted by a different
 * Mentra environment (matching `kid` resolves to the wrong key, or no key
 * matches at all), so verification should fall through to the next endpoint.
 * Claim failures (expired, wrong audience/issuer) are NOT key mismatches.
 */
function isKeyMismatchError(err: unknown): boolean {
  if (
    err instanceof jose.errors.JWSSignatureVerificationFailed ||
    err instanceof jose.errors.JWKSNoMatchingKey ||
    err instanceof jose.errors.JWKSMultipleMatchingKeys
  ) {
    return true;
  }
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
    code === "ERR_JWKS_NO_MATCHING_KEY" ||
    code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS"
  );
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
