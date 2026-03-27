/**
 * SystemVitalsLogger — logs a structured "vitals" snapshot every 30 seconds.
 * Gives BetterStack continuous time-series data for the four Golden Signals
 * (latency, traffic, errors, saturation) without needing Prometheus.
 *
 * See: cloud/issues/057-cloud-observability/observability-spec.md
 */

import { logger as rootLogger } from "../logging/pino-logger";
import { UserSession } from "../session/UserSession";
import { memoryLeakDetector } from "../debug/MemoryLeakDetector";

const logger = rootLogger.child({ service: "SystemVitalsLogger" });

const VITALS_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Operation timing accumulator.
 * Hot paths call addTiming() to record how much time they consumed.
 * Every 30 seconds, the vitals logger reads and resets these counters.
 */
class OperationTimers {
  private timers: Record<string, number> = {};

  addTiming(category: string, ms: number): void {
    this.timers[category] = (this.timers[category] || 0) + ms;
  }

  getAndReset(): Record<string, number> {
    const snapshot = this.timers;
    this.timers = {};
    return snapshot;
  }
}

export const operationTimers = new OperationTimers();

class SystemVitalsLogger {
  private interval?: NodeJS.Timeout;
  private startedAt: number = Date.now();

  start(): void {
    if (this.interval) return;
    this.startedAt = Date.now();

    this.interval = setInterval(() => {
      this.logVitals();
    }, VITALS_INTERVAL_MS);

    logger.info({ intervalMs: VITALS_INTERVAL_MS }, "SystemVitalsLogger started");
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    logger.info("SystemVitalsLogger stopped");
  }

  private logVitals(): void {
    try {
      const memUsage = process.memoryUsage();
      const sessions = UserSession.getAllSessions();

      let totalAppWebsockets = 0;
      let totalTranscriptionStreams = 0;
      let totalTranslationStreams = 0;

      for (const session of sessions) {
        totalAppWebsockets += session.appWebsockets?.size || 0;
        // Stream counts accessed via as any because TranscriptionManager/TranslationManager
        // don't expose streams.size in their public type. These are internal Maps that track
        // active Soniox/translation streams. If the property names change, this returns 0.
        try {
          totalTranscriptionStreams += (session.transcriptionManager as any)?.streams?.size || 0;
          totalTranslationStreams += (session.translationManager as any)?.streams?.size || 0;
        } catch {
          // Swallow — property access failed, counts stay at 0
        }
      }

      const operationSnapshot = operationTimers.getAndReset();
      const totalOperationMs = Object.values(operationSnapshot).reduce((a, b) => a + b, 0);

      logger.info(
        {
          feature: "system-vitals",

          // Saturation
          heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
          heapTotalMB: Math.round(memUsage.heapTotal / 1048576),
          rssMB: Math.round(memUsage.rss / 1048576),
          externalMB: Math.round(memUsage.external / 1048576),
          arrayBuffersMB: Math.round((memUsage.arrayBuffers || 0) / 1048576),

          // Traffic
          activeSessions: sessions.length,
          activeAppWebsockets: totalAppWebsockets,
          activeTranscriptionStreams: totalTranscriptionStreams,
          activeTranslationStreams: totalTranslationStreams,

          // Leak indicator
          disposedSessionsPendingGC: memoryLeakDetector.getDisposedPendingGCCount(),

          // Uptime
          uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),

          // Operation timing (ms spent in each category over last 30s)
          ...Object.fromEntries(Object.entries(operationSnapshot).map(([k, v]) => [`op_${k}_ms`, Math.round(v)])),
          opTotalMs: Math.round(totalOperationMs),
          opBudgetUsedPct: Math.round((totalOperationMs / VITALS_INTERVAL_MS) * 100),
        },
        "system-vitals",
      );
    } catch (error) {
      logger.error(error, "Failed to log system vitals");
    }
  }
}

export const systemVitalsLogger = new SystemVitalsLogger();
