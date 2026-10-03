/**
 * `@mentra/cloud-shared` — types, config, observability primitives shared
 * across the core, audio, and proxy packages.
 */

export {createLogger, type Logger} from "./logger"
export {createHealthApp, type HealthAppOptions, type ReadinessCheck} from "./health"
export {
  verifyAccessTokenSignature,
  assertRuntimeAuthConfigured,
  verifyRuntimeToken,
  signRuntimeToken,
  AccessTokenError,
  resetMentraKeyCache,
  resetRuntimeAuthCache,
  type VerifiedAccessToken,
  type FederatedIdentity,
} from "./auth"
export {verifyOidcToken, resetOidcVerifierCache, OidcTokenError, type OidcProviderConfig} from "./oidc"

export const PACKAGE_NAME = "@mentra/cloud-shared"
