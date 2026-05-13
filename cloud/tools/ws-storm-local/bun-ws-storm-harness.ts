#!/usr/bin/env bun

import WebSocket from "ws";

type ConnKind = "glasses" | "app";

interface ClientRecord {
  id: number;
  kind: ConnKind;
  userId: string;
  packageName?: string;
  ws: WebSocket;
}

interface ServerData {
  id?: number;
  kind?: ConnKind;
  userId?: string;
  packageName?: string;
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

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=", 2);
  args.set(key, value ?? "true");
}

const port = numberArg("port", 8899);
const users = numberArg("users", 56);
const appsPerUser = numberArg("apps-per-user", 1);
const rounds = numberArg("rounds", 1);
const reconnectDelayMs = numberArg("reconnect-delay-ms", 6000);
const postReconnectSubscriptionUpdates = numberArg("subscription-updates", 1);
const closeSyncWorkMs = numberArg("close-sync-ms", 0);
const reconnectSyncWorkMs = numberArg("reconnect-sync-ms", 0);
const subscriptionSyncWorkMs = numberArg("subscription-sync-ms", 0);
const reconnectAsyncWorkMs = numberArg("reconnect-async-ms", 0);
const subscriptionAsyncWorkMs = numberArg("subscription-async-ms", 0);
const logsPerClose = numberArg("logs-per-close", 0);
const logsPerSubscription = numberArg("logs-per-subscription", 0);
const logBytes = numberArg("log-bytes", 256);
const runLabel = args.get("label") ?? "local-bun-ws-storm";
const packages = (args.get("packages")?.split(",").filter(Boolean) ?? DEFAULT_PACKAGES).map((p) =>
  p === "com.mentra.captions" ? "com.mentra.captions.debug" : p,
);

const metrics = {
  serverOpen: 0,
  serverClose: 0,
  serverMessages: 0,
  clientOpen: 0,
  clientClose: 0,
  reconnectOpen: 0,
  subscriptionsSent: 0,
  maxHeartbeatGapMs: 0,
  heartbeatGapsOver1s: 0,
  maxMessageWallMs: 0,
  messageWallTimesOver1s: 0,
  closeBatchSpans: [] as number[],
};

const closeTimes: number[] = [];
const activeClients = new Map<number, ClientRecord>();
let nextClientId = 1;
let lastHeartbeat = performance.now();

const heartbeat = setInterval(() => {
  const now = performance.now();
  const gap = now - lastHeartbeat - 100;
  if (gap > metrics.maxHeartbeatGapMs) metrics.maxHeartbeatGapMs = gap;
  if (gap > 1000) metrics.heartbeatGapsOver1s++;
  lastHeartbeat = now;
}, 100);
heartbeat.unref();

const server = Bun.serve<ServerData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") {
      return new Response("ok");
    }

    const upgraded = server.upgrade(req, {
      data: {},
    });
    return upgraded ? undefined : new Response("upgrade failed", { status: 500 });
  },
  websocket: {
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      metrics.serverOpen++;
    },
    message(ws, raw) {
      void handleMessage(ws, raw);
    },
    close(ws, code, reason) {
      metrics.serverClose++;
      closeTimes.push(performance.now());
      if (closeSyncWorkMs > 0) busyWork(closeSyncWorkMs);
      mimicCloseFanout(ws.data, code, reason);
    },
  },
});

console.log(
  JSON.stringify({
    event: "harness-started",
    runLabel,
    port,
    users,
    appsPerUser,
    rounds,
    reconnectDelayMs,
    packages,
    closeSyncWorkMs,
    reconnectSyncWorkMs,
    subscriptionSyncWorkMs,
    reconnectAsyncWorkMs,
    subscriptionAsyncWorkMs,
    logsPerClose,
    logsPerSubscription,
    logBytes,
  }),
);

await run();

async function run(): Promise<void> {
  const initial = await openPopulation("initial");
  await sleep(500);

  for (let round = 1; round <= rounds; round++) {
    const roundClients = [...activeClients.values()];
    const t0 = performance.now();
    for (const client of roundClients) {
      client.ws.terminate();
    }
    await waitFor(() => metrics.serverClose >= roundClients.length * round, 10_000);
    const t1 = performance.now();

    const closesForRound = closeTimes.slice(-roundClients.length);
    metrics.closeBatchSpans.push(max(closesForRound) - min(closesForRound));

    console.log(
      JSON.stringify({
        event: "storm-round-closed",
        round,
        clientsTerminated: roundClients.length,
        observedCloseMs: Math.round(t1 - t0),
        serverCloseCount: metrics.serverClose,
        closeCallbackSpanMs: Math.round(metrics.closeBatchSpans.at(-1) ?? 0),
      }),
    );

    await sleep(reconnectDelayMs);

    const reconnected = await openPopulation(`round-${round}-reconnect`);
    metrics.reconnectOpen += reconnected.length;

    for (const client of reconnected) {
      if (client.kind !== "app") continue;
      for (let i = 0; i < postReconnectSubscriptionUpdates; i++) {
        client.ws.send(
          JSON.stringify({
            type: "subscription_update",
            packageName: client.packageName,
            subscriptions: ["transcription:en-US", "microphone", "location"],
          }),
        );
        metrics.subscriptionsSent++;
      }
    }

    await sleep(1000);
  }

  for (const client of activeClients.values()) {
    client.ws.close();
  }
  await sleep(250);
  server.stop(true);

  console.log(
    JSON.stringify({
      event: "harness-complete",
      runLabel,
      initialClients: initial.length,
      metrics: {
        ...metrics,
        maxHeartbeatGapMs: Math.round(metrics.maxHeartbeatGapMs),
        maxMessageWallMs: Math.round(metrics.maxMessageWallMs),
        closeBatchSpans: metrics.closeBatchSpans.map((v) => Math.round(v)),
      },
    }),
  );
}

