/**
 * @fileoverview MetricsService — lightweight singleton for tracking cloud performance metrics.
 *
 * Tracks:
 * - Event loop lag (the single best indicator of server overload)
 * - Throughput counters (UDP packets, WS messages, HTTP requests)
 * - Connection gauges (user sessions, mini app sessions)
 * - Memory usage
 *
 * Exposes metrics in two formats:
 * - Prometheus text exposition format (for Porter /metrics scraping and dashboard)
 * - JSON (for /health endpoint and programmatic access)
 *
 * No external dependencies — just counters, gauges, and text output.
 */

import { logger as rootLogger } from "../logging/pino-logger";
import { udpAudioServer } from "../udp/UdpAudioServer";

const logger = rootLogger.child({ service: "MetricsService" });

// How often to sample event loop lag (ms)
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 2000;

// Rolling window size for event loop lag stats
const EVENT_LOOP_LAG_WINDOW_SIZE = 150; // 150 samples × 2s = ~5 minutes of history

/**
 * MetricsService — singleton that owns all cloud performance metrics.
 *
 * Design decisions:
 * - No Prometheus client library — the text format is trivial to generate
 * - Counters are monotonically increasing (reset on process restart, which is fine for Prometheus)
 * - Gauges are current values, updated on read or via set()
 * - Event loop lag is measured by scheduling setTimeout(0) and measuring actual delay
 * - UDP stats are pulled lazily from UdpAudioServer.getStats() rather than coupling via increment calls
 */
export class MetricsService {
  // ===== Gauges (current values) =====
  private _userSessions = 0;
  private _miniappSessions = 0;

  // ===== Counters (monotonically increasing) =====
  private _wsClientMessagesIn = 0;
  private _wsClientMessagesOut = 0;
  private _wsMiniappMessagesIn = 0;
  private _wsMiniappMessagesOut = 0;
  private _httpRequests2xx = 0;
  private _httpRequests3xx = 0;
  private _httpRequests4xx = 0;
  private _httpRequests5xx = 0;

  // ===== Event loop lag =====
  private _eventLoopLagCurrent = 0;
  private _eventLoopLagSamples: number[] = [];
  private _eventLoopSampleTimer: NodeJS.Timeout | null = null;

  // ===== Boot time =====
  private _startedAt: number = Date.now();

  // ===== State =====
  private _running = false;

  // ===== Counter methods =====

  incrementClientMessagesIn(amount = 1): void {
    this._wsClientMessagesIn += amount;
  }

  incrementClientMessagesOut(amount = 1): void {
    this._wsClientMessagesOut += amount;
  }

  incrementMiniappMessagesIn(amount = 1): void {
    this._wsMiniappMessagesIn += amount;
  }

  incrementMiniappMessagesOut(amount = 1): void {
    this._wsMiniappMessagesOut += amount;
  }

  incrementHttpRequests(statusCode: number): void {
    if (statusCode >= 200 && statusCode < 300) {
      this._httpRequests2xx++;
    } else if (statusCode >= 300 && statusCode < 400) {
      this._httpRequests3xx++;
    } else if (statusCode >= 400 && statusCode < 500) {
      this._httpRequests4xx++;
    } else if (statusCode >= 500) {
      this._httpRequests5xx++;
    }
  }

  // ===== Gauge methods =====

  setUserSessions(count: number): void {
    this._userSessions = count;
  }

  setMiniappSessions(count: number): void {
    this._miniappSessions = count;
  }

  // ===== Event loop lag =====

  get eventLoopLagMs(): number {
    return this._eventLoopLagCurrent;
  }

  get eventLoopLagAvgMs(): number {
    if (this._eventLoopLagSamples.length === 0) return 0;
    const sum = this._eventLoopLagSamples.reduce((a, b) => a + b, 0);
    return sum / this._eventLoopLagSamples.length;
  }

  get eventLoopLagP99Ms(): number {
    if (this._eventLoopLagSamples.length === 0) return 0;
    const sorted = [...this._eventLoopLagSamples].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.99);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Sample event loop lag once.
   * Schedules a setTimeout(0) and measures how long it actually takes to fire.
   */
  private sampleEventLoopLag(): void {
    const start = performance.now();
    setTimeout(() => {
      const lag = performance.now() - start;
      this._eventLoopLagCurrent = Math.round(lag * 100) / 100; // 2 decimal places

      this._eventLoopLagSamples.push(this._eventLoopLagCurrent);
      if (this._eventLoopLagSamples.length > EVENT_LOOP_LAG_WINDOW_SIZE) {
        this._eventLoopLagSamples.shift();
      }
    }, 0);
  }

  // ===== Lifecycle =====

  start(): void {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();

    // Start event loop lag sampling
    this._eventLoopSampleTimer = setInterval(() => {
      this.sampleEventLoopLag();
    }, EVENT_LOOP_SAMPLE_INTERVAL_MS);

    // Take an initial sample immediately
    this.sampleEventLoopLag();

    logger.info(
      { sampleIntervalMs: EVENT_LOOP_SAMPLE_INTERVAL_MS, windowSize: EVENT_LOOP_LAG_WINDOW_SIZE },
      "MetricsService started",
    );
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._eventLoopSampleTimer) {
      clearInterval(this._eventLoopSampleTimer);
      this._eventLoopSampleTimer = null;
    }

