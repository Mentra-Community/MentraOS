import os from "os";
import { Logger } from "pino";
// SessionStorage replaced by static registry in UserSession
import { logger as rootLogger } from "../logging/pino-logger";
import { MemoryOwnerStat } from "../metrics/memory-census";
import { getDeviceStateCounters } from "../metrics/device-state-counters";
import UserSession from "../session/UserSession";
const ENABLED = process.env.MEMORY_TELEMETRY_ENABLED === "true" || false;

export interface SessionMemoryStats {
  userId: string;
  sessionId: string;
  startTime: string;
  // Audio
  audio: {
    recentBufferChunks: number;
    recentBufferBytes: number;
    orderedBufferChunks: number;
    orderedBufferBytes: number;
  };
  // Transcription.
  // transcriptLanguages / transcriptSegments were removed in issue 098 when
  // the cloud stopped retaining transcript history. Only VAD buffer stats
  // remain for telemetry.
  transcription: {
    vadBufferChunks: number;
    vadBufferBytes: number;
  };
  // Microphone
  microphone: {
    enabled: boolean;
    keepAliveActive: boolean;
  };
  // General
  apps: {
    running: number;
    websockets: number;
  };
  memory: {
    estimatedBytes: number;
    owners: MemoryOwnerStat[];
  };
}

export interface MemoryTelemetrySnapshot {
  timestamp: string;
  host: string;
  process: {
    pid: number;
    memory: {
      rss: { bytes: number; human: string };
      heapTotal: { bytes: number; human: string };
      heapUsed: { bytes: number; human: string };
      external: { bytes: number; human: string };
      arrayBuffers: { bytes: number; human: string };
    };
    loadavg: number[];
    uptime: number;
  };
  sessions: SessionMemoryStats[];
  memoryCensus: {
    aggregate: {
      estimatedBytes: number;
      topOwners: Array<{ owner: string; estimatedBytes: number; itemCount: number }>;
    };
    topSessions: Array<{
      userId: string;
      sessionId: string;
      estimatedBytes: number;
      topOwners: Array<{ owner: string; estimatedBytes: number }>;
    }>;
  };
  // Device-state storm counters since last reset (issue 099).
  // Counters reset every vitals tick (~30 s), so this is a short-window view.
  deviceState: {
    updatesTotalSinceLastReset: number;
    updatesDedupedSinceLastReset: number;
    updatesAppliedSinceLastReset: number;
    updatesRateLimitedSinceLastReset: number;
  };
}

/**
 * Emits periodic JSON logs of process and per-session memory-related stats.
 */
export class MemoryTelemetryService {
  private readonly logger: Logger;
  private interval?: NodeJS.Timeout;
  private readonly intervalMs: number;