async function handleMessage(ws: any, raw: string | Buffer): Promise<void> {
  const t0 = performance.now();
  metrics.serverMessages++;

  try {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === "init") {
      ws.data.id = message.id;
      ws.data.kind = message.kind;
      ws.data.userId = message.userId;
      ws.data.packageName = message.packageName;
      if (reconnectSyncWorkMs > 0) busyWork(reconnectSyncWorkMs);
      if (reconnectAsyncWorkMs > 0) await sleep(reconnectAsyncWorkMs);
      ws.send(JSON.stringify({ type: "ack", id: message.id, kind: message.kind }));
      return;
    }

    if (message.type === "subscription_update") {
      if (subscriptionSyncWorkMs > 0) busyWork(subscriptionSyncWorkMs);
      if (subscriptionAsyncWorkMs > 0) await sleep(subscriptionAsyncWorkMs);
      mimicSubscriptionFanout(message);
      ws.send(JSON.stringify({ type: "subscription_ack", id: ws.data.id }));
    }
  } finally {
    const wallMs = performance.now() - t0;
    if (wallMs > metrics.maxMessageWallMs) metrics.maxMessageWallMs = wallMs;
    if (wallMs > 1000) metrics.messageWallTimesOver1s++;
  }
}

async function openPopulation(phase: string): Promise<ClientRecord[]> {
  activeClients.clear();
  const records: ClientRecord[] = [];
  const openPromises: Promise<void>[] = [];

  for (let i = 0; i < users; i++) {
    const userId = `storm-user-${i}@local.test`;
    records.push(createClient("glasses", userId));

    for (let appIndex = 0; appIndex < appsPerUser; appIndex++) {
      const packageName = packages[(i + appIndex) % packages.length];
      records.push(createClient("app", userId, packageName));
    }
  }

  for (const record of records) {
    openPromises.push(openClient(record, phase));
  }

  await Promise.all(openPromises);
  return records;
}

function createClient(kind: ConnKind, userId: string, packageName?: string): ClientRecord {
  return {
    id: nextClientId++,
    kind,
    userId,
    packageName,
    ws: new WebSocket(`ws://127.0.0.1:${port}/ws`),
  };
}

function openClient(record: ClientRecord, phase: string): Promise<void> {
  activeClients.set(record.id, record);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`open timeout ${record.id}`)), 5000);
    record.ws.once("open", () => {
      metrics.clientOpen++;
      record.ws.send(
        JSON.stringify({
          type: "init",
          phase,
          id: record.id,
          kind: record.kind,
          userId: record.userId,
          packageName: record.packageName,
        }),
      );
    });
    record.ws.once("message", () => {
      clearTimeout(timeout);
      resolve();
    });
    record.ws.on("close", () => {
      metrics.clientClose++;
      activeClients.delete(record.id);
    });
    record.ws.once("error", reject);
  });
}

function mimicCloseFanout(data: ServerData, code: number, reason: string): void {
  const payload = {
    id: data.id,
    kind: data.kind,
    userId: data.userId,
    packageName: data.packageName,
    code,
    reason,
    stateTransitions: ["running", "transport_down", "grace_period"],
  };

  JSON.stringify(payload);
  emitSyntheticLogs("close", logsPerClose, payload);
  for (let i = 0; i < 25; i++) {
    Math.sqrt((data.id ?? 0) * i + code);
  }
}

function mimicSubscriptionFanout(message: any): void {
  const packageName = message.packageName === "com.mentra.captions" ? "com.mentra.captions.debug" : message.packageName;
  const snapshot = {
    packageName,
    subscriptions: message.subscriptions,
    managers: ["subscription", "transcription", "translation", "microphone", "app-state"],
    installedApps: packages,
  };

  for (let i = 0; i < 50; i++) {
    JSON.stringify(snapshot);
  }
  emitSyntheticLogs("subscription", logsPerSubscription, snapshot);
}

function emitSyntheticLogs(event: string, count: number, payload: Record<string, unknown>): void {
  if (count <= 0) return;
  const padding = "x".repeat(Math.max(0, logBytes));
  for (let i = 0; i < count; i++) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        i,
        ...payload,
        padding,
      }) + "\n",
    );
  }
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
  const raw = args.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

function min(values: number[]): number {
  return values.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
}

function max(values: number[]): number {
  return values.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
}
