/**
 * @mentra/types - App/Applet types for client interfaces
 */

import { HardwareRequirement } from "./hardware";

/**
 * App execution model types
 */
export type AppletType = "standard" | "background" | "system_dashboard";

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
  | "POST_NOTIFICATIONS";

/**
 * Permission object with type and description
 */
export interface AppletPermission {
  type: AppPermissionType;
  description?: string;
  required?: boolean;
}

/**
 * Minimal app interface for client home screen display
 * Optimized for fast rendering - only essential fields
 *
 * This is the client-facing interface used by mobile apps.
 * Internal cloud services use AppI from models (more fields).
 */
export interface AppletInterface {
  packageName: string;
  name: string;
  webviewUrl: string;
  logoUrl: string;
  type: AppletType;
  permissions: AppletPermission[];
  running: boolean;
  healthy: boolean;
  hardwareRequirements: HardwareRequirement[];
  /** ISO date string when the app was installed */
  installedDate?: string;
  /** ISO date string when the app was last run. Undefined if never run (app is "new") */
  lastActiveAt?: string;
}
