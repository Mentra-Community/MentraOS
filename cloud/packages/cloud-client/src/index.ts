/**
 * @augmentos/cloud-client
 *
 * Pure TypeScript SDK for connecting to and interacting with the AugmentOS cloud platform.
 * This client provides a clean, production-ready interface that mirrors the cloud architecture.
 */

export { MentraClient } from "./MentraClient";
export { AccountService } from "./services/AccountService";
export { LiveKitManager } from "./managers/LiveKitManager";
export type { LiveKitManagerOptions } from "./managers/LiveKitManager";
export type {
  ClientConfig,
  AudioConfig,
  DeviceConfig,
  BehaviorConfig,
  DebugConfig,
  DisplayEvent,
  AppStateChange,
  ConnectionAck,
  AccountCredentials,
  CoreTokenPayload,
} from "./types";

// Re-export some useful types from the SDK
export type {
  GlassesToCloudMessage,
  CloudToGlassesMessage,
  Layout,
  ViewType,
  LayoutType,
} from "./types/sdk-types";
