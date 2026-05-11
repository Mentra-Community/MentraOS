#!/usr/bin/env bun

import crypto from "node:crypto";

type AnyFn = (...args: any[]) => any;

interface HarnessArgs {
  users: number;
  appsPerUser: number;
  rounds: number;
  reconnectDelayMs: number;
  roundPauseMs: number;
  subscriptionUpdates: number;
  userDbAsyncMs: number;
  userDbSyncMs: number;
  appDbAsyncMs: number;
  appDbSyncMs: number;
  transcriptionAsyncMs: number;
  transcriptionSyncMs: number;
  translationAsyncMs: number;
  translationSyncMs: number;
  ensureAsyncMs: number;
  ensureSyncMs: number;
  useMessageHandler: boolean;
  connectMode: "reconnect" | "init";
  sdkVersion: string | null;
  label: string;
  packages: string[];
}

interface OperationStats {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
}

interface AppRef {
  userIndex: number;
  packageName: string;
  session: any;
  appSession: any;
  ws: FakeBunWebSocket;
}

const DEFAULT_PACKAGES = [
  "com.mentra.captions.debug",
  "com.mentra.ai",
  "cloud.augmentos.notify",
  "com.mentra.merge",
  "com.mentra.notes",
  "com.mentra.translation",
  "com.mentra.dash",
  "com.mentra.link",
];

const rawArgs = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=", 2);
  rawArgs.set(key, value ?? "true");
}

const args: HarnessArgs = {
  users: numberArg("users", 56),
  appsPerUser: numberArg("apps-per-user", 1),
  rounds: numberArg("rounds", 5),
  reconnectDelayMs: numberArg("reconnect-delay-ms", 1000),
  roundPauseMs: numberArg("round-pause-ms", 250),
  subscriptionUpdates: numberArg("subscription-updates", 1),
  userDbAsyncMs: numberArg("user-db-async-ms", 0),
  userDbSyncMs: numberArg("user-db-sync-ms", 0),
  appDbAsyncMs: numberArg("app-db-async-ms", 0),
  appDbSyncMs: numberArg("app-db-sync-ms", 0),
  transcriptionAsyncMs: numberArg("transcription-async-ms", 0),
  transcriptionSyncMs: numberArg("transcription-sync-ms", 0),
  translationAsyncMs: numberArg("translation-async-ms", 0),
  translationSyncMs: numberArg("translation-sync-ms", 0),
  ensureAsyncMs: numberArg("ensure-async-ms", 0),
  ensureSyncMs: numberArg("ensure-sync-ms", 0),
  useMessageHandler: boolArg("message-handler", false),
  connectMode: enumArg("connect-mode", "reconnect", ["reconnect", "init"]),
  sdkVersion: nullableStringArg("sdk-version", "3.0.0"),
  label: rawArgs.get("label") ?? "mentra-path-storm",
  packages: (rawArgs.get("packages")?.split(",").filter(Boolean) ?? DEFAULT_PACKAGES).map((packageName) =>
    packageName === "com.mentra.captions" ? "com.mentra.captions.debug" : packageName,
  ),
};

process.env.NODE_ENV ??= "test";
process.env.CLOUD_PUBLIC_HOST_NAME ??= "localhost";
process.env.CLOUD_LOCAL_HOST_NAME ??= "localhost";
process.env.AUGMENTOS_AUTH_JWT_SECRET ??= "local-harness-secret";

const operationStats = new Map<string, OperationStats>();
const metrics = {
  maxHeartbeatGapMs: 0,
  heartbeatGapsOver1s: 0,
  socketsCreated: 0,
  socketSends: 0,
  socketBytesSent: 0,
};

const { default: AppModel } = await import("../../packages/cloud/src/models/app.model");
patchAppModel(AppModel);
const { default: AppManager } = await import("../../packages/cloud/src/services/session/AppManager");
const { default: SubscriptionManager } = await import("../../packages/cloud/src/services/session/SubscriptionManager");
const { handleAppMessage } = await import("../../packages/cloud/src/services/session/handlers/app-message-handler");
const { appCache } = await import("../../packages/cloud/src/services/core/app-cache.service");
const { User } = await import("../../packages/cloud/src/models/user.model");
const { WebSocketReadyState } = await import("../../packages/cloud/src/services/websocket/types");

