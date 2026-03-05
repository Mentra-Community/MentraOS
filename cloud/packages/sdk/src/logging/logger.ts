/**
 * MentraOS SDK Logger
 *
 * Factory-based logger that supports two modes:
 *
 * **Clean mode** (default): Single-line colored output via the clean transport.
 *   MentraOS  ✓ App server running on port 7010
 *   MentraOS  ✗ Invalid API key
 *
 * **Verbose mode**: Full pino-pretty structured output (today's behavior).
 *   Activated via `verbose: true` in config or `MENTRA_VERBOSE=true` env var.
 *
 * The BetterStack transport always runs at debug level when BETTERSTACK_SOURCE_TOKEN
 * is set, regardless of the console transport level. This is intentional — it's
 * an undocumented internal feature for Mentra's own apps.
 *
 * Resolution order for log level:
 *   1. MENTRA_VERBOSE=true → verbose mode, debug level
 *   2. MENTRA_LOG_LEVEL env var → sets level (debug implies verbose)
 *   3. config.verbose: true → verbose mode, debug level
 *   4. config.logLevel → sets level
 *   5. Default → warn level, clean mode
 */

import pino from "pino";
import type { Logger, Level } from "pino";
import { Writable } from "stream";
import { createCleanStream } from "./clean-transport";

// ─── Public Types ────────────────────────────────────────────────────────────

export type MentraLogLevel = "none" | "error" | "warn" | "info" | "debug";

export interface LoggerConfig {
  /**
   * SDK console log level. Default: 'warn'.
   * - 'none':  Suppress all SDK console output
   * - 'error': Only errors
   * - 'warn':  Errors + warnings (default)
   * - 'info':  Errors + warnings + lifecycle events
   * - 'debug': Everything (verbose structured output)
   *
   * Can be overridden with MENTRA_LOG_LEVEL env var.
   */
  logLevel?: MentraLogLevel;

  /**
   * Enable verbose internal logging (full pino-pretty structured output).
   * Useful when debugging SDK issues — Mentra support may ask you to enable this.
   * Can also be enabled with MENTRA_VERBOSE=true env var.
   * Default: false
   */
  verbose?: boolean;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Map our public level names to pino level names. 'none' → pino 'silent'. */
function toPinoLevel(level: MentraLogLevel): string {
  return level === "none" ? "silent" : level;
}

const VALID_LEVELS: MentraLogLevel[] = ["none", "error", "warn", "info", "debug"];

/**
 * Resolve the effective logging configuration from env vars + passed config.
 * Env vars take precedence over programmatic config so that Mentra support
 * can tell a developer "set MENTRA_VERBOSE=true and send us the output"
 * without requiring code changes.
 */
function resolveConfig(config?: LoggerConfig): { pinoLevel: string; verbose: boolean } {
  const envVerbose = process.env.MENTRA_VERBOSE === "true" || process.env.MENTRA_VERBOSE === "1";
  const envLevel = process.env.MENTRA_LOG_LEVEL as MentraLogLevel | undefined;

  // 1. MENTRA_VERBOSE takes highest precedence
  if (envVerbose) {
    return { pinoLevel: "debug", verbose: true };
  }

  // 2. MENTRA_LOG_LEVEL overrides config
  if (envLevel && VALID_LEVELS.includes(envLevel)) {
    const pinoLevel = toPinoLevel(envLevel);
    return { pinoLevel, verbose: envLevel === "debug" };
  }

  // 3. Config verbose
  if (config?.verbose) {
    return { pinoLevel: "debug", verbose: true };
  }

  // 4. Config logLevel
  if (config?.logLevel && VALID_LEVELS.includes(config.logLevel)) {
    const pinoLevel = toPinoLevel(config.logLevel);
    return { pinoLevel, verbose: config.logLevel === "debug" };
  }

  // 5. Default: warn level, clean mode
  return { pinoLevel: "warn", verbose: false };
}

/** A no-op writable stream for when all console output is suppressed. */
function createNoopStream(): Writable {
  return new Writable({
    write(_chunk: unknown, _encoding: string, callback: () => void) {
      callback();
    },
  });
}

/**
 * Attempt to create the pino-pretty transport for verbose mode.
 * Returns null if pino-pretty is not installed (it's an optional dependency).
 */
function tryCreatePrettyTransport(): pino.StreamEntry | null {
  try {
    const prettyTransport = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname,env,module,server",
        messageFormat: "{msg}",
        errorProps: "*",
      },
    });
    return { stream: prettyTransport, level: "debug" } as pino.StreamEntry;
  } catch {
    // pino-pretty not installed — caller should fall back
    return null;
  }
}

