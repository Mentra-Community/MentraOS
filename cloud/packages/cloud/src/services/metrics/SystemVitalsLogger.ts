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

import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { heapStats } from "bun:jsc";
import { logger as rootLogger } from "../logging/pino-logger";
import { UserSession } from "../session/UserSession";
import { memoryLeakDetector } from "../debug/MemoryLeakDetector";
import { mongoQueryStats } from "../../connections/mongodb.connection";
import { udpAudioServer } from "../udp/UdpAudioServer";
import { getDeviceStateCounters, resetDeviceStateCounters } from "./device-state-counters";
import { cascadeDiagnostics } from "./cascade-diagnostics";

const logger = rootLogger.child({ service: "SystemVitalsLogger" });

const VITALS_INTERVAL_MS = 30_000; // 30 seconds
const GC_PROBE_INTERVAL_MS = 60_000; // 60 seconds
const GAP_DETECTOR_INTERVAL_MS = 1_000; // 1 second
const GAP_THRESHOLD_MS = 2_000; // log when interval takes >2x expected (event loop blocked >1s)

// Issue 102: finer-grained loop-liveness signal at 500ms interval.
// The existing 1s/2s gap detector misses sub-2s hiccups; in cascade conditions
// the *first* hiccup that kicks off the cascade is often sub-2s. Catching the
// leading edge at 500ms resolution is what tells us the trigger moment.
const HEARTBEAT_INTERVAL_MS = 500;
const HEARTBEAT_GAP_THRESHOLD_MS = 1_000;

// Issue 102: warn when logVitals() itself runs longer than this.
// Rules the "vitals census blocks the loop" hypothesis in or out.
const VITALS_SELF_SLOW_MS = 500;

