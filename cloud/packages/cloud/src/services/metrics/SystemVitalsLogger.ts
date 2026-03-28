/**
 * SystemVitalsLogger — logs a structured "vitals" snapshot every 30 seconds.
 * Gives BetterStack continuous time-series data for the four Golden Signals
 * (latency, traffic, errors, saturation) without needing Prometheus.
 *
 * Also runs a GC probe every 60 seconds that forces garbage collection,
 * measures the pause duration, and logs the result. This tells us definitively
 * whether GC pauses are contributing to event loop blocking / health check timeouts.
 *
 * See: cloud/issues/057-cloud-observability/observability-spec.md
 * See: cloud/issues/061-crash-investigation/spec.md
 */

import { logger as rootLogger } from "../logging/pino-logger";
import { UserSession } from "../session/UserSession";
import { memoryLeakDetector } from "../debug/MemoryLeakDetector";

const logger = rootLogger.child({ service: "SystemVitalsLogger" });

const VITALS_INTERVAL_MS = 30_000; // 30 seconds
const GC_PROBE_INTERVAL_MS = 60_000; // 60 seconds

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
  private vitalsInterval?: NodeJS.Timeout;
  private gcProbeInterval?: NodeJS.Timeout;
  private startedAt: number = Date.now();

  start(): void {
    if (this.vitalsInterval) return;
    this.startedAt = Date.now();

    this.vitalsInterval = setInterval(() => {
      this.logVitals();
    }, VITALS_INTERVAL_MS);

    // GC probe runs on a separate timer, offset from vitals
    this.gcProbeInterval = setInterval(() => {
      this.runGcProbe();
    }, GC_PROBE_INTERVAL_MS);

    logger.info(
      { vitalsIntervalMs: VITALS_INTERVAL_MS, gcProbeIntervalMs: GC_PROBE_INTERVAL_MS },
      "SystemVitalsLogger started (vitals + GC probe)",
    );
  }

  stop(): void {
    if (this.vitalsInterval) {
      clearInterval(this.vitalsInterval);
      this.vitalsInterval = undefined;
    }
    if (this.gcProbeInterval) {
      clearInterval(this.gcProbeInterval);
      this.gcProbeInterval = undefined;
    }
    logger.info("SystemVitalsLogger stopped");
  }

  /**
   * Force a garbage collection and measure how long it takes.
   * Bun.gc(true) is synchronous — it blocks the event loop for the duration.
   * If this takes >100ms, GC is a major contributor to event loop blocking.
   * If it takes <10ms, GC is not the crash cause.
   */
  private runGcProbe(): void {
    try {
      const sessions = UserSession.getAllSessions();
      const memBefore = process.memoryUsage();

      const t0 = performance.now();
      Bun.gc(true);
      const gcDurationMs = performance.now() - t0;

      const memAfter = process.memoryUsage();
      const freedBytes = memBefore.heapUsed - memAfter.heapUsed;

      logger.info(
        {
          feature: "gc-probe",
          gcDurationMs: Math.round(gcDurationMs * 10) / 10,
          heapBeforeMB: Math.round(memBefore.heapUsed / 1048576),
          heapAfterMB: Math.round(memAfter.heapUsed / 1048576),
          freedMB: Math.round(freedBytes / 1048576),
          rssMB: Math.round(memAfter.rss / 1048576),
          externalMB: Math.round(memAfter.external / 1048576),
          arrayBuffersMB: Math.round((memAfter.arrayBuffers || 0) / 1048576),
          activeSessions: sessions.length,
        },
        `GC probe: ${gcDurationMs.toFixed(1)}ms, freed ${Math.round(freedBytes / 1048576)}MB`,
      );

      // Warn if GC is getting slow
      if (gcDurationMs > 100) {
        logger.warn(
          {
            feature: "gc-probe",
            gcDurationMs: Math.round(gcDurationMs * 10) / 10,
            rssMB: Math.round(memAfter.rss / 1048576),
            activeSessions: sessions.length,
          },
          `⚠️ GC probe slow: ${gcDurationMs.toFixed(0)}ms — event loop was blocked`,
        );
      }
    } catch (error) {
      logger.error(error, "GC probe failed");
    }
  }

  private logVitals(): void {
    try {
      const memUsage = process.memoryUsage();
      const sessions = UserSession.getAllSessions();

      let totalAppWebsockets = 0;
      let totalTranscriptionStreams = 0;
      let totalTranslationStreams = 0;
      let glassesWebSockets = 0;
      let micActiveCount = 0;

      for (const session of sessions) {
        totalAppWebsockets += session.appWebsockets?.size || 0;

        // Count glasses WebSocket connections (sessions with an active glasses WS)
        try {
          if ((session as any).glassesWs || (session as any).glassesWebSocket) {
            glassesWebSockets++;
          }
        } catch {
          // Swallow
        }

        // Count mic-active sessions
        try {
          if ((session as any).microphoneManager?.isEnabled?.() || (session as any).microphoneManager?.enabled) {
            micActiveCount++;
          }
        } catch {
          // Swallow
        }

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

      // Total connection count: glasses WS + app WS + Soniox streams + translation streams
      const totalConnections =
        glassesWebSockets + totalAppWebsockets + totalTranscriptionStreams + totalTranslationStreams;

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

          // Connection counts (for correlating crashes with total connections, not just sessions)
          glassesWebSockets,
          totalConnections,
          micActiveCount,

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
