/**
 * permissions-utils.ts
 *
 * This file provides runtime permission validation utilities for the MentraOS SDK.
 *
 * Each function queries the public permissions API endpoint to check if an app
 * has declared the required permission for a specific feature. If the permission
 * is missing, a styled warning message is displayed in the terminal.
 *
 * Key features:
 * - Fetches app permissions from /api/public/permissions/:packageName
 * - Gracefully handles offline/unreachable endpoints (silent failure)
 * - Displays professional bordered warnings when permissions are missing
 * - Non-blocking - allows app execution to continue even if checks fail
 *
 * These functions are called automatically by SDK methods that require specific
 * permissions (e.g., microphone access, location tracking, camera, etc.) to help
 * developers identify missing permission declarations during development.
 */
import {
  noMicrophoneWarn,
  locationWarn,
  baackgroundLocationWarn,
  calendarWarn,
  readNotficationWarn,
  postNotficationWarn,
  cameraWarn,
} from "../constants/log-messages/warning";
import {
  PackagePermissions,
  Permission,
} from "../../src/types/messages/cloud-to-app";
// Check if app has microphone permission, warn if missing
export const microPhoneWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  // console.log(`Fetching permissions from: ${permissionsUrl}`);
  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasMic = data.permissions.some(
          (p: Permission) => p.type === "MICROPHONE",
        );

        if (!hasMic) {
          console.log(noMicrophoneWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      // Silently fail if endpoint is unreachable - don't block execution
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has location permission, warn if missing
export const locationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasLocation = data.permissions.some(
          (p: Permission) => p.type === "LOCATION",
        );

        if (!hasLocation) {
          console.log(locationWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has background location permission, warn if missing
export const backgroundLocationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasBackgroundLocation = data.permissions.some(
          (p: Permission) => p.type === "BACKGROUND_LOCATION",
        );

        if (!hasBackgroundLocation) {
          console.log(baackgroundLocationWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has calendar permission, warn if missing
export const calendarWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasCalendar = data.permissions.some(
          (p: Permission) => p.type === "CALENDAR",
        );

        if (!hasCalendar) {
          console.log(calendarWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has read notifications permission, warn if missing
export const readNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasReadNotifications = data.permissions.some(
          (p: Permission) => p.type === "READ_NOTIFICATIONS",
        );

        if (!hasReadNotifications) {
          console.log(readNotficationWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has post notifications permission, warn if missing
export const postNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasPostNotifications = data.permissions.some(
          (p: Permission) => p.type === "POST_NOTIFICATIONS",
        );

        if (!hasPostNotifications) {
          console.log(postNotficationWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};

// Check if app has camera permission, warn if missing
export const cameraWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
) => {
  if (!cloudServerUrl) return;

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`;

  fetch(permissionsUrl)
    .then(async (res) => {
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        console.warn(
          `Permission API returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions;
      } else {
        const text = await res.text();
        console.warn(`Permission API returned non-JSON response: ${text}`);
        return null;
      }
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasCamera = data.permissions.some(
          (p: Permission) => p.type === "CAMERA",
        );

        if (!hasCamera) {
          console.log(cameraWarn(funcName, packageName));
        }
      }
    })
    .catch((err) => {
      console.debug(
        "Permission check skipped - endpoint unreachable:",
        err.message,
      );
    });
};