/**
 * Attempt to create the BetterStack (@logtail/pino) transport.
 * Returns null if the token is not set or the transport fails to load.
 *
 * The BetterStack transport always runs at debug level regardless of the
 * console transport level. This is intentional for Mentra's internal apps.
 * Third-party devs don't set BETTERSTACK_SOURCE_TOKEN so they never see this.
 */
function tryCreateBetterStackTransport(): pino.StreamEntry | null {
  const token = process.env.BETTERSTACK_SOURCE_TOKEN;
  if (!token) return null;

  const endpoint = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com";

  try {
    const transport = pino.transport({
      target: "@logtail/pino",
      options: {
        sourceToken: token,
        options: { endpoint },
      },
    });
    return { stream: transport, level: "debug" } as pino.StreamEntry;
  } catch {
    // Silently skip — don't pollute the dev terminal with BetterStack setup errors.
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a configured pino Logger instance.
 *
 * This is the primary entry point. Each AppServer creates one root logger
 * via this function and then derives child loggers for sessions and modules.
 *
 * @param config - Optional logging configuration. If omitted, defaults to
 *                 warn-level clean output (env vars can still override).
 * @returns A pino Logger instance with the appropriate transports.
 *
 * @example
 * ```typescript
 * // Default: clean output at warn level
 * const logger = createLogger();
 *
 * // Verbose for debugging
 * const logger = createLogger({ verbose: true });
 *
 * // Quiet — errors only
 * const logger = createLogger({ logLevel: 'error' });
 *
 * // Silent — suppress all console output (BetterStack still receives logs)
 * const logger = createLogger({ logLevel: 'none' });
 * ```
 */
export function createLogger(config?: LoggerConfig): Logger {
  const { pinoLevel, verbose } = resolveConfig(config);

  const NODE_ENV = process.env.NODE_ENV || "development";
  const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local";

  const streams: pino.StreamEntry[] = [];

  // ── Console transport ──────────────────────────────────────────────────
  if (pinoLevel !== "silent") {
    if (verbose) {
      // Verbose mode: try pino-pretty, fall back to JSON on stdout
      const pretty = tryCreatePrettyTransport();
      if (pretty) {
        pretty.level = pinoLevel as Level;
        streams.push(pretty);
      } else {
        // pino-pretty not available — fall back to raw JSON on stdout
        // and emit a one-time notice so the dev knows why output looks different
        process.stderr.write(
          "[MentraOS] pino-pretty not installed — verbose output will be JSON. " +
            "Install it with: bun add -d pino-pretty\n",
        );
        streams.push({ stream: process.stdout, level: pinoLevel as Level });
      }
    } else {
      // Clean mode: single-line colored output
      streams.push({ stream: createCleanStream(), level: pinoLevel as Level });
    }
  }

  // ── BetterStack transport ──────────────────────────────────────────────
  // Always at debug level, independent of the console transport.
  const betterStack = tryCreateBetterStackTransport();
  if (betterStack) {
    streams.push(betterStack);
  }

  // ── Safety net ─────────────────────────────────────────────────────────
  // If no streams were added (console=silent, no BetterStack), add a no-op
  // stream to prevent pino from defaulting to stdout.
  if (streams.length === 0) {
    streams.push({ stream: createNoopStream(), level: "silent" as Level });
  }

  const multistream = pino.multistream(streams);

  // The pino instance level is set to the absolute minimum ('debug') so that
  // individual streams can independently control their own minimum levels.
  // For example: console at 'warn' + BetterStack at 'debug' from the same logger.
  return pino(
    {
      level: "debug",
      base: {
        env: NODE_ENV,
        server: PORTER_APP_NAME,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    multistream,
  );
}

// ─── Default Export (backward compat) ────────────────────────────────────────
//
// Some files (e.g., settings.ts) import the root logger directly:
//   import { logger } from "../../logging/logger";
//
// This default instance preserves the current behavior (verbose, NODE_ENV-based
// level) so those files don't break during incremental migration. Once all
// consumers receive the logger via DI, this can be removed.

export const logger = createLogger({
  logLevel: process.env.NODE_ENV === "production" ? "info" : ("debug" as MentraLogLevel),
  verbose: true,
});

export default logger;
