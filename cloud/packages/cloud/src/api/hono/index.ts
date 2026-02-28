/**
 * @fileoverview Hono API routes index.
 * Exports all Hono route modules for registration in the main app.
 */

// Client APIs (mobile app and glasses client)
export {
  audioConfigApi,
  calendarApi,
  clientAppsApi,
  deviceStateApi,
  feedbackApi,
  livekitApi,
  locationApi,
  minVersionApi,
  notificationsApi,
  userSettingsApi,
} from "./client";

// SDK APIs (third-party apps)
export { sdkVersionApi, simpleStorageApi, systemAppApi } from "./sdk";

// Public APIs (no auth required)
export { publicPermissionsApi } from "./public";

// Console APIs (developer console)
export { consoleAccountApi, consoleOrgsApi, consoleAppsApi, cliKeysApi } from "./console";

// Store APIs (MentraOS Store website)
export { storeAppsApi, storeAuthApi, storeUserApi } from "./store";
