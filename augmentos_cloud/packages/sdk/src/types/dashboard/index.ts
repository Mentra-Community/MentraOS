// TODO: 
/**
 * Dashboard API Types
 * 
 * Type definitions for the dashboard functionality in the SDK.
 */
import { Layout } from '../layouts';
import { TpaToCloudMessageType } from '../message-types';

/**
 * Dashboard modes supported by the system
 */
export enum DashboardMode {
  MAIN = 'main',           // Full dashboard experience
  EXPANDED = 'expanded',   // More space for TPA content
  // ALWAYS_ON = 'always_on'  // Persistent minimal dashboard
}

/**
 * Dashboard API for the system dashboard TPA
 */
export interface DashboardSystemAPI {
  /**
   * Set content for the top left section of the dashboard
   * @param content Content to display
   */
  setTopLeft(content: string): void;
  
  /**
   * Set content for the top right section of the dashboard
   * @param content Content to display
   */
  setTopRight(content: string): void;
  
  /**
   * Set content for the bottom left section of the dashboard
   * @param content Content to display
   */
  setBottomLeft(content: string): void;
  
  /**
   * Set content for the bottom right section of the dashboard
   * @param content Content to display
   */
  setBottomRight(content: string): void;
  
  /**
   * Set the current dashboard mode
   * @param mode Dashboard mode to set
   */
  setViewMode(mode: DashboardMode): void;
}

/**
 * Dashboard API for all TPAs
 */
export interface DashboardContentAPI {
  /**
   * Write content to dashboard
   * @param content Content to display
   * @param targets Optional list of dashboard modes to target
   */
  write(content: string, targets?: DashboardMode[]): void;
  
  /**
   * Write content to main dashboard mode
   * @param content Content to display
   */
  writeToMain(content: string): void;
  
  /**
   * Write content to expanded dashboard mode
   * @param content Text content to display
   */
  writeToExpanded(content: string): void;
  
  /**
   * Write content to always-on dashboard mode
   * @param content Content to display
   */
  // writeToAlwaysOn(content: string): void;
  
  /**
   * Get current active dashboard mode
   * @returns Promise resolving to current mode or 'none'
   */
  getCurrentMode(): Promise<DashboardMode | 'none'>;
  
  /**
   * Check if always-on dashboard is enabled
   * @returns Promise resolving to boolean
   */
  // isAlwaysOnEnabled(): Promise<boolean>;
  
  /**
   * Register for mode change notifications
   * @param callback Function to call when mode changes
   * @returns Cleanup function to unregister callback
   */
  onModeChange(callback: (mode: DashboardMode | 'none') => void): () => void;
  
  /**
   * Register for always-on mode change notifications
   * @param callback Function to call when always-on mode changes
   * @returns Cleanup function to unregister callback
   */
  // onAlwaysOnChange(callback: (enabled: boolean) => void): () => void;
}

/**
 * Dashboard API exposed on TpaSession
 */
export interface DashboardAPI {
  /**
   * System dashboard API (only available for system dashboard TPA)
   */
  system?: DashboardSystemAPI;
  
  /**
   * Content API (available to all TPAs)
   */
  content: DashboardContentAPI;
}

/**
 * Message to update dashboard content
 */
export interface DashboardContentUpdate {
  type: TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE;
  packageName: string;
  sessionId: string;
  content: string;
  modes: DashboardMode[];
  timestamp: Date;
}

/**
 * Message for dashboard mode change
 */
export interface DashboardModeChange {
  type: TpaToCloudMessageType.DASHBOARD_MODE_CHANGE;
  packageName: string;
  sessionId: string;
  mode: DashboardMode;
  timestamp: Date;
}

/**
 * Message to update system dashboard content
 */
export interface DashboardSystemUpdate {
  type: TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE;
  packageName: string;
  sessionId: string;
  section: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  content: string;
  timestamp: Date;
}

/**
 * Union type of all dashboard message types
 */
export type DashboardMessage = 
  | DashboardContentUpdate 
  | DashboardModeChange
  | DashboardSystemUpdate;