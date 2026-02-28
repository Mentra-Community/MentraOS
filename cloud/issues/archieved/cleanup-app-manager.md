# Cleanup: AppManager — design, contracts, and migration (Manager-first)

Goal: Hide per-app details behind AppManager so other managers don’t need to know which apps are running or address specific apps. AppSessions are private (only AppManager touches them). Fold SubscriptionManager into AppManager.

This doc is grounded in the current code (startApp/stopApp/handleAppInit/sendMessageToApp/isAppRunning, plus SubscriptionManager.updateSubscriptions) and the SDK subscription model (SubscriptionRequest[] with StreamType and language/location entries).

## TL;DR

- Keep routes and websocket services able to start/stop apps.
- Other managers should never target a specific app. They publish by topic, or respond to a requestId.
- AppManager:
  - Public: publish, respondTo, hasSubscribers, updateSubscriptions (SDK shape), lifecycle (start/stop/init).
  - Private: manages AppSession instances and the aggregate subscription index.
- Deprecate SubscriptionManager: move its logic into AppManager; AppSession owns its own subs; AppManager keeps the aggregate index.
- Move correlation (e.g., audioPlayRequestMapping) out of UserSession and into AppManager.

Naming preferences (full words):

- appSessions: Map<string, AppSession>
- subscriptionMap: Map<ExtendedStreamType, Set<string>>
- requestMap: Map<string, string> // requestId -> packageName

---

## Current surface (selected)

Callers today:

- websocket-glasses.service.ts → startApp/stopApp/startPreviouslyRunningApps
- websocket-app.service.ts → handleAppInit
- managers (Video/Photo/Transcription/Translation) → isAppRunning + sendMessageToApp
- routes (apps/streams/developer) → startApp/stopApp/broadcastAppState/isAppRunning

Example (today):

```ts
// Manager → specific app (today)
await this.userSession.appManager.sendMessageToApp(packageName, message);

// Streams guard (today)
if (session.appManager.isAppRunning(packageName)) {
  // ...
}
```

Pain points:

- Managers know which app to target and whether it’s running.
- Subscription logic is in SubscriptionManager + updates mic/transcription using side paths.
- Correlation for responses is on UserSession (audioPlayRequestMapping).

---

## Target design

- AppSessions are private, created and owned by AppManager.
- Other managers publish by topic or respond to a requestId—no direct app addressing.
- SDK subscription shape remains: SubscriptionRequest[].
- AppManager owns aggregate subscription index for fast fanout; each AppSession owns its own subs.

### AppManager (public facade)

```ts
// App-facing lifecycle for routes and websocket services
startApp(packageName: string): Promise<AppStartResult>;
stopApp(packageName: string, restart?: boolean): Promise<void>;
startPreviouslyRunningApps(): Promise<void>;
// Prefer a thin attach that delegates to AppSession (replacement for handleAppInit)
attachAppConnection(ws: WebSocket, init: AppConnectionInit): Promise<void>;
broadcastAppState(): Promise<AppStateChange | null>;
// Optional: expose for routes only; managers should not call this
isAppRunning(packageName: string): boolean; // consider @deprecated for internal use

// Stream/subscription semantics
updateSubscriptions(packageName: string, subs: SubscriptionRequest[]): Promise<UserI | null>;
hasSubscribers(topic: ExtendedStreamType): boolean; // gate work without knowing apps
publish(topic: ExtendedStreamType, payload: unknown, options?: { exclude?: string[] }): number; // returns count delivered

// Request/response correlation (move from UserSession)
respondTo(requestId: string, message: any): boolean; // true if routed
// Convenience for common response types (e.g., AUDIO_PLAY_RESPONSE)
handleAudioPlayResponse(response: { requestId: string; [k: string]: any }): boolean;

// Targeted send — not recommended, but available for complex managers when needed
sendToPackageName(packageName: string, message: any): Promise<{ sent: boolean; resurrectionTriggered: boolean; error?: string }>;

// Observability/health (used by snapshots)
snapshot(): AppManagerSnapshot; // apps list, subs per app, perf counters

// Cleanup
dispose(): void;
```

