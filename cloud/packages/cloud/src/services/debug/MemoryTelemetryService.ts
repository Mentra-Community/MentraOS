import os from "os";
import { Logger } from "pino";
// SessionStorage replaced by static registry in UserSession
import { logger as rootLogger } from "../logging/pino-logger";
import UserSession from "../session/UserSession";
const ENABLED = process.env.MEMORY_TELEMETRY_ENABLED === "true" || false;

export interface SessionMemoryStats {
  userId: string;
  startTime: string;
  // Audio
  audio: {
    recentBufferChunks: number;
    recentBufferBytes: number;
    orderedBufferChunks: number;
    orderedBufferBytes: number;
  };
  // Transcription
  transcription: {
    vadBufferChunks: number;
    vadBufferBytes: number;
    transcriptLanguages: number;
    transcriptSegments: number;
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
        this.logger.info(
          { telemetry: "memory", snapshot },
          "Memory telemetry snapshot",
        );
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
      const chunks = (session.audioManager as any).orderedBuffer
        .chunks as Array<{
        data: ArrayBufferLike;
      }>;
      orderedBufferChunks = chunks.length;
      for (const c of chunks)
        orderedBufferBytes += this.estimateBytes(c.data as any);
    }

    // Transcription stats via helper method
    let vadBufferChunks = 0;
    let vadBufferBytes = 0;
    let transcriptLanguages = 0;
    let transcriptSegments = 0;
    if (
      typeof (session.transcriptionManager as any).getMemoryStats === "function"
    ) {
      const t = (session.transcriptionManager as any).getMemoryStats();
      vadBufferChunks = t.vadBufferChunks ?? 0;
      vadBufferBytes = t.vadBufferBytes ?? 0;
      transcriptLanguages = t.transcriptLanguages ?? 0;
      transcriptSegments = t.transcriptSegments ?? 0;
    }

    // Microphone timers
    const micEnabled =
      (session.microphoneManager as any).isEnabled?.() ?? false;
    const keepAliveActive = Boolean(
      (session.microphoneManager as any)["keepAliveTimer"],
    );

    return {
      userId: session.userId,
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
        transcriptLanguages,
        transcriptSegments,
      },
      microphone: {
        enabled: micEnabled,
        keepAliveActive,
      },
      apps: {
        running: session.runningApps.size,
        websockets: session.appWebsockets.size,
      },
    };
  }

  private estimateBytes(data: any): number {
    if (!data) return 0;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data))
      return data.length;
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
