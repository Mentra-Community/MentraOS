/**
 * `@mentra/cloud-shared` — types, config, observability primitives shared
 * across the core, audio, and proxy packages.
 */

export { createLogger, type Logger } from "./logger";
export {
  createHealthApp,
  type HealthAppOptions,
  type ReadinessCheck,
} from "./health";
export {
  verifyAccessTokenSignature,
  assertRuntimeAuthConfigured,
  verifyRuntimeToken,
  signRuntimeToken,
  AccessTokenError,
  resetMentraKeyCache,
  resetRuntimeAuthCache,
  type VerifiedAccessToken,
} from "./auth";

export const PACKAGE_NAME = "@mentra/cloud-shared";