    logger.info("MetricsService stopped");
  }

  // ===== Output: Prometheus text format =====

  /**
   * Generate Prometheus text exposition format.
   * See: https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  toPrometheus(): string {
    const mem = process.memoryUsage();
    const udp = udpAudioServer.getStats();
    const lines: string[] = [];

    // Helper to add a metric
    const gauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    };

    const counter = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    };

    // -- Sessions --
    gauge("mentra_user_sessions", "Current number of connected UserSessions", this._userSessions);
    gauge("mentra_miniapp_sessions", "Current number of mini app WebSocket sessions", this._miniappSessions);

    // -- Event loop --
    gauge("mentra_event_loop_lag_ms", "Event loop lag in milliseconds (current sample)", this._eventLoopLagCurrent);
    gauge("mentra_event_loop_lag_avg_ms", "Event loop lag rolling average in milliseconds", this.eventLoopLagAvgMs);
    gauge("mentra_event_loop_lag_p99_ms", "Event loop lag p99 in milliseconds", this.eventLoopLagP99Ms);

    // -- UDP (pulled from UdpAudioServer) --
    counter("mentra_udp_packets_received_total", "Total UDP audio packets received", udp.received);
    counter("mentra_udp_packets_dropped_total", "Total UDP packets dropped (no session)", udp.dropped);
    counter("mentra_udp_pings_received_total", "Total UDP ping packets received", udp.pings);
    counter("mentra_udp_packets_decrypted_total", "Total UDP packets decrypted", udp.decrypted);
    counter("mentra_udp_decryption_failures_total", "Total UDP decryption failures", udp.decryptionFailures);
    gauge("mentra_udp_registered_sessions", "UDP sessions currently registered", udp.sessions);

    // -- WebSocket messages --
    counter(
      "mentra_ws_client_messages_in_total",
      "Total WebSocket messages received from mobile client",
      this._wsClientMessagesIn,
    );
    counter(
      "mentra_ws_client_messages_out_total",
      "Total WebSocket messages sent to mobile client",
      this._wsClientMessagesOut,
    );
    counter(
      "mentra_ws_miniapp_messages_in_total",
      "Total WebSocket messages received from mini apps",
      this._wsMiniappMessagesIn,
    );
    counter(
      "mentra_ws_miniapp_messages_out_total",
      "Total WebSocket messages sent to mini apps",
      this._wsMiniappMessagesOut,
    );

    // -- HTTP requests --
    lines.push("# HELP mentra_http_requests_total Total HTTP requests by status code group");
    lines.push("# TYPE mentra_http_requests_total counter");
    lines.push(`mentra_http_requests_total{status="2xx"} ${this._httpRequests2xx}`);
    lines.push(`mentra_http_requests_total{status="3xx"} ${this._httpRequests3xx}`);
    lines.push(`mentra_http_requests_total{status="4xx"} ${this._httpRequests4xx}`);
    lines.push(`mentra_http_requests_total{status="5xx"} ${this._httpRequests5xx}`);

    // -- Memory --
    gauge("mentra_heap_used_bytes", "V8 heap used in bytes", mem.heapUsed);
    gauge("mentra_heap_total_bytes", "V8 heap total in bytes", mem.heapTotal);
    gauge("mentra_rss_bytes", "Resident set size in bytes", mem.rss);
    gauge("mentra_external_bytes", "External memory in bytes (C++ objects bound to JS)", mem.external);
    gauge("mentra_array_buffers_bytes", "ArrayBuffers memory in bytes", mem.arrayBuffers);

    // -- Process --
    gauge("mentra_uptime_seconds", "Process uptime in seconds", process.uptime());

    return lines.join("\n") + "\n";
  }

  // ===== Output: JSON (for /health) =====

  toJSON(): object {
    const mem = process.memoryUsage();
    const udp = udpAudioServer.getStats();

    return {
      eventLoop: {
        lagMs: this._eventLoopLagCurrent,
        lagAvgMs: Math.round(this.eventLoopLagAvgMs * 100) / 100,
        lagP99Ms: Math.round(this.eventLoopLagP99Ms * 100) / 100,
        samples: this._eventLoopLagSamples.length,
      },
      sessions: {
        userSessions: this._userSessions,
        miniappSessions: this._miniappSessions,
      },
      throughput: {
        wsClientMessagesIn: this._wsClientMessagesIn,
        wsClientMessagesOut: this._wsClientMessagesOut,
        wsMiniappMessagesIn: this._wsMiniappMessagesIn,
        wsMiniappMessagesOut: this._wsMiniappMessagesOut,
        httpRequests: {
          "2xx": this._httpRequests2xx,
          "3xx": this._httpRequests3xx,
          "4xx": this._httpRequests4xx,
          "5xx": this._httpRequests5xx,
        },
      },
      udp,
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      uptime: process.uptime(),
    };
  }
}

// Singleton
export const metricsService = new MetricsService();
