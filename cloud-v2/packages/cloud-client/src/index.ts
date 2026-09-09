/**
 * @fileoverview Public entry for `@mentra/cloud-client` (the root, shared build).
 *
 * This is the platform-agnostic import: it exposes `CloudClient` plus the public
 * config, transport, error, and logger types a host needs to construct and use
 * it. The `react-native` and `node` subpath imports wrap this with their own
 * transports pre-wired.
 *
 * Wire/protocol types (`AudioSubscription`, `TranscriptionData`, the message
 * unions) are NOT re-exported here: a host imports those from
 * `@mentra/cloud-protocol` directly, so there is one source of truth and
 * the client cannot drift from what the cloud accepts.
 *
 * See docs/issues/004-cloud-client/spec.md and design.md.
 */

// The top-level object. Implemented in ./client by the client agent; re-exported
// here so the public import is `@mentra/cloud-client`, not a deep path.
export { CloudClient } from "./client";
export { DEFAULT_REFRESH_TOKEN_KEY } from "./modules/auth/token-store";

// Construction contract.
export type {
  CloudClientConfig,
  AuthConfig,
  SubjectTokenType,
} from "./config";

// The platform pieces a host (or a platform wrapper) supplies.
export type {
  CloudClientTransports,
  WebSocketLike,
  UdpSocketLike,
  KeyValueStore,
} from "./transports";
export type { CloudClientTimers } from "./timers";

// Local error types a host can branch on with `instanceof`.
export {
  CloudClientError,
  HttpError,
  AuthExpiredError,
  SessionRevocationError,
} from "./errors";

// The logging hook a host can implement to route library logs.
export { noopLogger } from "./logger";
export type { Logger } from "./logger";

// Runtime lifecycle state exposed to hosts for UI/debugging and fallback policy.
export type {
  PreinstalledInstallPolicy,
  PreinstalledMiniappRegistry,
  PreinstalledMiniappRegistryEntry,
} from "./modules/core/core";

export type {
  RuntimeAudioTransport,
  RuntimeSnapshot,
  RuntimeStatus,
  RuntimeTtsSpeakOptions,
  RuntimeTtsSpeechSource,
} from "./modules/runtime/runtime";

export type {
  AddReportArtifactsResult,
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportKind,
  ReportLogEntry,
  ReportStatus,
  ReportSystemPriority,
  ReportTrigger,
  SubmitReportInput,
  SubmitReportResult,
  SupportConnectionState,
  SupportProfileUpdateResult,
  SupportStateInput,
} from "./modules/core/core";
