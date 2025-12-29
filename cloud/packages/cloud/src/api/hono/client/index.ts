/**
 * @fileoverview Barrel export for Hono client APIs.
 * These APIs are used by the mobile app and glasses client.
 * Mounted at: /api/client/*
 */

export { default as calendarApi } from "./calendar.api";
export { default as clientAppsApi } from "./client.apps.api";
export { default as deviceStateApi } from "./device-state.api";
export { default as feedbackApi } from "./feedback.api";
export { default as livekitApi } from "./livekit.api";
export { default as locationApi } from "./location.api";
export { default as minVersionApi } from "./min-version.api";
export { default as notificationsApi } from "./notifications.api";
export { default as userSettingsApi } from "./user-settings.api";
