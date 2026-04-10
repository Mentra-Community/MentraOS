/**
 * SystemVitalsLogger — logs a structured "vitals" snapshot every 30 seconds.
 * Gives BetterStack continuous time-series data for the four Golden Signals
 * (latency, traffic, errors, saturation) without needing Prometheus.
 *
 * Also runs a GC probe every 60 seconds that forces garbage collection,
 * measures the pause duration, and logs the result. This tells us definitively
 * whether GC pauses are contributing to event loop blocking / health check timeouts.
 *
 * Connection churn tracking (added for issue 069): tracks disconnect/reconnect
 * rates and close code distribution per 30s window. This is the key evidence
 * for proving whether disconnects are client-initiated or server-initiated.
 *
 * See: cloud/issues/057-cloud-observability/observability-spec.md
 * See: cloud/issues/061-crash-investigation/spec.md
 * See: cloud/issues/069-ws-disconnect-observability/spike.md
 */

import { heapStats } from "bun:jsc";
import { logger as rootLogger } from "../logging/pino-logger";
import { UserSession } from "../session/UserSession";
import { memoryLeakDetector } from "../debug/MemoryLeakDetector";
import { mongoQueryStats } from "../../connections/mongodb.connection";

const logger = rootLogger.child({ service: "SystemVitalsLogger" });

const VITALS_INTERVAL_MS = 30_000; // 30 seconds
const GC_PROBE_INTERVAL_MS = 60_000; // 60 seconds
const GAP_DETECTOR_INTERVAL_MS = 1_000; // 1 second
const GAP_THRESHOLD_MS = 2_000; // log when interval takes >2x expected (event loop blocked >1s)

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

/**
 * Connection churn tracker.
 * WebSocket handlers call recordDisconnect/recordReconnect on every event.
 * Every 30 seconds, the vitals logger reads and resets these counters.
 * This is the definitive evidence for proving client-side vs server-side disconnects.
 *
 * See: cloud/issues/069-ws-disconnect-observability/spike.md
 */
class ConnectionChurnTracker {
  private disconnects = 0;
  private reconnects = 0;
  private closeCodes: Record<number, number> = {};
  private totalDowntimeMs = 0;
  private downtimeSamples = 0;

  /** Called from handleGlassesClose */
  recordDisconnect(closeCode: number): void {
    this.disconnects++;
    this.closeCodes[closeCode] = (this.closeCodes[closeCode] || 0) + 1;
  }

  /** Called from createOrReconnect */
  recordReconnect(downtimeMs: number | null): void {
    this.reconnects++;
    if (downtimeMs !== null && downtimeMs > 0) {
      this.totalDowntimeMs += downtimeMs;
      this.downtimeSamples++;
    }
  }

  getAndReset(): {
    disconnects: number;
    reconnects: number;
    closeCodes: Record<number, number>;
    avgDowntimeMs: number;
  } {
    const snapshot = {
      disconnects: this.disconnects,
      reconnects: this.reconnects,
      closeCodes: { ...this.closeCodes },
      avgDowntimeMs: this.downtimeSamples > 0 ? Math.round(this.totalDowntimeMs / this.downtimeSamples) : 0,
    };
    this.disconnects = 0;
    this.reconnects = 0;
    this.closeCodes = {};
    this.totalDowntimeMs = 0;
    this.downtimeSamples = 0;
    return snapshot;
  }
}

export const connectionChurnTracker = new ConnectionChurnTracker();

class SystemVitalsLogger {
  private vitalsInterval?: NodeJS.Timeout;
  private gcProbeInterval?: NodeJS.Timeout;
  private gapDetectorInterval?: NodeJS.Timeout;
  private lastGapTick: number = Date.now();
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

    // B1: Event loop gap detector — catches ALL blocking regardless of cause.
    // If the 1s interval takes >2s, the event loop was blocked for the excess.
    this.startGapDetector();

    logger.info(
      { vitalsIntervalMs: VITALS_INTERVAL_MS, gcProbeIntervalMs: GC_PROBE_INTERVAL_MS },
      "SystemVitalsLogger started (vitals + GC probe + gap detector)",
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
    if (this.gapDetectorInterval) {
      clearInterval(this.gapDetectorInterval);
      this.gapDetectorInterval = undefined;
    }
    logger.info("SystemVitalsLogger stopped");
  }