Notes:

- No setSubscriptions — we keep SDK’s updateSubscriptions(packageName, SubscriptionRequest[]).
- No appKey — we continue to use packageName (matches current system).
- Other managers should prefer publish(...) or respondTo(...). Targeted send exists for advanced cases.
- UserSession.relayAudioPlayResponseToApp will be deprecated; call userSession.appManager.handleAudioPlayResponse instead.

### AppSession (private)

```ts
// Internal only — not exported outside AppManager
class AppSession {
  constructor(args: { packageName: string; logger: Logger }) {}

  attach(ws: WebSocket, init: AppConnectionInit): void; // sets up heartbeat, message handlers
  dispose(reason?: string): void;

  // Subscriptions owned per-app; SDK shape
  applySubscriptionUpdate(subs: SubscriptionRequest[]): void;
  getSubscriptions(): ExtendedStreamType[];
  isSubscribed(topic: ExtendedStreamType): boolean;

  // Messaging, with backpressure per app
  send(message: any): Promise<void>;
  request(message: any, timeoutMs?: number): Promise<any>; // correlates requestId

  // Minimal info for snapshots/metrics
  info(): AppInfo;
}
```

### Subscriptions (SDK-aligned)

Keep the exact flow from today (now implemented inside AppManager + AppSession):

```ts
// Example SubscriptionRequest from SDK
type SubscriptionRequest =
  | ExtendedStreamType
  | { stream: StreamType.LOCATION_STREAM; rate?: "fast" | "slow" | "off" };

// AppManager.updateSubscriptions(packageName, subs)
// - Normalizes language streams (createTranscriptionStream)
// - Applies reconnect grace window for empty subs
// - Permission filtering (SimplePermissionChecker)
// - Maintains aggregate counters: PCM/transcription/lang
// - Persists location rate to DB
// - Syncs TranscriptionManager/TranslationManager
// - Notifies MicrophoneManager to re-evaluate state
```

Aggregate index (maintained by AppManager):

- topic → Set<packageName>
- Derived counters: pcmSubscriptionCount, transcriptionLikeCount, languageStreamCounts

---

## Replacing current callsites (examples)

### 1) Broadcasts from managers → publish

Today:

```ts
await this.userSession.appManager.sendMessageToApp(packageName, rtmpStatusMsg);
```

After:

```ts
// UnmanagedStreamingExtension
if (this.userSession.appManager.hasSubscribers(StreamType.RTMP_STATUS)) {
  this.userSession.appManager.publish(StreamType.RTMP_STATUS, rtmpStatusMsg);
}
```

### 2) Responses back to the originating app → respondTo(requestId)

Today (UserSession audioPlayRequestMapping):

```ts
// UserSession.relayAudioPlayResponseToApp(audioResponse)
const packageName = this.audioPlayRequestMapping.get(requestId);
const ws = this.appWebsockets.get(packageName);
ws.send(JSON.stringify(audioResponse));
```

After (move correlation to AppManager):

```ts
// Manager producing a response (e.g., audio/photo)
const ok = this.userSession.appManager.handleAudioPlayResponse(audioResponse);
if (!ok) this.logger.warn({ requestId }, "No app found for response");
```

### 3) Guards → hasSubscribers instead of isAppRunning

Today:

```ts
if (session.appManager.isAppRunning(packageName)) {
  // start/stop stream
}
```

After:

```ts
if (session.appManager.hasSubscribers(StreamType.AUDIO_CHUNK)) {
  // start/stop PCM stream
}
```

Routes can still use isAppRunning for UX; managers should prefer hasSubscribers.

---

## Correlation design (requests ↔ responses)

