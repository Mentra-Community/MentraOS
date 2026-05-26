/**
 * `@cloud-v2/shared` — types, config, observability primitives shared
 * across the core, audio, and proxy packages.
 */

export { createLogger, type Logger } from "./logger";
export {
  createHealthApp,
  type HealthAppOptions,
  type ReadinessCheck,
} from "./health";

export const PACKAGE_NAME = "@cloud-v2/shared";