  /**
   * B1: Event loop gap detector.
   * A 1-second setInterval that records Date.now() each tick.
   * If the interval between ticks exceeds 2000ms, something blocked the event loop
   * for the excess duration. This is the definitive signal — it catches GC, MongoDB
   * callback storms, audio processing, Bun runtime stalls, anything.
   */
  private startGapDetector(): void {
    this.lastGapTick = Date.now();
    this.gapDetectorInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastGapTick;
      this.lastGapTick = now;

      if (elapsed > GAP_THRESHOLD_MS) {
        const gapMs = elapsed - GAP_DETECTOR_INTERVAL_MS;
        logger.warn(
          {
            feature: "event-loop-gap",
            gapMs,
            expectedMs: GAP_DETECTOR_INTERVAL_MS,
            actualMs: elapsed,
            rssMB: Math.round(process.memoryUsage().rss / 1048576),
            activeSessions: UserSession.getAllSessions().length,
          },
          `Event loop gap: ${gapMs}ms (expected ${GAP_DETECTOR_INTERVAL_MS}ms, actual ${elapsed}ms)`,
        );
      }
    }, GAP_DETECTOR_INTERVAL_MS);
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
      const mongoStats = mongoQueryStats.getAndReset();

      let totalAppWebsockets = 0;
      let totalTranscriptionStreams = 0;
      let totalTranslationStreams = 0;
      let glassesWebSockets = 0;
      let micActiveCount = 0;

      for (const session of sessions) {
        totalAppWebsockets += session.appWebsockets?.size || 0;

        // Count glasses WebSocket connections (sessions with an active glasses WS)
        // UserSession stores the glasses connection as `websocket` (type IWebSocket)
        try {
          if (session.websocket) {
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

          // B2: MongoDB cumulative blocking (how much event loop time MongoDB consumed)
          mongoQueryCount: mongoStats.count,
          mongoTotalBlockingMs: Math.round(mongoStats.totalMs),
          mongoMaxQueryMs: Math.round(mongoStats.maxMs * 10) / 10,

          // Leak indicator
          disposedSessionsPendingGC: memoryLeakDetector.getDisposedPendingGCCount(),

          // Heap object breakdown — shows WHAT is in the heap, not just how much.
          // Before this, we only had heapUsedMB (a single number). Now we see
          // the count of every object type: Array, Object, Function, string, Map, etc.
          // If Arrays triple in an hour but everything else is flat, we know to
          // grep for unbounded arrays. This replaces guessing with measuring.
          // ~1ms cost, zero memory overhead. See: bun.com/blog/debugging-memory-leaks
          ...(() => {
            try {
              const stats = heapStats();
              // Top 15 types by count — captures dominant types without bloating logs
              const sorted = Object.entries(stats.objectTypeCounts as Record<string, number>)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15);
              return {
                heapObjectCount: stats.objectCount,
                heapProtectedCount: stats.protectedObjectCount,
                heapTopTypes: JSON.stringify(Object.fromEntries(sorted)),
              };
            } catch (err) {
              logger.error(err, "Failed to collect heapStats from bun:jsc");
              return {};
            }
          })(),

          // Connection churn — the key evidence for client-side vs server-side disconnects.
          // If disconnects >> reconnects, sessions are being disposed (not surviving grace period).
          // Close code distribution tells us WHO is killing the connection:
          //   1006 = abnormal (client went dark / network loss — CLIENT-SIDE)
          //   1001 = going away (server shutting down — SERVER-SIDE)
          //   1000 = normal close (clean disconnect — EITHER SIDE)
          ...(() => {
            const churn = connectionChurnTracker.getAndReset();
            return {
              wsDisconnects: churn.disconnects,
              wsReconnects: churn.reconnects,
              wsAvgDowntimeMs: churn.avgDowntimeMs,
              wsCloseCodeDist: Object.keys(churn.closeCodes).length > 0 ? JSON.stringify(churn.closeCodes) : undefined,
            };
          })(),

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
