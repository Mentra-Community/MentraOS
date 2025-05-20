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

// Define PermissionType enum until it's added to the SDK
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',
  LOCATION = 'LOCATION',
  CALENDAR = 'CALENDAR',
  NOTIFICATIONS = 'NOTIFICATIONS',
  ALL = 'ALL'
}

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
  developerId?: string;
  
  // Auth
  hashedEndpointSecret?: string;
  hashedApiKey?: string;
  
  // App details
  permissions?: Permission[];
  description?: string;
  version?: string;
  settings?: AppSettings;

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
  | (BaseAppSetting & { 
      type: AppSettingType.SELECT; 
      options: { label: string; value: any }[]; 
      defaultValue?: any;
      value?: any;
    });

export type AppSettings = AppSetting[];

/**
 * Group setting (for UI organization)
 */
export interface GroupSetting {
  type: 'group';
  title: string;
}

/**
 * TPA configuration file structure
 * Represents the schema in tpa_config.json
 */
export interface TpaConfig {
  name: string;
  description: string;
  version: string;
  settings: (AppSetting | GroupSetting)[];
}

/**
 * Validate a TPA configuration object
 * @param config Object to validate
 * @returns True if the config is valid
 */
export function validateTpaConfig(config: any): config is TpaConfig {
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
    
    // Regular settings need key and label
    if (typeof setting.key !== 'string' || typeof setting.label !== 'string') {
      return false;
    }
    
    // Type-specific validation
    switch (setting.type) {
      case AppSettingType.TOGGLE:
        return typeof setting.defaultValue === 'boolean';
      
      case AppSettingType.TEXT:
        return setting.defaultValue === undefined || typeof setting.defaultValue === 'string';
      
      case AppSettingType.SELECT:
        return Array.isArray(setting.options) && 
               setting.options.every((opt: any) => 
                 typeof opt.label === 'string' && 'value' in opt);
      
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