const silentLogger = makeSilentLogger();
let lastHeartbeat = performance.now();

const heartbeat = setInterval(() => {
  const now = performance.now();
  const gap = now - lastHeartbeat - 100;
  if (gap > metrics.maxHeartbeatGapMs) metrics.maxHeartbeatGapMs = gap;
  if (gap > 1000) metrics.heartbeatGapsOver1s++;
  lastHeartbeat = now;
}, 100);
heartbeat.unref();

patchExternalServices();

console.log(
  JSON.stringify({
    event: "mentra-harness-started",
    ...args,
  }),
);

const appRefs = await timed("setup", () => setupSessions());

for (let round = 1; round <= args.rounds; round++) {
  const startCloseCount = getStat("close").count;
  const startReconnectCount = getStat("reconnect").count;
  const startSubscriptionCount = getStat("subscription").count;

  await timed("round", async () => {
    await Promise.all(
      appRefs.map((ref) =>
        timed("close", () => ref.session.appManager.handleAppConnectionClosed(ref.packageName, 1006, "local storm")),
      ),
    );

    await sleep(args.reconnectDelayMs);

    await Promise.all(
      appRefs.map(async (ref) => {
        const ws = new FakeBunWebSocket(`${ref.session.userId}:${ref.packageName}:r${round}`);
        ref.ws = ws;
        await timed("reconnect", () => reconnectApp(ref, ws));
      }),
    );

    for (let i = 0; i < args.subscriptionUpdates; i++) {
      await Promise.all(
        appRefs.map((ref) =>
          timed("subscription", () => applySubscriptionUpdate(ref)),
        ),
      );
    }
  });

  console.log(
    JSON.stringify({
      event: "round-complete",
      round,
      closeOps: getStat("close").count - startCloseCount,
      reconnectOps: getStat("reconnect").count - startReconnectCount,
      subscriptionOps: getStat("subscription").count - startSubscriptionCount,
      maxHeartbeatGapMs: Math.round(metrics.maxHeartbeatGapMs),
      heartbeatGapsOver1s: metrics.heartbeatGapsOver1s,
      stats: snapshotStats(["round", "close", "reconnect", "subscription"]),
    }),
  );

  await sleep(args.roundPauseMs);
}

for (const ref of appRefs) {
  ref.session.appManager.removeAppSession(ref.packageName);
}
clearInterval(heartbeat);

console.log(
  JSON.stringify({
    event: "mentra-harness-complete",
    label: args.label,
    appConnections: appRefs.length,
    metrics: {
      ...metrics,
      maxHeartbeatGapMs: Math.round(metrics.maxHeartbeatGapMs),
    },
    stats: snapshotStats([...operationStats.keys()].sort()),
  }),
);

  process.exit(0);

async function reconnectApp(ref: AppRef, ws: FakeBunWebSocket): Promise<void> {
  if (args.connectMode === "init") {
    await ref.session.appManager.handleAppInit(ws as any, {
      type: "tpa_connection_init",
      packageName: ref.packageName,
      apiKey: "local-api-key",
      sdkVersion: args.sdkVersion ?? undefined,
    });
    return;
  }

  await ref.session.appManager.handleReconnect(
    ws as any,
    {
      sessionId: ref.appSession.sessionId,
      sdkVersion: args.sdkVersion ?? undefined,
    },
    ref.packageName,
  );
}

async function setupSessions(): Promise<AppRef[]> {
  const refs: AppRef[] = [];

  for (let userIndex = 0; userIndex < args.users; userIndex++) {
    const session = createFakeUserSession(userIndex);

    for (let appIndex = 0; appIndex < args.appsPerUser; appIndex++) {
      const packageName = args.packages[(userIndex + appIndex) % args.packages.length];
      session.installedApps.set(packageName, fakeApp(packageName));

      const appSession = session.appManager.getOrCreateAppSession(packageName);
      if (args.sdkVersion) {
        appSession.setSdkVersion(args.sdkVersion);
      }
      appSession.startConnecting();

      const ws = new FakeBunWebSocket(`${session.userId}:${packageName}:initial`);
      appSession.handleConnect(ws);

      refs.push({
        userIndex,
        packageName,
        session,
        appSession,
        ws,
      });
    }
  }

  await Promise.all(
    refs.map((ref) =>
      timed("initialSubscription", () => applySubscriptionUpdate(ref)),
    ),
  );

  return refs;
}