- AppSession.request(message): attaches a requestId, stores a resolver with timeout.
- AppSession receives a response with requestId from the app and resolves the promise.
- For server-originated responses (e.g., audio play result), managers call AppManager.respondTo(requestId, message), which looks up the originating AppSession and sends.

```ts
// Inside AppManager
private requestMap: Map<string, string>; // requestId -> packageName

respondTo(requestId: string, message: any): boolean {
  const pkg = this.requestMap.get(requestId);
  if (!pkg) return false;
  const s = this.appSessions.get(pkg);
  if (!s) return false;
  s.send(message);
  return true;
}

handleAudioPlayResponse(resp: { requestId: string; [k: string]: any }): boolean {
  if (!resp?.requestId) return false;
  return this.respondTo(resp.requestId, resp);
}
```

---

## Connect vs. reconnect vs. resurrection (semantics and minimal plan)

Grounded in today’s states (AppConnectionState: RUNNING, GRACE_PERIOD, RESURRECTING, STOPPING, DISCONNECTED) and timers (APP_SESSION_TIMEOUT_MS).

Definitions:

- Connect: first time a given packageName attaches a WS in this session (triggered by startApp → webhook → app connects).
- Reconnect: SDK-initiated reattach for the same packageName after a transient WS loss.
- Resurrection: server-driven attempt to restart an app process (webhook) because reconnect did not happen within grace/backoff.

Policy (near-term improvements, low risk):

- On close, transition to GRACE_PERIOD and start a short reconnectGraceMs timer (e.g., 5–8s). Do not trigger RESURRECTING during grace.
- If SDK reconnects (handleAppInit) within grace, treat as Reconnect: reuse pending state, keep subscriptions, cancel RESURRECTING.
- If grace elapses, move to DISCONNECTED and optionally schedule RESURRECTING with jitter backoff (avoid immediate flaps).
- Tag init payloads with reconnect=true on SDK side when possible; if absent, infer reconnect via recent state.

Pseudocode sketch:

```ts
// AppManager
onAppClose(pkg, code, reason) {
  setState(pkg, GRACE_PERIOD);
  timers.set(pkg, setTimeout(() => {
    if (state(pkg) !== GRACE_PERIOD) return; // reconnected
    setState(pkg, DISCONNECTED);
    // optional delayed resurrection
    scheduleWithJitter(() => resurrect(pkg), backoffFor(pkg));
  }, reconnectGraceMs));
}

handleAppInit(ws, init) {
  const pkg = init.packageName;
  const recon = Boolean(init.reconnect) || wasRecentlyInGrace(pkg);
  if (recon) {
    // reconnect path
    attachToExistingSession(pkg, ws, init);
    setState(pkg, RUNNING);
    cancelTimers(pkg);
  } else {
    // fresh connect
    ensureSession(pkg).attach(ws, init);
    setState(pkg, RUNNING);
  }
  // broadcast state if changed
}
```

AppSession responsibilities for WS lifecycle:

- Own heartbeat and message handlers; surface events to AppManager.
- Retain subscriptions across reconnects (unless app sends a new set).
- Clear per-connection counters on attach; keep per-app counters across reconnects.

Phased changes (do-little-first):

1. Add reconnectionGraceMs and jittered resurrection scheduling; preserve current behavior otherwise.
2. Add init.reconnect hint from SDK; treat recent GRACE as reconnect even if hint absent.
3. Move WS handlers into AppSession; AppManager state machine remains.

Migration note: move audioPlayRequestMapping from UserSession into AppManager.correlation.

---

## Behavior improvements

- Isolation and backpressure
  - Per-AppSession send queue; bounded; drop policy + metrics; circuit-break on repeated failures.
- Capability and permission gating
  - On updateSubscriptions and on publish (reject/skip disallowed topics).
- Observability
  - App-level metrics (queueDepth, drops, p50/p95 latency, errors); AppManager aggregates for snapshot.
