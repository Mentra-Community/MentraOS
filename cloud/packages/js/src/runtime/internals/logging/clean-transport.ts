/**
 * Clean Transport for MentraOS SDK
 *
 * A lightweight pino-compatible writable stream that formats log output as
 * single-line colored messages. This is the default console transport.
 *
 * Output format:
 *   MentraOS  ✓ App server running on port 7010
 *   MentraOS  ⚠ Connection lost, reconnecting (2/3)...
 *   MentraOS  ✗ Invalid API key
 *
 * Color scheme:
 *   - "MentraOS" prefix: dim gray (always present, visually skippable)
 *   - ✓ (info): green — success events
 *   - ⚠ (warn): yellow — warnings, reconnecting, deprecations
 *   - ✗ (error/fatal): red — failures requiring action
 *   - · (debug/trace): dim — internal details (only visible at debug level)
 *   - Message text: default terminal color
 *
 * SDK internal log filtering:
 *   Logs tagged with `_sdk: true` (from managers and internal subsystems) are
 *   only shown in the terminal at warn level and above. This keeps the developer's
 *   terminal clean — their own `session.logger.info(...)` calls always show,
 *   while internal SDK chatter (subscription updates, ping, handler registration)
 *   is hidden unless the developer sets MENTRA_VERBOSE=true.
 *
 *   BetterStack always receives ALL logs regardless of the _sdk tag — the
 *   filtering only applies to the terminal/clean transport.
 *
 * All structured context fields (app, packageName, service, userId, err, etc.)
 * are intentionally hidden — they're only visible in verbose mode or in BetterStack.
 * The `msg` field is the only thing shown to the developer.
 */

import { Writable } from "stream";
import chalk from "chalk";

/**
 * Pino log level numbers mapped to display symbols and colors.
 * See: https://getpino.io/#/docs/api?id=loggerlevel-string-gettersetter
 */
const LEVEL_CONFIG: Record<number, { symbol: string; color: (s: string) => string }> = {
  10: { symbol: "·", color: chalk.dim }, // trace
  20: { symbol: "·", color: chalk.dim }, // debug
  30: { symbol: "✓", color: chalk.green }, // info
  40: { symbol: "⚠", color: chalk.yellow }, // warn
  50: { symbol: "✗", color: chalk.red }, // error
  60: { symbol: "✗", color: chalk.red }, // fatal
};

/** Whether verbose mode is enabled — when true, SDK internal logs are shown in terminal. */
const VERBOSE = process.env.MENTRA_VERBOSE === "true" || process.env.MENTRA_VERBOSE === "1";

/** Pino level number for warn — SDK internal logs below this are hidden from terminal (unless verbose). */
const WARN_LEVEL = 40;

const DEFAULT_LEVEL_CONFIG = { symbol: "·", color: chalk.dim };

const PREFIX = chalk.dim("MentraOS");

/**
 * Creates a writable stream that formats pino JSON log lines as single-line
 * colored terminal output.
 *
 * Pino writes newline-delimited JSON to this stream. Each line is parsed,
 * and only the `level` and `msg` fields are used for formatting. Everything
 * else (structured context, error objects, timestamps) is ignored — those
 * fields still flow to BetterStack via the separate @logtail/pino transport.
 *
 * Output is written to `process.stderr` by convention (keeps stdout clean
 * for program output if someone pipes it).
 *
 * @returns A Node.js Writable stream compatible with pino's multistream.
 */
export function createCleanStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      try {
        const line = chunk.toString().trim();
        if (!line) {
          callback();
          return;
        }

        const obj = JSON.parse(line);
        const level: number = obj.level ?? 30;
        const msg: string = obj.msg ?? "";

        // Skip empty messages — these are pino internal events or structured-only logs
        // that have no human-readable message component.
        if (!msg) {
          callback();
          return;
        }

        // SDK internal log filtering:
        // Logs from managers and internal subsystems are tagged with _sdk: true.
        // In the terminal, only show these at warn level and above.
        // This keeps the developer's terminal clean — their own session.logger.info()
        // calls always show, while SDK plumbing noise is hidden.
        // BetterStack still gets everything (it's a separate transport).
        if (obj._sdk === true && level < WARN_LEVEL && !VERBOSE) {
          callback();
          return;
        }

        const config = LEVEL_CONFIG[level] ?? DEFAULT_LEVEL_CONFIG;
        const symbol = config.color(config.symbol);
        const formatted = `${PREFIX}  ${symbol} ${msg}\n`;

        process.stderr.write(formatted);
      } catch {
        // If JSON parse fails (shouldn't happen with pino), write the raw chunk
        // so the developer still sees something rather than silent swallowing.
        process.stderr.write(chunk);
      }
      callback();
    },
  });
}
