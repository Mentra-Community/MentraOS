// src/types/app.types.ts

import { HardwareRequirement } from "@mentra/sdk";
import { HardwareRequirementLevel, HardwareType } from "../types/enums";

// Define App type enum
export enum AppType {
  STANDARD = "standard",
  SYSTEM = "system",
  BACKGROUND = "background",
}

// Re-export SDK types for convenience
export { HardwareType, HardwareRequirementLevel, type HardwareRequirement };

// App settings interface
export interface AppSettings {
  [key: string]: unknown;
}

/**
 * Result of a hardware compatibility check
 * Matches backend CompatibilityResult from HardwareCompatibilityService
 */
export interface CompatibilityResult {
  isCompatible: boolean;
  missingRequired: HardwareRequirement[];
  missingOptional: HardwareRequirement[];
  warnings: string[];
}

/**
 * Device info returned from backend when user has connected glasses
 */
export interface DeviceInfo {
  connected: boolean;
  modelName: string | null;
}

/**
 * App interface for frontend
 * Matches server-side AppI but adapted for the frontend needs
 */
export interface AppI {
  packageName: string;
  name: string;
  description?: string;
  publicUrl?: string;
  webviewURL?: string; // URL for phone UI
  logoURL: string;
  appType?: AppType; // Type of App
  tpaType?: AppType; // TODO: remove this once we have migrated over

  // App details
  version?: string;
  settings?: AppSettings;
  permissions?: {
    type: string;
    description?: string;
  }[];

  // Hardware requirements
  hardwareRequirements?: HardwareRequirement[];

  // Preview images for app store
  previewImages?: {
    url: string;
    imageId: string;
    orientation: "landscape" | "portrait";
    order: number;
  }[];

  // Frontend-specific properties
  developerId?: string; // Developer's email address
  isInstalled?: boolean;
  installedDate?: string;
  uninstallable?: boolean; // Whether the app can be uninstalled

  /**
   * Latest known online status of the app's backend.
   * Provided by the server to indicate if the app appears reachable.
   */
  isOnline?: boolean;

  // Organization information
  organizationId?: string; // Reference to organization
  orgName?: string; // Name of the organization

  // Developer/Organization profile information
  developerProfile?: {
    company?: string;
    website?: string;
    contactEmail?: string;
    description?: string;
    logo?: string;
  };

  // Timestamps
  createdAt?: string;
  updatedAt?: string;

  // Compatibility info (returned when user is authenticated and has connected glasses)
  compatibility?: CompatibilityResult;
}

// Install info interface
export interface InstallInfo {
  packageName: string;
  installedDate: string;
}

// User interface
export interface User {
  id: string;
  email: string;
  installedApps?: InstallInfo[];
  createdAt?: string;
  updatedAt?: string;
}
