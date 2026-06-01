import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "CascadeDiagnostics" });

const SLOW_APP_PROTOCOL_MS = 100;
const SLOW_APP_CONNECT_MS = 100;
const SLOW_APP_CONNECT_PHASE_MS = 50;
const SLOW_APP_MESSAGE_MS = 100;
const SLOW_SUBSCRIPTION_UPDATE_MS = 100;
const SLOW_SUBSCRIPTION_PHASE_MS = 50;

type NumericSnapshot = Record<string, number>;

export interface WebSocketObservation {
  openedAt: number;
  lastMessageAt?: number;
  lastSendAt?: number;
  lastPingSentAt?: number;
  lastPongReceivedAt?: number;
  sendCount: number;
  sendReturnPositiveCount: number;
  sendReturnZeroCount: number;
  sendReturnNegativeCount: number;
  sendReturnVoidCount: number;
  drainCount: number;
  lastSendReturn?: number;
}

interface SlowLogBase {
  packageName?: string;
  userIdHash?: number;
  durationMs: number;
  phaseTimings?: Record<string, number>;
}

class CascadeDiagnostics {
  private timers: NumericSnapshot = {};
  private counters: NumericSnapshot = {};

  addTimer(name: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.timers[name] = (this.timers[name] ?? 0) + durationMs;
  }

  increment(name: string, amount = 1): void {
    if (!Number.isFinite(amount) || amount === 0) {
      return;
    }
    this.counters[name] = (this.counters[name] ?? 0) + amount;
  }

  getAndReset(): { timers: NumericSnapshot; counters: NumericSnapshot } {
    const snapshot = {
      timers: this.timers,
      counters: this.counters,
    };
    this.timers = {};
    this.counters = {};
    return snapshot;
  }
}

export const cascadeDiagnostics = new CascadeDiagnostics();

export class PhaseTimer {
  private readonly startedAt = performance.now();
  private readonly phaseTimings: Record<string, number> = {};

  get durationMs(): number {
    return performance.now() - this.startedAt;
  }

  get timings(): Record<string, number> {
    return { ...this.phaseTimings };
  }

  get instrumentedPhaseMs(): number {
    return Object.values(this.phaseTimings).reduce((sum, value) => sum + value, 0);
  }

  get unattributedMs(): number {
    return Math.max(0, this.durationMs - this.instrumentedPhaseMs);
  }

  async measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await operation();
    } finally {
      this.addPhase(phase, performance.now() - t0);
    }
  }

  measureSync<T>(phase: string, operation: () => T): T {
    const t0 = performance.now();
    try {
      return operation();
    } finally {
      this.addPhase(phase, performance.now() - t0);
    }
  }

  private addPhase(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.phaseTimings[phase] = (this.phaseTimings[phase] ?? 0) + durationMs;
  }
}

export function createPhaseTimer(): PhaseTimer {
  return new PhaseTimer();
}

export function hashUserId(userId: string | undefined | null): number | undefined {
  if (!userId) {
    return undefined;
  }

  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export function slowPhases(phaseTimings: Record<string, number>, thresholdMs: number): string[] {
  return Object.entries(phaseTimings)
    .filter(([, durationMs]) => durationMs >= thresholdMs)
    .map(([phase]) => phase);
}

export function appMessageTimerName(messageType: string | undefined): string {
  return `appMsg_${messageTypeSuffix(messageType)}`;
}

export function messageTypeSuffix(messageType: string | undefined): string {
  const type = messageType || "unknown";
  const known: Record<string, string> = {
    subscription_update: "subscriptionUpdate",
    display_request: "displayRequest",
    dashboard_content_update: "dashboardContentUpdate",
    dashboard_mode_change: "dashboardModeChange",
    dashboard_system_update: "dashboardSystemUpdate",
    rgb_led_control: "rgbLedControl",
    camera_fov_set: "cameraFovSet",
    stream_request: "streamRequest",
    rtmp_stream_request: "streamRequest",
    stream_stop: "streamStop",
    rtmp_stream_stop: "streamStop",
    stream_status_check: "streamStatusCheck",
    location_poll_request: "locationPollRequest",
    photo_request: "photoRequest",
    audio_play_request: "audioPlayRequest",
    audio_stop_request: "audioStopRequest",
    audio_stream_start: "audioStreamStart",
    audio_stream_end: "audioStreamEnd",
    managed_stream_request: "managedStreamRequest",
    managed_stream_stop: "managedStreamStop",
    request_wifi_setup: "requestWifiSetup",
    ownership_release: "ownershipRelease",
  };

  if (known[type]) {
    return known[type];
  }

  return type
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase())
    .replace(/[^a-zA-Z0-9]/g, "") || "unknown";
}

