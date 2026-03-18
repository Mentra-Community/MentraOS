/**
 * @fileoverview Feedback and incident type definitions.
 * Shared types used by both the feedback service (feature requests)
 * and the incidents API (bug reports).
 */

// ============================================================================
// Incident Types (bug reports via /api/incidents)
// ============================================================================

/**
 * Metadata for screenshot attachments on bug reports.
 * Stored in the incident logs JSON in R2.
 */
export interface AttachmentMetadata {
  filename: string; // Original filename
  storedAs: string; // R2 object key (e.g., incidents/{id}/attachments/{timestamp}-{filename})
  mimeType: string;
  size: number;
  uploadedAt: string; // ISO timestamp
}

/**
 * Phone state snapshot for bug reports.
 * Captures relevant state from all stores at time of bug report.
 */
export interface PhoneStateSnapshot {
  glasses?: Record<string, unknown>;
  core?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  applets?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

/**
 * Response from incident creation (POST /api/incidents).
 */
export interface IncidentResponse {
  success: boolean;
  incidentId: string;
}

// ============================================================================
// Feedback Types (feature requests via /api/client/feedback)
// ============================================================================

/**
 * Response from feedback submission (POST /api/client/feedback).
 */
export interface FeedbackResponse {
  success: boolean;
}

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Structured feedback/bug report data from mobile app.
 * Used by both /api/client/feedback and /api/incidents.
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