async function applySubscriptionUpdate(ref: AppRef): Promise<void> {
  const message = {
    type: "subscription_update",
    packageName: ref.packageName,
    subscriptions: defaultSubscriptions(ref.packageName),
    timestamp: new Date(),
  };

  if (args.useMessageHandler) {
    await handleAppMessage(ref.ws as any, ref.session, message as any);
    return;
  }

  await ref.session.subscriptionManager.updateSubscriptions(ref.packageName, message.subscriptions);
}

function createFakeUserSession(userIndex: number): any {
  const userId = `storm-user-${userIndex}@local.test`;
  const session: any = {
    userId,
    sessionId: `local-session-${userIndex}`,
    logger: silentLogger.child({ userId }),
    installedApps: new Map(),
    websocket: new FakeBunWebSocket(`${userId}:glasses`),
    userSettingsManager: {
      buildMentraosSettings: () => [],
    },
    deviceManager: {
      sendFullStateSnapshot: (ws: FakeBunWebSocket) => {
        ws.send(JSON.stringify({ type: "full_state_snapshot", localHarness: true }));
      },
    },
    managedStreamingExtension: {
      clearLastSentStatus: () => {},
      getUserStreamState: () => null,
    },
    unmanagedStreamingExtension: {
      getActiveStreamInfo: () => null,
    },
    displayManager: {
      handleAppStop: () => {},
    },
    locationManager: {
      handleSubscriptionUpdate: () => {},
      handleUnsubscribe: () => {},
    },
    calendarManager: {
      handleSubscriptionUpdate: () => {},
      handleUnsubscribe: () => {},
    },
    microphoneManager: {
      handleSubscriptionChange: () => {},
    },
    transcriptionManager: makeTimedManager("transcription", args.transcriptionSyncMs, args.transcriptionAsyncMs),
    translationManager: makeTimedManager("translation", args.translationSyncMs, args.translationAsyncMs),
    getCapabilities: () => ({ model: "local-harness" }),
    snapshotForClient: async () => ({ userId, localHarness: true }),
  };

  session.appManager = new AppManager(session);
  session.subscriptionManager = new SubscriptionManager(session);
  return session;
}

function makeTimedManager(name: string, syncMs: number, asyncMs: number): any {
  return {
    updateSubscriptions: (subscriptions: string[]) =>
      timed(`${name}.updateSubscriptions`, async () => {
        if (syncMs > 0) busyWork(syncMs);
        if (asyncMs > 0) await sleep(asyncMs);
        return subscriptions;
      }),
    ensureStreamsExist: () =>
      timed(`${name}.ensureStreamsExist`, async () => {
        if (args.ensureSyncMs > 0) busyWork(args.ensureSyncMs);
        if (args.ensureAsyncMs > 0) await sleep(args.ensureAsyncMs);
      }),
  };
}

function patchExternalServices(): void {
  (appCache as any).getByPackageName = (packageName: string) => fakeApp(packageName);

  (User as any).findOrCreateUser = async (userId: string) =>
    timed("user.findOrCreateUser", async () => {
      if (args.userDbSyncMs > 0) busyWork(args.userDbSyncMs);
      if (args.userDbAsyncMs > 0) await sleep(args.userDbAsyncMs);
      return {
        userId,
        runningApps: [...args.packages],
        getAppSettings: () => [],
        addRunningApp: async (_packageName: string) => {},
      };
    });

  (User as any).findOne = () =>
    delayedQuery(
      "user.findOne",
      {
        installedApps: args.packages.map((packageName) => ({
          packageName,
          installedDate: new Date(),
        })),
      },
      args.userDbSyncMs,
      args.userDbAsyncMs,
    );
}

function patchAppModel(AppModel: any): void {
  AppModel.find = (query: any) => {
    const packageNames = query?.packageName?.$in;
    if (Array.isArray(packageNames)) {
      return delayedQuery(
        "app.find",
        packageNames.map((packageName) => fakeApp(packageName)),
        args.appDbSyncMs,
        args.appDbAsyncMs,
      );
    }
    return delayedQuery(
      "app.find",
      args.packages.map((packageName) => fakeApp(packageName)),
      args.appDbSyncMs,
      args.appDbAsyncMs,
    );
  };
  AppModel.findOne = (query: any) =>
    delayedQuery("app.findOne", fakeApp(query?.packageName ?? "local.app"), args.appDbSyncMs, args.appDbAsyncMs);
}