export function logSlowAppProtocol(
  protocolType: "connection_init" | "reconnect" | "regular_message" | "ping" | "parse",
  data: SlowLogBase,
): void {
  if (data.durationMs < SLOW_APP_PROTOCOL_MS) {
    return;
  }

  logger.warn(
    {
      feature: "slow-app-protocol",
      protocolType,
      packageName: data.packageName,
      userIdHash: data.userIdHash,
      durationMs: roundMs(data.durationMs),
      phaseTimings: data.phaseTimings ? roundPhaseTimings(data.phaseTimings) : undefined,
      instrumentedPhaseMs: data.phaseTimings ? roundMs(sumPhaseTimings(data.phaseTimings)) : undefined,
      unattributedMs: data.phaseTimings ? roundMs(Math.max(0, data.durationMs - sumPhaseTimings(data.phaseTimings))) : undefined,
    },
    `Slow app protocol ${protocolType}: ${Math.round(data.durationMs)}ms`,
  );
}

export function logSlowAppConnect(mode: "connection_init" | "reconnect" | "broadcast_app_state", data: SlowLogBase): void {
  if (data.durationMs < SLOW_APP_CONNECT_MS) {
    return;
  }

  const roundedPhases = data.phaseTimings ? roundPhaseTimings(data.phaseTimings) : undefined;
  logger.warn(
    {
      feature: "slow-app-connect",
      mode,
      packageName: data.packageName,
      userIdHash: data.userIdHash,
      durationMs: roundMs(data.durationMs),
      phaseTimings: roundedPhases,
      slowPhases: roundedPhases ? slowPhases(roundedPhases, SLOW_APP_CONNECT_PHASE_MS) : undefined,
      instrumentedPhaseMs: data.phaseTimings ? roundMs(sumPhaseTimings(data.phaseTimings)) : undefined,
      unattributedMs: data.phaseTimings ? roundMs(Math.max(0, data.durationMs - sumPhaseTimings(data.phaseTimings))) : undefined,
    },
    `Slow app connect ${mode}: ${Math.round(data.durationMs)}ms`,
  );
}

export function logSlowAppMessage(data: SlowLogBase & { messageType: string }): void {
  if (data.durationMs < SLOW_APP_MESSAGE_MS) {
    return;
  }

  logger.warn(
    {
      feature: "slow-app-message",
      messageType: data.messageType,
      packageName: data.packageName,
      userIdHash: data.userIdHash,
      durationMs: roundMs(data.durationMs),
      phaseTimings: data.phaseTimings ? roundPhaseTimings(data.phaseTimings) : undefined,
    },
    `Slow app message ${data.messageType}: ${Math.round(data.durationMs)}ms`,
  );
}

export function logSlowSubscriptionUpdate(data: SlowLogBase & { subscriptionCount: number }): void {
  if (data.durationMs < SLOW_SUBSCRIPTION_UPDATE_MS) {
    return;
  }

  const roundedPhases = data.phaseTimings ? roundPhaseTimings(data.phaseTimings) : undefined;
  logger.warn(
    {
      feature: "slow-subscription-update",
      packageName: data.packageName,
      userIdHash: data.userIdHash,
      subscriptionCount: data.subscriptionCount,
      durationMs: roundMs(data.durationMs),
      phaseTimings: roundedPhases,
      slowPhases: roundedPhases ? slowPhases(roundedPhases, SLOW_SUBSCRIPTION_PHASE_MS) : undefined,
      instrumentedPhaseMs: data.phaseTimings ? roundMs(sumPhaseTimings(data.phaseTimings)) : undefined,
      unattributedMs: data.phaseTimings ? roundMs(Math.max(0, data.durationMs - sumPhaseTimings(data.phaseTimings))) : undefined,
    },
    `Slow subscription update: ${Math.round(data.durationMs)}ms`,
  );
}

export function getOrCreateWsObservation(ws: unknown): WebSocketObservation {
  const data = (ws as { data?: { obs?: WebSocketObservation } }).data;
  if (!data) {
    return {
      openedAt: Date.now(),
      sendCount: 0,
      sendReturnPositiveCount: 0,
      sendReturnZeroCount: 0,
      sendReturnNegativeCount: 0,
      sendReturnVoidCount: 0,
      drainCount: 0,
    };
  }

  if (!data.obs) {
    data.obs = {
      openedAt: Date.now(),
      sendCount: 0,
      sendReturnPositiveCount: 0,
      sendReturnZeroCount: 0,
      sendReturnNegativeCount: 0,
      sendReturnVoidCount: 0,
      drainCount: 0,
    };
  }
  return data.obs;
}

