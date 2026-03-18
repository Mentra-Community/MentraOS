/**
 * permissions-utils.ts
 *
 * Runtime permission validation utilities for the MentraOS SDK.
 *
 * Queries the public permissions API endpoint to check if an app has declared
 * the required permission for a specific feature. If the permission is missing,
 * a warning is logged via the SDK logger (respecting log level settings).
 *
 * Key features:
 * - Single generic `checkPermission()` replaces 7 copy-pasted functions
 * - Accepts an optional pino Logger for SDK-integrated logging
 * - Gracefully handles offline/unreachable endpoints (silent failure)
 * - Non-blocking — allows app execution to continue even if checks fail
 */
import type { Logger } from "pino";
import {
  noMicrophoneWarn,
  locationWarn,
  baackgroundLocationWarn,
  calendarWarn,
  readNotficationWarn,
  postNotficationWarn,
  cameraWarn,
} from "../constants/log-messages/warning";
import type { PackagePermissions, Permission } from "../types/messages/cloud-to-app";

/**
 * Generic permission checker — replaces 7 copy-pasted functions.
 *
 * Fetches the app's declared permissions from the public API and logs a
 * warning if the required permission is missing. The warning flows through
 * the SDK logger so it respects `logLevel` settings.
 *
 * @param cloudServerUrl - Base URL of the MentraOS Cloud server
 * @param packageName - The app's package name
 * @param permissionType - Permission type to check (e.g., "MICROPHONE", "CAMERA")
 * @param warnMessageFn - Function that generates the warning message string
 * @param logger - Optional pino logger instance. If omitted, the check is a silent no-op.
 * @param funcName - Optional function name that triggered the check (for the warning message)
 */
function checkPermission(
  cloudServerUrl: string,
  packageName: string,
  permissionType: string,
  warnMessageFn: (funcName?: string, packageName?: string) => string,
  logger?: Logger,
  funcName?: string,
): void {
  if (!cloudServerUrl || !logger) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      }
      return null;
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasPermission = data.permissions.some((p: Permission) => p.type === permissionType);
        if (!hasPermission) {
          logger.warn(warnMessageFn(funcName, packageName));
        }
      }
    })
    .catch(() => {
      // Silently fail if endpoint is unreachable — don't block execution
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────
//
// Each function takes an optional logger parameter. If no logger is provided,
// the permission check is a silent no-op. As call sites are updated to pass
// the session logger, permission warnings start flowing through the SDK logger
// and respect log level settings.

/** Check if app has microphone permission, warn if missing */
export const microPhoneWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "MICROPHONE", noMicrophoneWarn, logger, funcName);
};

/** Check if app has location permission, warn if missing */
export const locationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "LOCATION", locationWarn, logger, funcName);
};

/** Check if app has background location permission, warn if missing */
export const backgroundLocationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "BACKGROUND_LOCATION", baackgroundLocationWarn, logger, funcName);
};

/** Check if app has calendar permission, warn if missing */
export const calendarWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "CALENDAR", calendarWarn, logger, funcName);
};

/** Check if app has read notifications permission, warn if missing */
export const readNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "READ_NOTIFICATIONS", readNotficationWarn, logger, funcName);
};

/** Check if app has post notifications permission, warn if missing */
export const postNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "POST_NOTIFICATIONS", postNotficationWarn, logger, funcName);
};

/** Check if app has camera permission, warn if missing */
export const cameraWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
): void => {
  checkPermission(cloudServerUrl, packageName, "CAMERA", cameraWarn, logger, funcName);
};
