// @augmentos/sdk
// packages/sdk/types/src/models.ts - Core models

import { AppSettingType, AppState, Language, TpaType } from './enums';


// Tool parameter type definition
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: string[];
  required?: boolean;
}

// Tool schema definition for TPAs
export interface ToolSchema {
  id: string;
  description: string;
  activationPhrases?: string[];
  parameters?: Record<string, ToolParameterSchema>;
}

/**
 * Developer profile information
 */
export interface DeveloperProfile {
  company?: string;
  website?: string;
  contactEmail?: string;
  description?: string;
  logo?: string;
}

// Define PermissionType enum with legacy support
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',

  // Legacy notification permission (backward compatibility)
  NOTIFICATIONS = 'NOTIFICATIONS',

  // New granular notification permissions
  READ_NOTIFICATIONS = 'READ_NOTIFICATIONS',
  POST_NOTIFICATIONS = 'POST_NOTIFICATIONS',

  ALL = 'ALL'
}

// Legacy permission mapping for backward compatibility
export const LEGACY_PERMISSION_MAP = new Map<PermissionType, PermissionType[]>([
  [PermissionType.NOTIFICATIONS, [PermissionType.READ_NOTIFICATIONS]]
]);

// Permission interface
export interface Permission {
  type: PermissionType;
  description?: string;
}

/**
 * Base interface for applications
 */
export interface AppI {
  packageName: string;
  name: string;
  publicUrl: string;              // Base URL of the app server
  isSystemApp?: boolean;          // Is this a system app?
  uninstallable?: boolean;        // Can the app be uninstalled?

  webviewURL?: string;            // URL for phone UI
  logoURL: string;
  tpaType: TpaType;               // Type of app
  appStoreId?: string;            // Which app store registered this app

  /**
   * @deprecated Use organizationId instead. Will be removed after migration.
   */
  developerId?: string;           // ID of the developer who created the app
  organizationId?: any;        // ID of the organization that owns this app

  // Auth
  hashedEndpointSecret?: string;
  hashedApiKey?: string;

  // App details
  permissions?: Permission[];
  description?: string;
  version?: string;
  settings?: AppSettings;
  tools?: ToolSchema[];

  isPublic?: boolean;
  appStoreStatus?: 'DEVELOPMENT' | 'SUBMITTED' | 'REJECTED' | 'PUBLISHED';
}

/**
 * Base interface for all app settings
 */
export interface BaseAppSetting {
  key: string;
  label: string;
  value?: any; // User's selected value
  defaultValue?: any; // System default
}

/**
 * Setting types for applications
 */
export type AppSetting =
  | (BaseAppSetting & { type: AppSettingType.TOGGLE; defaultValue: boolean; value?: boolean })
  | (BaseAppSetting & { type: AppSettingType.TEXT; defaultValue?: string; value?: string })
  | (BaseAppSetting & { type: AppSettingType.TEXT_NO_SAVE_BUTTON; defaultValue?: string; value?: string; maxLines?: number })
  | (BaseAppSetting & {
      type: AppSettingType.SELECT;
      options: { label: string; value: any }[];
      defaultValue?: any;
      value?: any;
    })
  | (BaseAppSetting & {
      type: AppSettingType.SELECT_WITH_SEARCH;
      options: { label: string; value: any }[];
      defaultValue?: any;
      value?: any;
    })
  | (BaseAppSetting & {
      type: AppSettingType.MULTISELECT;
      options: { label: string; value: any }[];
      defaultValue?: any[];
      value?: any[];
    })
  | (BaseAppSetting & {
      type: AppSettingType.SLIDER;
      min: number;
      max: number;
      defaultValue: number;
      value?: number;
    })
  | (BaseAppSetting & {
      type: AppSettingType.GROUP;
      title: string;
    })
  | (BaseAppSetting & {
      type: AppSettingType.TITLE_VALUE;
      label: string;
      value: any;
      key?: never; // TITLE_VALUE settings don't need keys since they're display-only
    });

export type AppSettings = AppSetting[];

/**
 * TPA configuration file structure
 * Represents the schema in tpa_config.json
 */
export interface AppConfig {
  name: string;
  description: string;
  version: string;
  settings: AppSetting[];
  tools: ToolSchema[];
}

/**
 * Validate a TPA configuration object
 * @param config Object to validate
 * @returns True if the config is valid
 */
export function validateAppConfig(config: any): config is AppConfig {
  if (!config || typeof config !== 'object') return false;

  // Check required string properties
  if (typeof config.name !== 'string' ||
      typeof config.description !== 'string' ||
      typeof config.version !== 'string') {
    return false;
  }

  // Check settings array
  if (!Array.isArray(config.settings)) return false;

  // Validate each setting
  return config.settings.every((setting: any) => {
    // Group settings just need a title
    if (setting.type === 'group') {
      return typeof setting.title === 'string';
    }

    // TITLE_VALUE settings just need label and value
    if (setting.type === 'titleValue') {
      return typeof setting.label === 'string' && 'value' in setting;
    }

    // Regular settings need key and label
    if (typeof setting.key !== 'string' || typeof setting.label !== 'string') {
      return false;
    }

    // Type-specific validation
    switch (setting.type) {
      case AppSettingType.TOGGLE:
        return typeof setting.defaultValue === 'boolean';

      case AppSettingType.TEXT:
      case AppSettingType.TEXT_NO_SAVE_BUTTON:
        return setting.defaultValue === undefined || typeof setting.defaultValue === 'string';

      case AppSettingType.SELECT:
      case AppSettingType.SELECT_WITH_SEARCH:
        return Array.isArray(setting.options) &&
               setting.options.every((opt: any) =>
                 typeof opt.label === 'string' && 'value' in opt);

      case AppSettingType.MULTISELECT:
        return Array.isArray(setting.options) &&
               setting.options.every((opt: any) =>
                 typeof opt.label === 'string' && 'value' in opt) &&
               (setting.defaultValue === undefined || Array.isArray(setting.defaultValue));

      case AppSettingType.SLIDER:
        return typeof setting.defaultValue === 'number' &&
               typeof setting.min === 'number' &&
               typeof setting.max === 'number' &&
               setting.min <= setting.max;

      case AppSettingType.GROUP:
        return typeof setting.title === 'string';

      case AppSettingType.TITLE_VALUE:
        return typeof setting.label === 'string' && 'value' in setting;

      default:
        return false;
    }
  });
}

/**
 * Transcript segment for speech processing
 */
export interface TranscriptSegment {
  speakerId?: string;
  resultId: string;
  text: string;
  timestamp: Date;
  isFinal: boolean;
}

/**
 * Complete transcript
 */
export interface TranscriptI {
  segments: TranscriptSegment[];
  languageSegments?: Map<string, TranscriptSegment[]>; // Language-indexed map for multi-language support
}