export function markWebSocketOpened(ws: unknown): void {
  const obs = getOrCreateWsObservation(ws);
  obs.openedAt = Date.now();
}

export function markWebSocketMessageReceived(ws: unknown): void {
  getOrCreateWsObservation(ws).lastMessageAt = Date.now();
}

export function markWebSocketPingSent(ws: unknown): void {
  getOrCreateWsObservation(ws).lastPingSentAt = Date.now();
  cascadeDiagnostics.increment("wsPingSent_count");
}

export function markWebSocketPongReceived(ws: unknown): void {
  getOrCreateWsObservation(ws).lastPongReceivedAt = Date.now();
  cascadeDiagnostics.increment("wsPongReceived_count");
}

export function markWebSocketDrain(ws: unknown): void {
  const obs = getOrCreateWsObservation(ws);
  obs.drainCount++;
  cascadeDiagnostics.increment("wsDrain_count");
}

export function recordWebSocketSend(ws: unknown, direction: "app" | "glasses", sendReturn: number | void): void {
  const obs = getOrCreateWsObservation(ws);
  obs.lastSendAt = Date.now();
  obs.sendCount++;

  if (typeof sendReturn === "number") {
    obs.lastSendReturn = sendReturn;
    if (sendReturn > 0) {
      obs.sendReturnPositiveCount++;
      cascadeDiagnostics.increment(`wsSend_${direction}_returnPositive_count`);
    } else if (sendReturn === 0) {
      obs.sendReturnZeroCount++;
      cascadeDiagnostics.increment(`wsSend_${direction}_returnZero_count`);
    } else {
      obs.sendReturnNegativeCount++;
      cascadeDiagnostics.increment(`wsSend_${direction}_returnNegative_count`);
    }
  } else {
    obs.sendReturnVoidCount++;
    cascadeDiagnostics.increment(`wsSend_${direction}_returnVoid_count`);
  }
}

export function buildAppWsCloseTelemetry(ws: unknown, code: number): Record<string, unknown> {
  const data = (ws as {
    data?: {
      userId?: string;
      packageName?: string;
      sdkVersion?: string;
      obs?: WebSocketObservation;
    };
  }).data;
  const obs = data?.obs;
  const now = Date.now();

  cascadeDiagnostics.increment("appWsClose_count");
  if (code === 1006) {
    cascadeDiagnostics.increment("appWsClose_1006_count");
  } else if (code === 1000 || code === 1001) {
    cascadeDiagnostics.increment("appWsClose_clean_count");
  } else {
    cascadeDiagnostics.increment("appWsClose_other_count");
  }

  return {
    feature: "app-ws-close",
    userIdHash: hashUserId(data?.userId),
    packageName: data?.packageName,
    sdkVersion: data?.sdkVersion,
    code,
    inferredCloseSource: inferCloseSource(code, obs),
    openDurationMs: obs?.openedAt ? now - obs.openedAt : undefined,
    lastMessageAgoMs: obs?.lastMessageAt ? now - obs.lastMessageAt : undefined,
    lastSendAgoMs: obs?.lastSendAt ? now - obs.lastSendAt : undefined,
    lastPingSentAgoMs: obs?.lastPingSentAt ? now - obs.lastPingSentAt : undefined,
    lastPongReceivedAgoMs: obs?.lastPongReceivedAt ? now - obs.lastPongReceivedAt : undefined,
    sendCount: obs?.sendCount,
    sendReturnPositiveCount: obs?.sendReturnPositiveCount,
    sendReturnZeroCount: obs?.sendReturnZeroCount,
    sendReturnNegativeCount: obs?.sendReturnNegativeCount,
    sendReturnVoidCount: obs?.sendReturnVoidCount,
    drainCount: obs?.drainCount,
    lastSendReturn: obs?.lastSendReturn,
  };
}

function inferCloseSource(code: number, obs: WebSocketObservation | undefined): string {
  if (code === 1000 || code === 1001) {
    return "clean_close";
  }
  if (code !== 1006) {
    return "close_frame_or_local_close";
  }
  if (!obs) {
    return "unknown_no_close_frame";
  }
  if (obs.lastPingSentAt && !obs.lastPongReceivedAt) {
    return "unknown_no_close_frame_ping_sent_no_pong_recorded";
  }
  return "unknown_no_close_frame";
}

function roundPhaseTimings(phaseTimings: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(phaseTimings).map(([phase, durationMs]) => [phase, roundMs(durationMs)]));
}

function sumPhaseTimings(phaseTimings: Record<string, number>): number {
  return Object.values(phaseTimings).reduce((sum, value) => sum + value, 0);
}