function resolvedQuery<T>(value: T): Promise<T> & { lean: () => Promise<T>; exec: () => Promise<T> } {
  const promise = Promise.resolve(value) as Promise<T> & { lean: () => Promise<T>; exec: () => Promise<T> };
  promise.lean = () => Promise.resolve(value);
  promise.exec = () => Promise.resolve(value);
  return promise;
}

function delayedQuery<T>(
  statName: string,
  value: T,
  syncMs: number,
  asyncMs: number,
): Promise<T> & { lean: () => Promise<T>; exec: () => Promise<T> } {
  const makePromise = () =>
    timed(statName, async () => {
      if (syncMs > 0) busyWork(syncMs);
      if (asyncMs > 0) await sleep(asyncMs);
      return value;
    });
  const promise = makePromise() as Promise<T> & { lean: () => Promise<T>; exec: () => Promise<T> };
  promise.lean = makePromise;
  promise.exec = makePromise;
  return promise;
}

function fakeApp(packageName: string): Record<string, unknown> {
  return {
    packageName,
    name: packageName,
    publicUrl: "http://localhost",
    logoURL: "",
    appType: "standard",
    hashedApiKey: crypto.createHash("sha256").update("local-api-key").digest("hex"),
    permissions: [{ type: "ALL" }],
    settings: [],
  };
}

function defaultSubscriptions(packageName: string): string[] {
  if (packageName === "com.mentra.captions") {
    packageName = "com.mentra.captions.debug";
  }
  if (packageName.includes("caption") || packageName.includes("translation")) {
    return ["transcription:en-US"];
  }
  return ["transcription:en-US", "location_update", "phone_notification"];
}

class FakeBunWebSocket {
  public readyState = WebSocketReadyState.OPEN;
  public sentMessages = 0;
  public bytesSent = 0;

  constructor(public readonly id: string) {
    metrics.socketsCreated++;
  }

  send(data: string | Buffer | ArrayBuffer | Uint8Array): void {
    this.sentMessages++;
    metrics.socketSends++;
    if (typeof data === "string") {
      this.bytesSent += data.length;
      metrics.socketBytesSent += data.length;
    } else {
      this.bytesSent += data.byteLength;
      metrics.socketBytesSent += data.byteLength;
    }
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = WebSocketReadyState.CLOSED;
  }

  ping(): void {}
}

async function timed<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordStat(name, performance.now() - t0);
  }
}

function recordStat(name: string, ms: number): void {
  let stat = operationStats.get(name);
  if (!stat) {
    stat = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      samples: [],
    };
    operationStats.set(name, stat);
  }

  stat.count++;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  stat.samples.push(ms);
}

function snapshotStats(names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const stat = operationStats.get(name);
    if (!stat) continue;
    const sorted = [...stat.samples].sort((a, b) => a - b);
    out[name] = {
      count: stat.count,
      totalMs: round(stat.totalMs),
      avgMs: round(stat.totalMs / stat.count),
      p50Ms: round(percentile(sorted, 50)),
      p95Ms: round(percentile(sorted, 95)),
      p99Ms: round(percentile(sorted, 99)),
      maxMs: round(stat.maxMs),
    };
  }
  return out;
}

function getStat(name: string): OperationStats {
  let stat = operationStats.get(name);
  if (!stat) {
    stat = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    operationStats.set(name, stat);
  }
  return stat;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function busyWork(ms: number): void {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) {
    x += Math.sqrt(x + 1);
  }
  if (x === Number.MIN_SAFE_INTEGER) console.log(x);
}

function numberArg(name: string, fallback: number): number {
  const raw = rawArgs.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(name: string, fallback: boolean): boolean {
  const raw = rawArgs.get(name);
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function enumArg<T extends string>(name: string, fallback: T, allowed: T[]): T {
  const raw = rawArgs.get(name) as T | undefined;
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function nullableStringArg(name: string, fallback: string | null): string | null {
  const raw = rawArgs.get(name);
  if (!raw) return fallback;
  return raw === "none" || raw === "null" ? null : raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSilentLogger(): Record<string, AnyFn> {
  const logger: Record<string, AnyFn> = {
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  };
  return logger;
}
