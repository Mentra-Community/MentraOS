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
  incidentLogsApi,
  locationApi,
  minVersionApi,
  notificationsApi,
  photoApi,
  userSettingsApi,
} from "./client";

// SDK APIs (third-party apps)
export { sdkVersionApi, simpleStorageApi, systemAppApi } from "./sdk";

// Public APIs (no auth required)
export { publicPermissionsApi } from "./public";

// Console APIs (developer console)
export { consoleAccountApi, consoleOrgsApi, consoleAppsApi, cliKeysApi, consoleIncidentsApi } from "./console";

// Agent APIs (coding agents)
export { agentIncidentsApi } from "./agent";

// Store APIs (MentraOS Store website)
export { storeAppsApi, storeAuthApi, storeUserApi } from "./store";
