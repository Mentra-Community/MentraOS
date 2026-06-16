/**
 * Cloud V2 logger. Pino-based, structured JSON.
 *
 * Two output modes, selected by `LOG_STDOUT_JSON` env var:
 *
 *   LOG_STDOUT_JSON=true   → raw JSON to stdout, picked up by Vector (BetterStack)
 *   (anything else)        → pino-pretty for human-readable dev output
 *
 * Every log line carries pod-level metadata (hostname, env, region, package).
 * Sub-loggers via `.child({ service: ... })` add scope without losing pod fields.
 *
 * Conventions: include a `feature` field for cross-cutting concerns
 * (e.g. `feature: "audio-ingress"`) and a `service` field for the component
 * emitting the log. Both fields are filterable in the future when needed.
 */

import { hostname } from "node:os";
import pino, { type Logger, type LoggerOptions } from "pino";

const NODE_ENV = process.env.NODE_ENV ?? "development";
const REGION = process.env.REGION ?? process.env.DEPLOYMENT_REGION ?? "local";
const LOG_LEVEL = process.env.LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug");
const LOG_STDOUT_JSON = process.env.LOG_STDOUT_JSON === "true";

// pino-pretty types use a CJS export-assignment (`export =`), so the module
// type IS the factory; the runtime `.default` comes from Bun's ESM interop of
// that same assignment and needs a cast to line the two views up.
type PrettyFactory = typeof import("pino-pretty");

const PinoPretty: PrettyFactory | null = LOG_STDOUT_JSON
  ? null
  : ((await import("pino-pretty")) as unknown as { default: PrettyFactory }).default;

function podHostname(): string {
  if (NODE_ENV === "production") {
    return hostname();
  }
  return `local-${hostname()}-${process.pid}`;
}

/**
 * Build a root logger for a specific package.
 *
 * @param packageName e.g. "core", "audio", "proxy". Becomes the `package` field on every log line.
 */
export function createLogger(packageName: string): Logger {
  const base = {
    package: packageName,
    pod: podHostname(),
    env: NODE_ENV,
    region: REGION,
  };

  const options: LoggerOptions = {
    level: LOG_LEVEL,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (LOG_STDOUT_JSON) {
    // Raw JSON to stdout; Vector picks it up from the container's stdout.
    return pino(options);
  }

  // Dev mode: pino-pretty as a direct stream.
  // We avoid `transport: { target: "pino-pretty" }` because that uses Node
  // worker_threads, which doesn't resolve pino-pretty's entry point cleanly
  // under Bun. Passing the pretty stream directly to pino() works on both
  // Bun and Node.
  // Non-null: PinoPretty is only null when LOG_STDOUT_JSON, returned above.
  const prettyStream = PinoPretty!({
    colorize: true,
    translateTime: "HH:MM:ss.l",
    ignore: "pod,env,region",
    singleLine: false,
  });
  return pino(options, prettyStream);
}

export type { Logger };
