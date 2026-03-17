/**
 * Telemetry Transport for MentraOS SDK
 *
 * A pino-compatible Writable stream that intercepts log entries and pushes
 * them into a session-scoped ring buffer for incident debugging.
 *
 * This transport is added to the session logger (not the server logger), so
 * the buffer is automatically scoped to one user's session. Every log line
 * written via session.logger — including all module child loggers (camera,
 * audio, led, etc.) — is captured here with zero effort from app developers.
 *
 * Design notes:
 * - Only captures info+ entries. Debug is too noisy for incident bundles;
 *   BetterStack captures debug separately.
 * - Ring buffer: oldest entries are dropped when full. This is intentional —
 *   the most recent logs before a bug report are the most useful.
 * - The buffer is an external array passed in by reference, so AppSession
 *   owns the lifetime and can clear it on disconnect simply by reassigning.
 * - This transport does NOT forward to BetterStack or console — those run
 *   via the parent appServer.logger streams independently.
 */

import { Writable } from "stream";
import type { TelemetryLogEntry } from "../types/messages/app-to-cloud";

// Pino level numbers → our TelemetryLogEntry level strings
// https://getpino.io/#/docs/api?id=loggerlevel-string-gettersetter
const PINO_LEVEL_MAP: Record<number, TelemetryLogEntry["level"]> = {
  10: "debug", // trace → debug (we filter these out anyway)
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error", // fatal → error
};

// Minimum pino level number to capture. 30 = info.
// Debug (20) and trace (10) are excluded — too noisy for incident bundles.
const MIN_CAPTURE_LEVEL = 30;

/**
 * Creates a pino-compatible Writable stream that pushes log entries into
 * a caller-owned ring buffer.
 *
 * @param buffer     - The array to push entries into. Owned by the caller
 *                     (AppSession). Passed by reference so the caller can
 *                     clear it by splicing or reassigning.
 * @param bufferSize - Maximum number of entries to keep. When the buffer
 *                     exceeds this, the oldest entries are dropped.
 *                     Default: 500.
 * @returns A Node.js Writable stream compatible with pino's multistream.
 *
 * @example
 * ```typescript
 * const telemetryBuffer: TelemetryLogEntry[] = []
 * const stream = createTelemetryStream(telemetryBuffer, 500)
 *
 * const logger = pino(
 *   { level: "debug" },
 *   pino.multistream([
 *     { stream: parentStream, level: "warn" },
 *     { stream: stream,       level: "info" },
 *   ])
 * )
 * ```
 */
export function createTelemetryStream(buffer: TelemetryLogEntry[], bufferSize = 500): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      try {
        const line = chunk.toString().trim();
        if (!line) {
          callback();
          return;
        }

        const obj = JSON.parse(line);

        // Filter out below-info entries
        const pinoLevel: number = obj.level ?? 30;
        if (pinoLevel < MIN_CAPTURE_LEVEL) {
          callback();
          return;
        }

        const level: TelemetryLogEntry["level"] = PINO_LEVEL_MAP[pinoLevel] ?? "info";
        const msg: string = obj.msg ?? "";

        // Skip empty messages — pino internal events or structured-only logs
        if (!msg) {
          callback();
          return;
        }

        // Build the entry. We capture the structured context fields (everything
        // except the pino internals) as `data` so the incident viewer can see
        // userId, module, requestId, etc. alongside the message.
        const { level: _l, msg: _m, time, pid: _pid, hostname: _hostname, ...rest } = obj;
        const entry: TelemetryLogEntry = {
          timestamp: typeof time === "number" ? time : Date.now(),
          level,
          message: msg,
          // Preserve source tagging from pino child logger bindings
          source: obj.service ?? obj.module ?? undefined,
          // Attach remaining structured fields only if there's anything useful
          data: Object.keys(rest).length > 0 ? rest : undefined,
        };

        buffer.push(entry);

        // Trim to keep only the most recent entries
        if (buffer.length > bufferSize) {
          buffer.splice(0, buffer.length - bufferSize);
        }
      } catch {
        // Silently ignore parse errors — a broken telemetry stream should
        // never crash the app or interfere with other log transports.
      }

      callback();
    },
  });
}