- Snapshot purity
  - Make UserSession.snapshotForClient pure; mic state adjustments happen directly in updateSubscriptions path, not during snapshot.

---

## Minimal interfaces (TypeScript)

```ts
// Public: used by other managers and routes
export interface IAppManager {
  // lifecycle
  startApp(packageName: string): Promise<AppStartResult>;
  stopApp(packageName: string, restart?: boolean): Promise<void>;
  attachAppConnection(ws: WebSocket, init: AppConnectionInit): Promise<void>;
  startPreviouslyRunningApps(): Promise<void>;
  broadcastAppState(): Promise<AppStateChange | null>;
  isAppRunning(packageName: string): boolean; // routes only

  // subs & fanout
  updateSubscriptions(
    packageName: string,
    subs: SubscriptionRequest[],
  ): Promise<UserI | null>;
  hasSubscribers(topic: ExtendedStreamType): boolean;
  publish(
    topic: ExtendedStreamType,
    payload: unknown,
    options?: { exclude?: string[] },
  ): number;

  // correlation
  respondTo(requestId: string, message: any): boolean;
  handleAudioPlayResponse(response: {
    requestId: string;
    [k: string]: any;
  }): boolean;

  // optional targeted send (advanced use only)
  sendToPackageName(
    packageName: string,
    message: any,
  ): Promise<{ sent: boolean; resurrectionTriggered: boolean; error?: string }>;

  // maintenance
  snapshot(): AppManagerSnapshot;
  dispose(): void;
}
```

```ts
// Private: per-app session (not exported)
class AppSession {
  constructor(args: { packageName: string; logger: Logger }) {}
  attach(ws: WebSocket, init: AppConnectionInit): void {}
  dispose(reason?: string): void {}
  applySubscriptionUpdate(subs: SubscriptionRequest[]): void {}
  getSubscriptions(): ExtendedStreamType[] {
    return [];
  }
  isSubscribed(topic: ExtendedStreamType): boolean {
    return false;
  }
  send(msg: any): Promise<void> {
    return Promise.resolve();
  }
  request(msg: any, timeoutMs?: number): Promise<any> {
    return Promise.resolve();
  }
  info(): AppInfo {
    return {
      packageName: "...",
      connectedAt: Date.now(),
      subs: [],
      health: { queueDepth: 0, errors: 0 },
    };
  }
}
```

---

## Migration plan (safe slices)

1. Introduce AppSession class and wire AppManager to own Map<string, AppSession>.
   - Move heartbeat/ws handlers for apps into AppSession (no behavior change).

2. Move correlation map from UserSession to AppManager.
   - Add AppManager.respondTo(requestId, message); update audio/photo response paths to use it.

3. Absorb SubscriptionManager into AppManager.
   - Move updateSubscriptions, aggregates, and DB persistence. AppSession.applySubscriptionUpdate owns per-app set; AppManager maintains index and counters. Invoke Microphone/Transcription/Translation syncs here.

4. Add publish(...) and hasSubscribers(...).
   - Update managers (Transcription/Translation/Video/Photo) to use publish/hasSubscribers. Keep sendMessageToApp only for routes if absolutely needed, then deprecate.

5. Make snapshotForClient pure; move mic state updates to the subscription-change path.

---

## Testing notes

- Unit-test AppManager.publish/hasSubscribers/index updates for basic topics, language streams, and PCM/transcription counters.
- Correlation tests: request → respondTo; missing requestId returns false.
- Subscription flow tests: reconnect grace for empty subs; permission filtering; DB location rate persistence (mocked).
- Backpressure tests: bounded queue behavior in AppSession.

---

## Open questions

- Keep isAppRunning for routes only, or remove after UI migrates to purely subscription-based views?
- Do we need an explicit “active/foreground app” semantic for some messages? If so, define a SystemTopic and let AppManager map it to one AppSession.
- How to structure metrics export (Prom, logs, or both)?
