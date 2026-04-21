/**
 * @mentra/sdk/session — Server-Free Entrypoint
 *
 * This entrypoint exports MentraSession and all managers WITHOUT any
 * server/Node.js/Hono dependencies. It's designed for:
 *
 * 1. Local apps running on the phone (Hermes runtime + NativeBridgeTransport)
 * 2. Environments where you create MentraSession directly with your own Transport
 * 3. Keeping bundle size small when you don't need MiniAppServer
 *
 * Usage:
 *   import { MentraSession } from "@mentra/sdk/session"
 *
 * If you need the full server (webhooks, Hono, HTTP endpoints):
 *   import { MiniAppServer, MentraSession } from "@mentra/sdk"
 *
 * @module
 */

// ─── Core Session ───────────────────────────────────────────────────────────

export { MentraSession } from "./session/MentraSession";
export type { MentraSessionConfig } from "./session/MentraSession";

// ─── Transport Interface ────────────────────────────────────────────────────
//
// Consumers provide their own Transport implementation:
//   - WebSocketTransport for cloud apps (provided by @mentra/sdk, NOT re-exported here)
//   - NativeBridgeTransport for local apps (provided by phone runtime)
//   - MockTransport for tests

export type { Transport, TransportOptions } from "./transport/Transport";
export { TransportState, isTransportOpen, isTransportClosed } from "./transport/Transport";

// ─── Manager Types ──────────────────────────────────────────────────────────
//
// Exported so consumers can type-annotate their code without importing
// the full package. The managers themselves are created internally by
// MentraSession — consumers access them via session.transcription, etc.

export type {
  TranscriptionManager,
  TranscriptionEvent,
  TranscriptionConfig,
} from "./session/managers/TranscriptionManager";
export type { TranslationManager, TranslationEvent } from "./session/managers/TranslationManager";
export type { DisplayManager } from "./session/managers/DisplayManager";
export type {
  SpeakerManager,
  PlayOptions,
  PlayResult,
  SpeakOptions,
  StreamOptions,
  AudioOutputStream,
} from "./session/managers/SpeakerManager";
export type { MicManager, AudioChunk, VadEvent } from "./session/managers/MicManager";
export type { CameraManager, PhotoOptions, PhotoData } from "./session/managers/CameraManager";
export type { DeviceManager } from "./session/managers/DeviceManager";
export type { PhoneManager } from "./session/managers/PhoneManager";
export type { LocationManager, LocationData } from "./session/managers/LocationManager";
export type { LedManager } from "./session/managers/LedManager";
export type { StorageManager } from "./session/managers/StorageManager";
export type { PermissionsManager, PermissionType } from "./session/managers/PermissionsManager";
export type { DashboardManager } from "./session/managers/DashboardManager";
export { TimeUtils } from "./session/managers/TimeUtils";

// ─── Routing (for advanced usage / testing) ─────────────────────────────────

export { DataStreamRouter, MessageHandlerRegistry } from "./session/DataStreamRouter";
export type { StreamHandler, MessageHandler } from "./session/DataStreamRouter";

// ─── Utilities ──────────────────────────────────────────────────────────────

export { Observable } from "./utils/Observable";
export { toErrorMessage, toError, warnOnce } from "./utils/error-utils";
