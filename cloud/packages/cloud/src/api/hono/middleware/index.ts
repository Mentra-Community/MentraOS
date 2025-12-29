/**
 * @fileoverview Hono middleware exports.
 * Re-exports all Hono middleware for convenient importing.
 */

// Client auth middleware
export { clientAuth, requireUser, requireUserSession, optionalUserSession } from "./client.middleware";

// Console auth middleware
export { authenticateConsole } from "./console.middleware";

// CLI auth middleware
export { authenticateCLI, transformCLIToConsole } from "./cli.middleware";

// SDK auth middleware
export { authenticateSDK } from "./sdk.middleware";