  constructor(
    logger: Logger = rootLogger.child({ service: "MemoryTelemetry" }),
    intervalMs = 1_000 * 60 * 10, // every 10 minutes
  ) {
    this.logger = logger;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (!ENABLED) {
      this.logger.info("Memory telemetry is disabled");
      return;
    }
    if (this.interval) return;
    this.interval = setInterval(() => {
      try {
        const snapshot = this.getCurrentStats();
        this.logger.info({ telemetry: "memory", snapshot }, "Memory telemetry snapshot");
      } catch (error) {
        this.logger.warn({ error }, "Failed to emit memory telemetry snapshot");
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  getCurrentStats(): MemoryTelemetrySnapshot {
    const sessions = UserSession.getAllSessions();
    const sessionStats = sessions.map((s) => this.getSessionStats(s));
    const mem = process.memoryUsage();
    return {
      timestamp: new Date().toISOString(),
      host: os.hostname(),
      process: {
        pid: process.pid,
        memory: {
          rss: { bytes: mem.rss, human: this.formatBytes(mem.rss) },
          heapTotal: {
            bytes: mem.heapTotal,
            human: this.formatBytes(mem.heapTotal),
          },
          heapUsed: {
            bytes: mem.heapUsed,
            human: this.formatBytes(mem.heapUsed),
          },
          external: {
            bytes: mem.external,
            human: this.formatBytes(mem.external),
          },
          arrayBuffers: {
            bytes: mem.arrayBuffers,
            human: this.formatBytes(mem.arrayBuffers),
          },
        },
        loadavg: os.loadavg(),
        uptime: process.uptime(),
      },
      sessions: sessionStats,
      memoryCensus: this.getMemoryCensus(sessionStats),
      deviceState: (() => {
        const ds = getDeviceStateCounters();
        return {
          updatesTotalSinceLastReset: ds.total,
          updatesDedupedSinceLastReset: ds.deduped,
          updatesAppliedSinceLastReset: ds.applied,
          updatesRateLimitedSinceLastReset: ds.rateLimited,
        };
      })(),
    };
  }

  private getSessionStats(session: UserSession): SessionMemoryStats {
    // Audio stats
    let recentBufferBytes = 0;
    const recent = session.audioManager.getRecentAudioBuffer();
    for (const item of recent) {
      recentBufferBytes += this.estimateBytes(item.data as any);
    }

    // Ordered buffer stats (internal, approximate via method if available)
    let orderedBufferChunks = 0;
    let orderedBufferBytes = 0;
    if ((session.audioManager as any).orderedBuffer?.chunks) {
      const chunks = (session.audioManager as any).orderedBuffer.chunks as Array<{
        data: ArrayBufferLike;
      }>;
      orderedBufferChunks = chunks.length;
      for (const c of chunks) orderedBufferBytes += this.estimateBytes(c.data as any);
    }

    // Transcription stats via helper method.
    // Transcript-history counts were removed in issue 098; only VAD buffer
    // telemetry is reported now.
    let vadBufferChunks = 0;
    let vadBufferBytes = 0;
    if (typeof (session.transcriptionManager as any).getMemoryTelemetryStats === "function") {
      const t = (session.transcriptionManager as any).getMemoryTelemetryStats();
      vadBufferChunks = t.vadBufferChunks ?? 0;
      vadBufferBytes = t.vadBufferBytes ?? 0;
    }

    // Microphone timers
    const micEnabled = (session.microphoneManager as any).isEnabled?.() ?? false;
    const keepAliveActive = Boolean((session.microphoneManager as any)["keepAliveTimer"]);

    let census: SessionMemoryStats["memory"] = {
      estimatedBytes: 0,
      owners: [],
    };
    try {
      if (typeof (session as any).getMemoryCensus === "function") {
        census = (session as any).getMemoryCensus();
      }
    } catch (error) {
      this.logger.error(
        {
          error,
          userId: session.userId,
          sessionId: session.sessionId,
        },
        "Failed to collect session memory census",
      );
    }

    return {
      userId: session.userId,
      sessionId: session.sessionId,
      startTime: session.startTime.toISOString(),
      audio: {
        recentBufferChunks: recent.length,
        recentBufferBytes,
        orderedBufferChunks,
        orderedBufferBytes,
      },
      transcription: {
        vadBufferChunks,
        vadBufferBytes,
      },
      microphone: {
        enabled: micEnabled,
        keepAliveActive,
      },
      apps: {
        running: session.runningApps.size,
        websockets: session.appWebsockets.size,
      },
      memory: census,
    };
  }

  private getMemoryCensus(sessionStats: SessionMemoryStats[]): MemoryTelemetrySnapshot["memoryCensus"] {
    const ownerTotals = new Map<string, { estimatedBytes: number; itemCount: number }>();

    for (const session of sessionStats) {
      for (const owner of session.memory.owners) {
        const current = ownerTotals.get(owner.owner) ?? { estimatedBytes: 0, itemCount: 0 };
        current.estimatedBytes += owner.estimatedBytes;
        current.itemCount += owner.itemCount;
        ownerTotals.set(owner.owner, current);
      }
    }

    const topOwners = [...ownerTotals.entries()]
      .map(([owner, stats]) => ({
        owner,
        estimatedBytes: stats.estimatedBytes,
        itemCount: stats.itemCount,
      }))
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
      .slice(0, 10);

    const topSessions = [...sessionStats]
      .map((session) => ({
        userId: session.userId,
        sessionId: session.sessionId,
        estimatedBytes: session.memory.estimatedBytes,
        topOwners: [...session.memory.owners]
          .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
          .slice(0, 3)
          .map((owner) => ({
            owner: owner.owner,
            estimatedBytes: owner.estimatedBytes,
          })),
      }))
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
      .slice(0, 10);

    return {
      aggregate: {
        estimatedBytes: sessionStats.reduce((sum, session) => sum + session.memory.estimatedBytes, 0),
        topOwners,
      },
      topSessions,
    };
  }

  private estimateBytes(data: any): number {
    if (!data) return 0;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.length;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return (data as ArrayBufferView).byteLength;
    // Fallback unknown
    return 0;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}`;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    const digits = idx === 0 ? 0 : val < 10 ? 2 : 1; // tighter formatting
    return `${val.toFixed(digits)} ${units[idx]}`;
  }
}

export const memoryTelemetryService = new MemoryTelemetryService();