// Issue 102: warn when a natural V8 GC pause exceeds this.
// Natural minor GCs are typically <10ms; 100ms catches plausibly-relevant
// pauses without flooding.
const NATURAL_GC_THRESHOLD_MS = 100;
const EVENT_LOOP_DELAY_HISTOGRAM_RESOLUTION_MS = 10;

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
  private previousOwnerBytes = new Map<string, number>();
  private previousSessionOwnerBytes = new Map<string, number>();
  private memoryOwnerWarnCooldown = new Map<string, number>();
  // Issue 102: finer-grained heartbeat tick (500ms) and natural-GC observer.
  private heartbeatInterval?: NodeJS.Timeout;
  private lastHeartbeatTick: number = Date.now();
  private gcObserver?: PerformanceObserver;
  private eventLoopDelayHistogram?: ReturnType<typeof monitorEventLoopDelay>;
  // Issue 102: previous UDP stats snapshot for delta calculation per vitals window.
  // Initialized to all-zeros (not null) so the first vitals window after pod
  // start captures the from-boot traffic as its delta instead of hardcoding 0.
  // Otherwise startup-burst traffic in the first 30s is invisible — defeats
  // the point of the instrumentation. Since UdpAudioServer's counters also
  // start at 0, subtracting zeros from the current snapshot yields "packets
  // received since boot," which IS the right value for the first window.
  private prevUdpStats: {
    packetsReceived: number;
    packetsDropped: number;
    pingsReceived: number;
    packetsDecrypted: number;
    decryptionFailures: number;
  } = {
    packetsReceived: 0,
    packetsDropped: 0,
    pingsReceived: 0,
    packetsDecrypted: 0,
    decryptionFailures: 0,
  };

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

    // Issue 102: heartbeat tick at 500ms for finer trigger-moment resolution.
    this.startHeartbeat();

    // Issue 102: observe natural V8 GC pauses (not just our forced gc-probe).
    this.startGcObserver();

    // Issue 105: continuous event-loop delay histogram. This catches isolated
    // blocks that rolling p99 sampling can miss. Use maxMs as the primary
    // cascade signal; local Bun 1.3.13 testing showed p99 may miss one-off
    // stalls while maxMs catches them.
    this.startEventLoopDelayHistogram();

    logger.info(
      {
        vitalsIntervalMs: VITALS_INTERVAL_MS,
        gcProbeIntervalMs: GC_PROBE_INTERVAL_MS,
        eventLoopDelayHistogramResolutionMs: EVENT_LOOP_DELAY_HISTOGRAM_RESOLUTION_MS,
      },
      "SystemVitalsLogger started (vitals + GC probe + gap detector + heartbeat + natural-GC observer + event-loop histogram)",
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
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = undefined;
    }
    if (this.eventLoopDelayHistogram) {
      this.eventLoopDelayHistogram.disable();
      this.eventLoopDelayHistogram = undefined;
    }
    logger.info("SystemVitalsLogger stopped");
  }

  private startEventLoopDelayHistogram(): void {
    try {
      this.eventLoopDelayHistogram = monitorEventLoopDelay({
        resolution: EVENT_LOOP_DELAY_HISTOGRAM_RESOLUTION_MS,
      });
      this.eventLoopDelayHistogram.enable();
      logger.info(
        {
          feature: "event-loop-delay-histogram",
          resolutionMs: EVENT_LOOP_DELAY_HISTOGRAM_RESOLUTION_MS,
        },
        "Event-loop delay histogram started",
      );
    } catch (err) {
      logger.warn(
        {
          feature: "event-loop-delay-histogram-unsupported",
          err,
        },
        "Event-loop delay histogram NOT installed",
      );
    }
  }

  private getEventLoopDelayHistogramSnapshot(): Record<string, number> {
    const histogram = this.eventLoopDelayHistogram;
    if (!histogram) {
      return {};
    }

    try {
      const maxMs = histogram.max / 1_000_000;
      const meanMs = histogram.mean / 1_000_000;
      const p99Ms = histogram.percentile(99) / 1_000_000;
      const snapshot = {
        eventLoopDelayMaxMs: Math.round(maxMs * 10) / 10,
        eventLoopDelayMeanMs: Number.isFinite(meanMs) ? Math.round(meanMs * 10) / 10 : 0,
        eventLoopDelayP99Ms: Math.round(p99Ms * 10) / 10,
      };
      histogram.reset();
      return snapshot;
    } catch (err) {
      logger.warn({ err }, "Failed to read event-loop delay histogram");
      return {};
    }
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
   * Issue 102: 500ms heartbeat tick for finer-grained loop-liveness signal.
   * The existing 1s/2s gap detector misses sub-2s hiccups and (more importantly)
   * the *first* hiccup before a cascade may be sub-2s. Catch the leading edge
   * with 500ms resolution so the trigger moment is identifiable post-incident.
   *
   * Same payload shape as event-loop-gap but with feature="heartbeat-gap" so
   * queries can be filtered separately from the existing gap stream.
   */
  private startHeartbeat(): void {
    this.lastHeartbeatTick = Date.now();
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastHeartbeatTick;
      this.lastHeartbeatTick = now;

      if (elapsed > HEARTBEAT_GAP_THRESHOLD_MS) {
        const gapMs = elapsed - HEARTBEAT_INTERVAL_MS;
        // Issue 102: gapStartedAtMs is the approximate trigger time, not log time.
        // The log fires when the timer callback finally runs after starvation,
        // so without this field investigators would query the wrong window
        // (recovery flush logs instead of trigger logs).
        const gapStartedAtMs = now - elapsed;
        logger.warn(
          {
            feature: "heartbeat-gap",
            gapMs,
            expectedMs: HEARTBEAT_INTERVAL_MS,
            actualMs: elapsed,
            gapStartedAtMs,
            rssMB: Math.round(process.memoryUsage().rss / 1048576),
            activeSessions: UserSession.getAllSessions().length,
          },
          `Heartbeat gap: ${gapMs}ms (started ~${new Date(gapStartedAtMs).toISOString()}, recovered after ${elapsed}ms)`,
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Issue 102: observe natural V8 GC events (not just our forced gc-probe).
   *
   * Gated behind an explicit runtime support check. As of investigation
   * 2026-04-23, Bun's PerformanceObserver.supportedEntryTypes returns
   * ["mark","measure","resource"] — it does NOT support "gc". Installing
   * an observer for "gc" without checking would silently emit nothing,
   * which post-deploy would look like "no natural GC pauses" when it
   * really means "this instrumentation source is broken in this runtime."
   *
   * We log the unsupported state once at startup so that absence of
   * natural-gc data is itself an explicit signal rather than ambiguous
   * silence. If a future Bun release adds gc support, this auto-activates.
   *
   * For real natural-GC visibility on Bun today, a follow-up needs a
   * Bun/JSC-specific mechanism (e.g. periodic bun:jsc.heapStats() snapshots
   * and inferring GC behavior from heap deltas).
   */
  private startGcObserver(): void {
    const supported = (PerformanceObserver as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
    if (!supported.includes("gc")) {
      logger.warn(
        {
          feature: "natural-gc-unsupported",
          supportedEntryTypes: supported,
        },
        `Natural GC observer NOT installed: 'gc' entryType not supported by this runtime`,
      );
      return;
    }
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > NATURAL_GC_THRESHOLD_MS) {
            const memUsage = process.memoryUsage();
            logger.warn(
              {
                feature: "natural-gc",
                durationMs: Math.round(entry.duration * 10) / 10,
                kind: (entry as any).detail?.kind ?? "unknown",
                rssMB: Math.round(memUsage.rss / 1048576),
                heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
              },
              `Natural GC: ${Math.round(entry.duration)}ms`,
            );
          }
        }
      });
      this.gcObserver.observe({ entryTypes: ["gc"] });
      logger.info(
        { thresholdMs: NATURAL_GC_THRESHOLD_MS },
        `Natural GC observer started (logging GCs > ${NATURAL_GC_THRESHOLD_MS}ms)`,
      );
    } catch (err) {
      logger.warn({ err }, "Could not install natural GC observer");
    }
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

  private maybeLogMemoryOwnerGrowth(
    owner: string,
    estimatedBytes: number,
    deltaBytes: number,
    userId: string | undefined,
    sessionDeltaBytes: number | undefined,
  ): void {
    const OWNER_WARN_COOLDOWN_MS = 10 * 60 * 1000;
    const LARGE_OWNER_THRESHOLD_BYTES = 25 * 1024 * 1024;
    const OWNER_GROWTH_THRESHOLD_BYTES = 2 * 1024 * 1024;
    const FAST_GROWTH_THRESHOLD_BYTES = 10 * 1024 * 1024;
    const now = Date.now();
    const lastWarnAt = this.memoryOwnerWarnCooldown.get(owner) ?? 0;

    if (deltaBytes < OWNER_GROWTH_THRESHOLD_BYTES) {
      return;
    }

    if (estimatedBytes < LARGE_OWNER_THRESHOLD_BYTES && deltaBytes < FAST_GROWTH_THRESHOLD_BYTES) {
      return;
    }

    if (now - lastWarnAt < OWNER_WARN_COOLDOWN_MS) {
      return;
    }

    this.memoryOwnerWarnCooldown.set(owner, now);

    logger.warn(
      {
        feature: "memory-owner-growth",
        owner,
        estimatedBytes,
        deltaBytes,
        userId,
        sessionDeltaBytes,
      },
      `Memory owner growth: ${owner} +${Math.round(deltaBytes / 1048576)}MB`,
    );
  }

  private logVitals(): void {
    // Issue 102: self-timing. logVitals iterates all sessions and walks
    // per-session memory census; this is a candidate trigger for the
    // event-loop cascade. Always log the duration so we have a baseline
    // distribution; warn if it ever exceeds VITALS_SELF_SLOW_MS.
    //
    // sessionCountForLog is captured once here and reused in the finally
    // block so the self-timing payload does NOT do a second getAllSessions()
    // call in the measurement path — that would add noise to the very
    // measurement we're trying to take.
    const vitalsT0 = performance.now();
    let sessionCountForLog = 0;
    try {
      const memUsage = process.memoryUsage();
      const sessions = UserSession.getAllSessions();
      sessionCountForLog = sessions.length;
      const mongoStats = mongoQueryStats.getAndReset();
      const cascadeSnapshot = cascadeDiagnostics.getAndReset();
      const eventLoopDelaySnapshot = this.getEventLoopDelayHistogramSnapshot();

      // Issue 102: pod-level UDP counter deltas per 30s vitals window.
      // UdpAudioServer exposes cumulative counters; we compute deltas against
      // the previous snapshot so the vitals row shows per-window traffic.
      // The prev snapshot is initialized to all-zeros (see field init above),
      // so the first window correctly captures from-boot traffic instead of
      // being hardcoded to 0s.
      const udpStats = udpAudioServer.getStatsSnapshot();
      const udpDelta = {
        udpPacketsReceivedDelta: udpStats.packetsReceived - this.prevUdpStats.packetsReceived,
        udpPacketsDroppedDelta: udpStats.packetsDropped - this.prevUdpStats.packetsDropped,
        udpPingsReceivedDelta: udpStats.pingsReceived - this.prevUdpStats.pingsReceived,
        udpPacketsDecryptedDelta: udpStats.packetsDecrypted - this.prevUdpStats.packetsDecrypted,
        udpDecryptionFailuresDelta: udpStats.decryptionFailures - this.prevUdpStats.decryptionFailures,
      };
      this.prevUdpStats = {
        packetsReceived: udpStats.packetsReceived,
        packetsDropped: udpStats.packetsDropped,
        pingsReceived: udpStats.pingsReceived,
        packetsDecrypted: udpStats.packetsDecrypted,
        decryptionFailures: udpStats.decryptionFailures,
      };

      let totalAppWebsockets = 0;
      let totalTranscriptionStreams = 0;
      let totalTranslationStreams = 0;
      let glassesWebSockets = 0;
      let micActiveCount = 0;
      const ownerTotals = new Map<string, { estimatedBytes: number; itemCount: number }>();
      const currentSessionOwnerBytes = new Map<string, number>();
      const ownerLargestDeltaSession = new Map<string, { userId: string; deltaBytes: number }>();
      const topSessionCandidates: Array<{
        userId: string;
        estimatedBytes: number;
        topOwners: Array<{ owner: string; estimatedBytes: number }>;
      }> = [];

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

        try {
          const census = session.getMemoryCensus();
          const sortedOwners = [...census.owners].sort((a, b) => b.estimatedBytes - a.estimatedBytes);
          const sessionOwnerTotals = new Map<string, { estimatedBytes: number; itemCount: number }>();

          topSessionCandidates.push({
            userId: session.userId,
            estimatedBytes: census.estimatedBytes,
            topOwners: sortedOwners.slice(0, 3).map((owner) => ({
              owner: owner.owner,
              estimatedBytes: owner.estimatedBytes,
            })),
          });

          for (const owner of census.owners) {
            const current = ownerTotals.get(owner.owner) ?? { estimatedBytes: 0, itemCount: 0 };
            current.estimatedBytes += owner.estimatedBytes;
            current.itemCount += owner.itemCount;
            ownerTotals.set(owner.owner, current);

            const sessionCurrent = sessionOwnerTotals.get(owner.owner) ?? { estimatedBytes: 0, itemCount: 0 };
            sessionCurrent.estimatedBytes += owner.estimatedBytes;
            sessionCurrent.itemCount += owner.itemCount;
            sessionOwnerTotals.set(owner.owner, sessionCurrent);
          }

          for (const [ownerName, stats] of sessionOwnerTotals.entries()) {
            const sessionOwnerKey = `${session.userId}:${ownerName}`;
            const previousBytes = this.previousSessionOwnerBytes.get(sessionOwnerKey) ?? 0;
            const deltaBytes = stats.estimatedBytes - previousBytes;

            currentSessionOwnerBytes.set(sessionOwnerKey, stats.estimatedBytes);

            if (deltaBytes <= 0) {
              continue;
            }

            const existingLargestDelta = ownerLargestDeltaSession.get(ownerName);
            if (!existingLargestDelta || deltaBytes > existingLargestDelta.deltaBytes) {
              ownerLargestDeltaSession.set(ownerName, {
                userId: session.userId,
                deltaBytes,
              });
            }
          }
        } catch (err) {
          logger.error({ err, userId: session.userId }, "Failed to collect session memory census");
        }
      }

      // Total connection count: glasses WS + app WS + Soniox streams + translation streams
      const totalConnections =
        glassesWebSockets + totalAppWebsockets + totalTranscriptionStreams + totalTranslationStreams;

      const operationSnapshot = operationTimers.getAndReset();
      const totalOperationMs = Object.values(operationSnapshot).reduce((a, b) => a + b, 0);
      const sortedOwners = [...ownerTotals.entries()]
        .map(([owner, stats]) => ({
          owner,
          estimatedBytes: stats.estimatedBytes,
          itemCount: stats.itemCount,
        }))
        .sort((a, b) => b.estimatedBytes - a.estimatedBytes);
      const sortedOwnerDeltas = [...ownerTotals.entries()]
        .map(([owner, stats]) => ({
          owner,
          estimatedBytes: stats.estimatedBytes,
          deltaBytes: stats.estimatedBytes - (this.previousOwnerBytes.get(owner) ?? 0),
          itemCount: stats.itemCount,
        }))
        .filter((owner) => owner.deltaBytes > 0)
        .sort((a, b) => b.deltaBytes - a.deltaBytes);
      const topSessions = topSessionCandidates.sort((a, b) => b.estimatedBytes - a.estimatedBytes).slice(0, 10);

      for (const owner of sortedOwnerDeltas.slice(0, 10)) {
        this.maybeLogMemoryOwnerGrowth(
          owner.owner,
          owner.estimatedBytes,
          owner.deltaBytes,
          ownerLargestDeltaSession.get(owner.owner)?.userId,
          ownerLargestDeltaSession.get(owner.owner)?.deltaBytes,
        );
      }

      this.previousOwnerBytes = new Map(
        Array.from(ownerTotals.entries(), ([owner, stats]) => [owner, stats.estimatedBytes] as const),
      );
      this.previousSessionOwnerBytes = currentSessionOwnerBytes;

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

          // Code ownership census — which managers/structures actually own retained memory.
          // This is the missing layer between heap shape ("Objects are growing")
          // and root cause ("transcription.history.en-US owns the growth").
          memoryEstimatedSessionBytes: sortedOwners.reduce((sum, owner) => sum + owner.estimatedBytes, 0),
          memoryOwnerCount: ownerTotals.size,
          memoryTopOwners: JSON.stringify(sortedOwners.slice(0, 10)),
          memoryTopOwnerDeltas: JSON.stringify(
            sortedOwnerDeltas.slice(0, 10).map((owner) => ({
              owner: owner.owner,
              deltaBytes: owner.deltaBytes,
              estimatedBytes: owner.estimatedBytes,
            })),
          ),
          memoryTopSessions: JSON.stringify(topSessions),

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

          // Device-state storm counters (issue 099). Pod-global, reset per tick.
          ...(() => {
            const ds = getDeviceStateCounters();
            resetDeviceStateCounters();
            return {
              deviceStateUpdatesTotal: ds.total,
              deviceStateUpdatesDeduped: ds.deduped,
              deviceStateUpdatesApplied: ds.applied,
              deviceStateUpdatesRateLimited: ds.rateLimited,
            };
          })(),

          // Uptime
          uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),

          // Operation timing (ms spent in each category over last 30s)
          ...Object.fromEntries(Object.entries(operationSnapshot).map(([k, v]) => [`op_${k}_ms`, Math.round(v)])),
          opTotalMs: Math.round(totalOperationMs),
          opBudgetUsedPct: Math.round((totalOperationMs / VITALS_INTERVAL_MS) * 100),

          // Issue 105 Phase 1.5 diagnostic timers/counters. These are logged
          // as op_* fields for query consistency but excluded from opTotalMs so
          // the long-lived coarse budget signal does not double-count nested
          // phase timings.
          ...Object.fromEntries(
            Object.entries(cascadeSnapshot.timers).map(([k, v]) => [`op_${k}_ms`, Math.round(v)]),
          ),
          ...Object.fromEntries(Object.entries(cascadeSnapshot.counters).map(([k, v]) => [k, Math.round(v)])),

          // Continuous event-loop delay histogram. maxMs is the main signal for
          // isolated sync blocks; p99 is useful only for broader degradation.
          ...eventLoopDelaySnapshot,

          // Issue 102: pod-level UDP load per 30s window. Quantifies the regime
          // where the cascade fires (per the independent spike, dangerous
          // load was ~96 pkt/s pod-wide with ~70 sessions).
          ...udpDelta,
          udpRegisteredSessions: udpStats.registeredSessions,
        },
        "system-vitals",
      );
    } catch (error) {
      logger.error(error, "Failed to log system vitals");
    } finally {
      // Issue 102: self-timing for the vitals callback itself. Reuse the
      // session count captured at the top of try{} — do NOT call
      // getAllSessions() again here, since that would add noise to the
      // very measurement we're trying to take.
      const vitalsDurationMs = performance.now() - vitalsT0;
      const baseLog = {
        feature: "vitals-self-timing",
        durationMs: Math.round(vitalsDurationMs * 10) / 10,
        activeSessions: sessionCountForLog,
      };
      if (vitalsDurationMs > VITALS_SELF_SLOW_MS) {
        logger.warn(baseLog, `⚠️ logVitals slow: ${Math.round(vitalsDurationMs)}ms`);
      } else {
        logger.info(baseLog, `logVitals: ${Math.round(vitalsDurationMs)}ms`);
      }
    }
  }
}

export const systemVitalsLogger = new SystemVitalsLogger();
