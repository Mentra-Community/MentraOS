/**
 * warning.ts
 *
 * Permission warning messages for the MentraOS SDK.
 *
 * Previously used boxen-bordered ASCII art banners with side-by-side layouts.
 * Now returns plain single-line strings that the clean transport formats with
 * color/prefix.
 *
 * The clean logger renders these as:
 *   MentraOS  ⚠ camera permission required for requestPhoto — enable at https://console.mentra.glass/apps/org.example.myapp/edit
 */

/**
 * Generate a single-line permission warning message.
 *
 * @param permissionName - Human-readable permission name (e.g., "microphone", "camera")
 * @param funcName - Optional function name that triggered the warning
 * @param packageName - Optional package name for the developer portal link
 * @returns A plain string suitable for `logger.warn()`
 */
const createPermissionWarning = (permissionName: string, funcName?: string, packageName?: string): string => {
  const func = funcName ? `${funcName} requires` : "This function requires";
  const url = packageName ? ` — enable at https://console.mentra.glass/apps/${packageName}/edit` : "";
  return `${func} ${permissionName} permission${url}`;
};

export const noMicrophoneWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("microphone", funcName, packageName);

export const locationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("location", funcName, packageName);

export const baackgroundLocationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("background location", funcName, packageName);

export const calendarWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("calendar", funcName, packageName);

export const readNotficationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("read notification", funcName, packageName);

export const postNotficationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("post notification", funcName, packageName);

export const cameraWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("camera", funcName, packageName);
