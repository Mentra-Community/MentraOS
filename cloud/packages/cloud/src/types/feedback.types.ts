/**
 * @fileoverview Feedback-related type definitions.
 * Separated to avoid circular imports between services.
 */

/**
 * Structured feedback data from mobile app.
 */
export interface FeedbackData {
  type: "bug" | "feature";
  // Bug report fields
  expectedBehavior?: string;
  actualBehavior?: string;
  severityRating?: number;
  // Feature request fields
  feedbackText?: string;
  experienceRating?: number;
  // Contact email (for Apple private relay users)
  contactEmail?: string;
  // System information
  systemInfo?: {
    appVersion?: string;
    deviceName?: string;
    osVersion?: string;
    platform?: string;
    glassesConnected?: boolean;
    defaultWearable?: string;
    runningApps?: string[];
    offlineMode?: boolean;
    networkType?: string;
    networkConnected?: boolean;
    internetReachable?: boolean;
    location?: string;
    locationPlace?: string;
    isBetaBuild?: boolean;
    backendUrl?: string;
    buildCommit?: string;
    buildBranch?: string;
    buildTime?: string;
    buildUser?: string;
  };
  // Glasses information
  glassesInfo?: {
    modelName?: string;
    bluetoothId?: string;
    serialNumber?: string;
    buildNumber?: string;
    fwVersion?: string;
    appVersion?: string;
    androidVersion?: string;
    wifiConnected?: boolean;
    wifiSsid?: string;
    batteryLevel?: number;
  };
}
