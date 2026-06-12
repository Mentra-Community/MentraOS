/**
 * @mentra/types - App/Applet types for client interfaces
 */

import type {ReactNode} from "react"

import {HardwareRequirement} from "./hardware"

import type {CompatibilityResult} from "../utils/hardware/hardware"

/**
 * App execution model types
 */
export type AppletType = "standard" | "background" | "system_dashboard"

/**
 * Permission types that apps can request
 */
export type AppPermissionType =
  | "ALL"
  | "MICROPHONE"
  | "CAMERA"
  | "CALENDAR"
  | "LOCATION"
  | "BACKGROUND_LOCATION"
  | "READ_NOTIFICATIONS"
  | "POST_NOTIFICATIONS"

/**
 * Permission object with type and description
 */
export interface AppletPermission {
  type: AppPermissionType
  description?: string
  required?: boolean
}

/**
 * Minimal app interface for client home screen display
 * Optimized for fast rendering - only essential fields
 *
 * This is the client-facing interface used by mobile apps.
 * Internal cloud services use AppI from models (more fields).
 */
export interface AppletInterface {
  packageName: string
  name: string
  webviewUrl: string
  logoUrl: string
  iconComponent?: ReactNode
  type: AppletType
  permissions: AppletPermission[]
  running: boolean
  /**
   * True while this app's UI WebView is mounted in the Compositor overlay.
   * At most one app is foregrounded at a time. Distinct from `running`:
   * a foregrounded app is always running, but a running app may be
   * backgrounded (JSContext alive, WebView torn down). Normalized to a
   * concrete boolean by the apps store's projectApps; literal call sites
   * may omit it.
   */
  foregrounded?: boolean
  healthy: boolean
  hardwareRequirements: HardwareRequirement[]
  /** ISO date string when the app was installed */
  installedDate?: string
  /** ISO date string when the app was last run. Undefined if never run (app is "new") */
  lastActiveAt?: string
}

/**
 * Runtime applet shape used by the island apps store and OEM hosts.
 *
 * Extends AppletInterface with the host-side fields the manager / OEM tracks
 * outside the manifest: offline routing, hardware compatibility result,
 * loading/hidden/local flags, lifecycle hooks, screenshot, and the
 * dev-miniapp escape hatches (`devUrl` / `isMiniappDev`) that surface a
 * `mentra-miniapp dev` snapshot.
 */
export interface ClientApp extends AppletInterface {
  offline: boolean
  offlineRoute: string
  compatibility?: CompatibilityResult
  loading: boolean
  local: boolean
  hidden: boolean
  onStart?: () => void
  onStop?: () => void
  screenshot?: string
  runtimePermissions?: string[]
  declaredPermissions?: string[]
  version?: string
  needsPcm?: boolean
  needsTranscript?: boolean
  devUrl?: string
  isMiniappDev?: boolean
}
