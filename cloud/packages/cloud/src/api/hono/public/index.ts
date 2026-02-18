/**
 * @fileoverview Barrel export for Hono public APIs.
 * These APIs are publicly accessible without authentication.
 * Mounted at: /api/public/*
 */

export { default as publicPermissionsApi } from "./permissions.api";
