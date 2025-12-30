/**
 * @fileoverview Hono type definitions for AugmentOS Cloud.
 * Defines context variables available after middleware processing.
 */

import type { Context, Env } from "hono";
import type { UserI } from "../models/user.model";
import type UserSession from "../services/session/UserSession";
import type { Logger } from "pino";

/**
 * Variables available in Hono context after middleware processing.
 * Use c.set("key", value) to set and c.get("key") to retrieve.
 */
export interface AppVariables {
  // Request correlation ID (set by request logging middleware)
  reqId?: string;

  // Client auth (set by clientAuth middleware)
  email?: string;
  user?: UserI;
  userSession?: UserSession;
  logger?: Logger;

  // Console auth (set by authenticateConsole middleware)
  console?: {
    email: string;
  };

  // SDK auth (set by authenticateSDK middleware)
  sdk?: {
    packageName: string;
    apiKey: string;
  };

  // CLI auth (set by authenticateCLI middleware)
  cli?: {
    id: string;
    email: string;
    orgId?: string;
  };
}

/**
 * App environment bindings (for Cloudflare Workers compatibility, if needed).
 */
export interface AppBindings {
  // Add any Cloudflare bindings here if needed in the future
}

/**
 * Complete Hono environment type for the application.
 */
export interface AppEnv extends Env {
  Variables: AppVariables;
  Bindings: AppBindings;
}

/**
 * Typed context for route handlers.
 * Use this instead of the generic Context type for better type safety.
 *
 * @example
 * ```typescript
 * import { AppContext } from "../types/hono";
 *
 * async function myHandler(c: AppContext) {
 *   const email = c.get("email"); // string | undefined
 *   const user = c.get("user");   // UserI | undefined
 *   return c.json({ email });
 * }
 * ```
 */
export type AppContext = Context<AppEnv>;

/**
 * Context with guaranteed email (after clientAuth middleware).
 */
export type AuthenticatedContext = Context<AppEnv> & {
  get(key: "email"): string;
  get(key: "logger"): Logger;
};

/**
 * Context with guaranteed user object (after clientAuth + requireUser middleware).
 */
export type UserContext = AuthenticatedContext & {
  get(key: "user"): UserI;
};

/**
 * Context with guaranteed user session (after clientAuth + requireUserSession middleware).
 */
export type UserSessionContext = AuthenticatedContext & {
  get(key: "userSession"): UserSession;
};

/**
 * Context with console auth (after authenticateConsole middleware).
 */
export type ConsoleContext = Context<AppEnv> & {
  get(key: "console"): { email: string };
  get(key: "logger"): Logger;
};

/**
 * Context with CLI auth (after authenticateCLI middleware).
 */
export type CLIContext = Context<AppEnv> & {
  get(key: "cli"): { id: string; email: string; orgId: string };
  get(key: "logger"): Logger;
};

/**
 * Context with SDK auth (after authenticateSDK middleware).
 */
export type SDKContext = Context<AppEnv> & {
  get(key: "sdk"): { packageName: string; apiKey: string };
  get(key: "logger"): Logger;
};
