# MentraOS Client SDK

> **Status**: Spike
> **Date**: 2026-04-10
> **Author**: Isaiah
> **Audience**: CTO, Head of Client, Cloud Team, Client Team
> **Related**: [client-sdk-spike](../../048-sdk-v3/archive/client-sdk-spike.md) · [cloud-testing](./cloud-testing.md) · [testing-plan](../drafts/testing/testing-plan.md) · [mobile-client map](../drafts/testing/clients/mobile-client.md) · [sdk-miniapp map](../drafts/testing/clients/sdk-miniapp.md)

---

## What this doc is

A comprehensive plan for `@mentra/client` — a TypeScript client SDK that any app (MentraOS, OEM partner, test harness) can use to connect to MentraOS services. This doc synthesizes months of planning work across the cloud team's issue tracker into a single reference, adds the OEM integration model, and includes a concrete analysis of what needs to change in the current mobile app.

This is not a spec. It's a spike — capturing what we know, what we've decided, what's open, and what to build next.

---

## The core argument: developer experience

The most important thing this plan delivers isn't a protocol library or an OEM API. It's **developer experience that developers and AI already understand.**

Today, building a MentraOS mini app means: spin up a Bun server, import `MiniAppServer`, wire up webhooks, configure auth middleware, set up SSE for state sync between backend and webview, manage reconnection logic, serve static files. Every app reinvents this boilerplate. Developers struggle with it. AI coding assistants struggle with it. It's custom infrastructure with no parallels in the broader ecosystem.

The plan is to make building a glasses app feel like building a Next.js app or an Electron app:

| Pattern | Next.js | Electron | React Native / Expo | MentraOS (proposed) |
|---|---|---|---|---|
| Convention-based folders | `pages/`, `app/`, `api/` | `main/`, `renderer/` | `app/`, `components/` | `client/`, `webview/`, `server/` |
| Framework handles wiring | Routing, SSR, API routes | IPC, window management | Native modules, navigation, build | Session lifecycle, state sync, auth |
| Typed communication | Server Actions, `"use server"` | Typed IPC / RPC | Native bridge, Turbo Modules | Typed RPC across client/webview/server |
| Dev command | `next dev` | `electron .` | `npx expo start` | `mentra dev` |
| Build command | `next build` | `electron-builder` | `eas build` | `mentra build` |
| Publish / distribute | Vercel deploy | Auto-update | `eas submit` | `mentra publish` → app store |
| Same code, multiple targets | SSR / SSG / SPA | macOS / Windows / Linux | iOS / Android | Cloud-hosted / on-device / both |

**Why this matters for adoption:**

- **Developers don't have to learn a new paradigm.** They already know folder-based conventions, typed RPC between processes, and framework CLIs. If they've built a Next.js app, an Electron app, or a React Native/Expo app, they already know how to build a glasses app. The mental model is the same.
- **AI coding assistants already understand these patterns.** When a developer asks Claude or Copilot to "add a feature to my Next.js app," the AI knows exactly what to do — folder conventions, typed APIs, framework commands. When they ask "add a feature to my MentraOS app" and the structure follows the same patterns, the AI knows what to do there too. Custom infrastructure that only exists in our ecosystem is a dead end for AI-assisted development.
- **React Native / Expo developers are our target audience.** Most developers building for smart glasses already know React Native. Our framework should feel like home to them — React for the UI, TypeScript everywhere, a CLI that works like `expo`, and a build/publish flow that mirrors `eas build` / `eas submit`. Not a foreign SDK they have to learn from scratch.
- **Onboarding drops from days to minutes.** A developer who knows React can scaffold a glasses app with `mentra init`, run `mentra dev`, and have a working app in minutes — not hours of reading docs about webhooks, transports, and session management.
- **The ecosystem grows faster.** Lower barrier to entry means more apps, more developers, more value for users. This is how platforms win.

The client library (`@mentra/client`), the OEM API, the on-device runtime — those are infrastructure that makes this developer experience possible. But the DX is the goal. Everything else is in service of it.

---

## Why this matters

### The current situation

Every MentraOS interaction round-trips through the cloud:

```
Glasses → BLE → Phone → WebSocket → Cloud → HTTP → Developer's Server
```

Every event, every display update, every audio chunk. This means:

- **Latency.** Display updates travel through the internet and back.
- **Fragility.** If the cloud crashes, every user loses every app.
- **Cost.** Every app session is a WebSocket the cloud must manage.
- **Barrier to entry.** Developers must host a server. Casual developers can't just "make an app."
- **OEM blocker.** Partners can't ship MentraOS-compatible glasses without depending on our cloud for every interaction.
- **Zero automated testing.** The only way to know if the cloud works is to physically connect glasses and check manually.

### What changes

A shared client library — `@mentra/client` — that encapsulates the MentraOS protocol and runs in both React Native and Node/Bun:

| Consumer | Environment | Purpose |
|---|---|---|
| **MentraOS mobile app** | React Native / Expo | Production client. Replaces the current tangled protocol code in `SocketComms.ts`. |
| **OEM partner apps** | React Native or native iOS/Android | OEMs embed the library in their own app to connect their glasses to MentraOS services. |
| **Test harness** | Node / Bun | Simulates users, glasses, and sessions without hardware. Unlocks CI. |
| **CLI tools** | Bun | Developer tools, debugging, scripted demos. |

One library. Same protocol. Same code in tests and production.

---

## Architecture

### The three layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host App                                 │
│  (MentraOS mobile, OEM app, test harness, CLI, desktop)         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   @mentra/client                          │  │
│  │                                                           │  │
│  │  Protocol layer (portable TypeScript):                    │  │
│  │  - WebSocket connection + handshake + reconnection        │  │
│  │  - Message serialization / deserialization                │  │
│  │  - UDP audio framing + encryption                         │  │
│  │  - REST API client                                        │  │
│  │  - Session state machine                                  │  │
│  │  - Device simulation (capabilities, state)                │  │
│  │  - Subscription management                                │  │
│  │                                                           │  │
│  │  Platform adapters (swappable):                           │  │
│  │  - WebSocket: RN WebSocket / ws / Bun.WebSocket           │  │
│  │  - UDP: react-native-udp / dgram / Bun.udpSocket          │  │
│  │  - HTTP: axios / fetch                                    │  │
│  │  - Storage: AsyncStorage / fs / memory                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Platform Layer                           │  │
│  │  (provided by the host app, NOT by @mentra/client)        │  │
│  │                                                           │  │
│  │  - BLE connection to glasses (native)                     │  │
│  │  - Audio capture from mic (native)                        │  │
│  │  - GPS / sensors (native)                                 │  │
│  │  - On-device transcription engine (native)                │  │
│  │  - UI / React components                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

`@mentra/client` owns the **protocol** — how to talk to the MentraOS cloud. It does NOT own hardware (BLE, mic, GPS) or UI. Those are platform concerns provided by the host app.

### What `@mentra/client` provides

```typescript
import { MentraClient } from "@mentra/client";

const client = new MentraClient({
  // Auth — either a Mentra user token or OEM credentials
  auth: { token: "..." },
  // OR
  auth: { oemApiKey: "...", userId: "mentra-uuid-here" },

  // Platform adapters (optional — sensible defaults per environment)
  adapters: {
    websocket: ReactNativeWebSocketAdapter,  // or NodeWebSocketAdapter
    udp: ReactNativeUdpAdapter,              // or NodeUdpAdapter
  },
});

// Connect to cloud
await client.connect();

// Simulate or report device state
client.setGlassesState({
  connected: true,
  model: "mentra-live",
  capabilities: { hasCamera: true, hasMic: true, hasSpeaker: true, hasLight: true },
  battery: 85,
});

// Send audio (from glasses mic, phone mic, or test fixture)
client.sendAudio(pcmChunk);

// Receive events
client.on("display", (event) => { /* display update from an app */ });
client.on("transcription", (event) => { /* transcription result */ });
client.on("photo_request", (event) => { /* app wants a photo */ });
client.on("audio_play", (event) => { /* app wants to play audio */ });

// App lifecycle
await client.startApp("com.example.captions");
await client.stopApp("com.example.captions");

// Disconnect
await client.disconnect();
```

This is the full contract. The MentraOS mobile app uses it. OEM apps use it. Tests use it. Same code, same protocol.

---

## OEM Integration

### The model

OEM partners build their own glasses and their own mobile app. They want MentraOS services — transcription, app ecosystem, display routing — without building the platform themselves.

What they get:

| Service | Description |
|---|---|
| **Audio SFU + Transcription** | Send mic audio, get back transcription results (Soniox). The core value prop. |
| **Mini App Store** | Their users can install and run MentraOS mini apps. |
| **Display routing** | Apps send display updates, routed to the OEM's glasses via their BLE protocol. |
| **AI tools** | Access to the MentraOS AI tool system (MCP-based, when shipped). |
| **Photo / Camera** | Apps can request photos, OEM's app routes to their glasses camera. |

What they provide:

| Responsibility | Who |
|---|---|
| **Glasses hardware + firmware** | OEM |
| **BLE communication** | OEM (their protocol) or shared (if they follow Mentra Display protocol) |
| **Mobile app** | OEM (embeds `@mentra/client`) |
| **Audio capture** | OEM's app (feeds PCM into `client.sendAudio()`) |
| **User authentication** | OEM's own auth system, bridged to Mentra identity |

### OEM glasses integration

OEMs have two paths for BLE:

**Path A — Custom BLE protocol.** The OEM has their own glasses with their own BLE protocol. Either we or they write a `SGCManager` implementation (a glasses communicator) using their hardware SDK. This is the same pattern we use internally — `MentraLive`, `G1`, `G2`, `Mach1`, `MentraNex` are all `SGCManager` implementations. We add theirs.

**Path B — Mentra Display protocol.** The OEM follows the same BLE protocol as Mentra Display / Nex. This is our simplest glasses protocol — display-only, text in / text out. No custom integration needed.

Either way, `@mentra/client` doesn't care. It speaks the cloud protocol. The BLE layer is the host app's problem.

### OEM user identity

**Key constraint:** OEMs own their users. Users sign up through the OEM's system, not ours. The OEM authenticates their own users however they want (their own auth, their own database, their own flow). Mentra never sees OEM user credentials, passwords, or OAuth tokens. We're an API provider — the OEM's backend vouches for their users, and we provide services.

We need to map OEM users to Mentra identities so we can track usage, gate access to services, and associate app installs.

**How it works:**

1. We issue the OEM an **OEM API key** (for v1: manually provisioned via an internal admin page, since there will be few OEMs).
2. The OEM's mobile app initializes `@mentra/client` with `{ oemApiKey, externalUserId }`.
3. On first connection, the cloud sees this `(oemApiKey, externalUserId)` pair and **auto-creates a Mentra user** if one doesn't exist. If it does exist, it reconnects to the existing identity.
4. No pre-registration step required. Users are provisioned lazily on first connection.
5. If an OEM's key is revoked, all their users lose access to MentraOS services.

```
OEM's App                           Mentra Cloud
    │                                    │
    │  new MentraClient({                │
    │    auth: {                          │
    │      oemApiKey: "...",             │
    │      externalUserId: "oem-usr-123" │
    │    }                               │
    │  })                                │
    │                                    │
    ├─ connect() ──────────────────────► │
    │                                    │  Cloud looks up (oemApiKey, externalUserId)
    │                                    │  → Found? Use existing Mentra user.
    │                                    │  → Not found? Auto-create, store mapping.
    │◄──── connection_ack ───────────────┤
    │                                    │
```

The mapping table: `oem_users(oem_id, external_user_id, mentra_user_id, created_at)`. Populates itself on first connection.

**Two auth approaches (both viable, decide later):**

| Approach | How it works | Trade-offs |
|---|---|---|
| **A — Opaque (recommended for v1)** | OEM passes `oemApiKey` + `externalUserId` on every connection. Cloud validates the key and resolves/creates the Mentra user. OEM never sees internal tokens. | Simplest. OEM can't leak tokens. Every connection is validated against the key. |
| **B — Token exchange** | OEM's backend calls our API to exchange `(oemApiKey, externalUserId)` for a short-lived Mentra token. Token is passed to the client. Standard OAuth-style. | More flexible (tokens carry scopes, expiry, refresh). More infrastructure. Needed if we want per-user permission scoping. |

For v1 with a handful of OEMs, Approach A is sufficient.

**Internal admin portal (minimal, not user-facing):**

An internal-only admin page (in the existing developer console, locked to admin accounts) where we can:
- Create an OEM (name → generates API key)
- View their users and usage
- Revoke or rotate a key

Not a self-service portal. Just enough that cloud engineers don't need to run SQL to onboard an OEM. Self-service OEM portal is a later concern.

**Auth provider for Mentra direct users (open/deferred):**

The current Mentra user auth uses Supabase/Authing. This may change — WorkOS, Clerk, or something else are alternatives under consideration. This decision is independent of the OEM design. OEM auth bypasses our user auth system entirely — OEMs authenticate with their API key, not through our identity provider.

### Cloud API for OEMs

Minimal surface:

```
POST   /api/oem/users              — Explicitly create a Mentra user (optional — lazy provisioning handles this automatically)
GET    /api/oem/users              — List all users for this OEM
DELETE /api/oem/users/:externalId  — Remove a Mentra user and revoke their access
GET    /api/oem/usage              — Usage summary (transcription minutes, active users, etc.)
```

All authenticated via the OEM API key in the `Authorization` header. These endpoints are optional — most OEMs will just use lazy provisioning via `@mentra/client` and never call the API directly. The API exists for OEMs that want to pre-provision, audit, or clean up users.

---

## On-Device Runtime

### Why apps need to run locally

Today, mini apps run on a remote server. For local apps (offline captions, low-latency display updates, apps that don't need a backend), this is unnecessary overhead. The phone can run the app directly.

### The architecture

SDK v3 was designed for this. `MentraSession` depends on a `Transport` interface, not WebSocket directly. Today there's `WebSocketTransport` (app server → cloud). For local apps, we create a local transport that routes messages between the app's JS process and the phone's native layer — same session API, same managers, same everything.

There are three viable design options for how local apps run on the phone. All three work with the same SDK — the `Transport` interface doesn't care where messages come from. This is a mobile implementation choice, not an SDK architecture decision.

### Option A — Keep-alive WebView + Native HTTP Server (recommended for v1)

```
Phone
┌──────────────────────────────────────────────────────┐
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │  WebView (keep-alive, per app)                 │   │
│  │                                                │   │
│  │  React app code (developer writes this)        │   │
│  │  @mentra/webview-sdk (our lib)                 │   │
│  │  Session logic + UI live together              │   │
│  │                                                │   │
│  └────────────────────┬──────────────────────────┘   │
│                       │ HTTP (localhost)               │
│  ┌────────────────────▼──────────────────────────┐   │
│  │  Native Runtime (HTTP server on localhost)     │   │
│  │                                                │   │
│  │  Session Manager (manages MiniAppSessions)     │   │
│  │  @mentra/client  ←→  Cloud (WS + UDP)         │   │
│  │  BLE Manager     ←→  Glasses                   │   │
│  │  Audio Capture   ←→  Mic (phone/glasses)       │   │
│  │  Local STT       ←→  Sherpa-ONNX              │   │
│  │  Sensors         ←→  GPS, etc.                 │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

The native layer runs a localhost HTTP server that manages MiniAppSession state — similar to how the cloud works today. Each app runs in a keep-alive WebView that contains the developer's React code plus a client library we provide (`@mentra/webview-sdk`) that talks to the native server over HTTP.

**Why this is compelling:**

- **Familiar to developers.** The app is just a React app. Developers already know this.
- **The native server mirrors the cloud.** The native HTTP server manages sessions, routes events, tracks subscriptions — the same responsibilities the cloud has today. The contract is the same; only the transport changes (localhost HTTP instead of remote WebSocket).
- **Clean separation.** The WebView handles UI + app logic. The native layer handles hardware + cloud communication. They talk over a well-defined HTTP API.
- **The library we provide for WebViews** (`@mentra/webview-sdk`) works the same whether the WebView is talking to the native server (local app) or to a cloud-hosted MiniAppServer. Developers don't need to know the difference.

**How it maps to the cloud-hosted model:**

```
Cloud-hosted app:
  MiniAppServer (Hono, Node/Bun)  ←HTTP webhook→  Cloud  ←WS→  Phone  ←BLE→  Glasses

Local app:
  WebView (React)  ←HTTP localhost→  Native Runtime  ←BLE→  Glasses
                                          ↕
                                     Cloud (audio SFU, transcription)
```

The developer's code talks to the same interface in both cases. The native runtime IS the local cloud — it does for one user on one phone what the cloud does for all users globally.

### Option B — Separate JS Runtime + Optional WebView

```
Phone
┌──────────────────────────────────────────────────────┐
│                                                       │
│  ┌─────────────┐  ┌──────────────────┐               │
│  │ JS Runtime   │  │ Optional WebView │               │
│  │ (Hermes)     │  │ (phone UI)       │               │
│  │ session.hbc  │◄─► useMentraState  │               │
│  └──────┬───────┘  └──────────────────┘               │
│         │ IPC (localhost WS or JSI)                    │
│  ┌──────▼────────────────────────────────────────┐   │
│  │  Native Runtime                                │   │
│  │  (same as Option A, minus the HTTP server —    │   │
│  │   uses IPC / JSI instead)                      │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

The app's session logic runs in a dedicated Hermes JS runtime (separate from the RN UI thread). The WebView is optional — only opened when the user wants the phone UI. The JS runtime keeps running in the background.

**Advantages over Option A:**

- App stays alive when the WebView is closed (background execution).
- Multiple apps can run concurrently without multiple WebViews.
- Mirrors how cloud-hosted apps work (SDK server runs independently of WebView).
- Hermes bytecode precompilation for instant startup.

**Disadvantages:**

- More complex to build (separate Hermes instance management, IPC between processes).
- Developer experience is different — `session/index.ts` + `webview/App.tsx` is two entry points instead of one.
- Context isolation and sandboxing are harder.

### Option C — Hybrid

Start with Option A (simpler, faster to ship). Add Option B's background execution later for apps that need it. The SDK and native runtime support both — the transport interface is the same either way.

**Recommendation:** Start with Option A. It's the fastest path to local apps, the developer experience is familiar (just React), and the native HTTP server pattern is well-understood. If we need background execution or concurrent apps later, we add Option B incrementally. The SDK doesn't change.

### The SDK makes this possible

Four SDK v3 design decisions that enable local apps:

**1. Transport abstraction.** `MentraSession` depends on a `Transport` interface:

```
send(data: string): void
onMessage(handler: (data: string) => void): void
onClose(handler: (code: number, reason: string) => void): void
close(): void
readyState: number
```

Today: `WebSocketTransport`. For local apps: `LocalTransport` (routes to native layer via bridge). The entire session API — all 14 managers — works unchanged.

**2. Declarative subscriptions.** Subscriptions are derived from handler registrations. When an app calls `session.transcription.on(callback)`, the subscription is automatically tracked. The platform runtime can reconstruct subscriptions at any time without the app managing them.

**3. Registry-based message routing.** Messages go through `_MessageRouter` with a `MessageHandlerRegistry` and `DataStreamRouter`. No giant switch statements. Same routing works whether messages come from cloud WebSocket, local bridge, or anything else.

**4. Reconnection model.** The v3 lifecycle (connected → running → transport down → reconnected → stopped) means transport blips don't kill the session. Critical for mobile where backgrounding, memory pressure, and BLE disconnects are routine.

### The native runtime (both options)

Regardless of which option we choose, the native runtime has the same responsibilities. It's the local equivalent of the cloud — a session manager that routes messages between apps and hardware.

**Option A (HTTP server):** The WebView talks to the native layer via HTTP endpoints on localhost. The native server exposes routes that mirror the cloud's contract:

```
POST /session/start          — start an app session
POST /session/stop           — stop an app session
POST /session/subscribe      — update subscriptions
POST /session/message        — send a message (display, photo, audio, etc.)
GET  /session/events         — SSE stream of incoming events (transcription, buttons, etc.)
```

The developer's WebView code uses `@mentra/webview-sdk` which wraps these HTTP calls behind the familiar `MentraSession` API. The developer writes:

```typescript
// WebView React app — uses our library
import { useMentraSession } from "@mentra/webview-sdk";

function App() {
  const session = useMentraSession();

  useEffect(() => {
    session.transcription.on((data) => {
      // Transcription from Sherpa-ONNX (local) or Soniox (cloud)
    });
  }, [session]);

  return <div>...</div>;
}
```

Under the hood, `useMentraSession()` opens an SSE connection to the native server for incoming events and POSTs commands to the session endpoints. The developer doesn't know or care that it's localhost HTTP instead of a remote WebSocket.

**Option B (Hermes + IPC):** The app bundle runs in a dedicated Hermes context. The native runtime injects a transport object:

```typescript
// Injected by the phone runtime (native, via JSI or bridge)
globalThis.__mentraTransport = {
  send(data: string): void { /* routes to BLE, local STT, GPS, etc. */ },
  onMessage(handler: (data: string) => void): void { /* native → JS events */ },
  onClose(handler: (code: number, reason: string) => void): void { /* cleanup */ },
  close(): void { /* teardown */ },
  readyState: 1,
};
```

The SDK detects this on initialization and uses it as the transport. The developer writes:

```typescript
// session/index.ts — same code as a cloud-hosted app
export default function onSession(session: MentraSession) {
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });
}
```

**Both options route the same message types:**

| Message from app | Native action |
|---|---|
| `DisplayRequest` | BLE write to glasses display |
| `SubscriptionUpdate` (transcription) | Start/stop Sherpa-ONNX or cloud Soniox |
| `SubscriptionUpdate` (location) | Start/stop GPS |
| `AudioPlayRequest` | Play audio on glasses speaker |
| `PhotoRequest` | BLE camera command |

| Native event | Message to app |
|---|---|
| Transcription result | `DataStream` with transcription data |
| Button press (BLE) | `DataStream` with button event |
| GPS update | `DataStream` with location |
| Battery change (BLE) | `DataStream` with battery level |

Same message types as the cloud protocol. Same SDK. Different transport.

### On-device transcription

MentraOS already has local transcription via **Sherpa-ONNX**. It works — English quality is solid. The implementation is clean and self-contained:

- `SherpaOnnxTranscriber` (Kotlin/Swift) runs on a dedicated background thread
- Takes raw PCM 16kHz in via `acceptAudio(pcmData)`
- Emits partial and final results via a `TranscriptListener` callback
- Auto-detects model architecture (Transducer vs CTC) from file layout
- Models downloaded from CDN, stored locally (~95MB CTC, ~349MB Transducer)

The transcriber itself is well-encapsulated. The coupling issue is `CoreManager` — a God Object that owns the transcriber alongside the mic, BLE, VAD, LC3 codec, and glasses state. But the transcriber can be extracted without touching CoreManager's other responsibilities.

**Capabilities model.** Different transcription engines provide different data:

| Capability | Soniox (cloud) | Sherpa-ONNX (local) |
|---|---|---|
| Language detection | ✅ | ❌ |
| Speaker diarization | ✅ | ❌ |
| Word timestamps | ✅ | Model-dependent |
| Confidence scores | ✅ | Model-dependent |
| Supported languages | 50+ | 1-3 per model |

The SDK exposes a `TranscriptionCapabilities` interface so apps can query what's available and adapt their UI. When the engine switches (e.g., network drops, fall back to local), `onCapabilitiesChange` fires and the app adjusts.

### App distribution

1. Developer builds app with `@mentra/sdk` (same as today)
2. `mentra build` produces a JS bundle + optional webview assets + manifest
3. Developer publishes to Mentra App Store via `mentra publish` or dev console
4. User installs on their phone from the store
5. Phone runtime loads the bundle when the user starts the app
6. Same app can also run cloud-hosted — both modes supported simultaneously

### What the cloud keeps

The cloud doesn't go away. It becomes a service layer:

| Service | Description |
|---|---|
| **Audio SFU** | UDP audio ingestion, Soniox transcription/translation. Too compute-heavy for on-device. |
| **App Store** | App submission, hosting, discovery, updates. |
| **Authentication** | User identity (Mentra UUID), OEM identity, core tokens. |
| **Cloud-hosted app relay** | For apps that still run on remote servers (backward compat, or apps that need a backend). |
| **Tool system** | MCP-based tool registry and execution (when shipped). |
| **Analytics** | Usage tracking, crash reporting, telemetry. |

---

## Current Mobile Architecture Analysis

An audit of the existing mobile codebase (`mobile/`) to understand what needs to change.

### Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  React Native (TypeScript)                                   │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │SocketComms│ │UdpManager│ │STTModel  │ │MantleManager   │  │
│  │(WebSocket │ │(UDP audio│ │Manager   │ │(orchestrator)  │  │
│  │ protocol) │ │ framing) │ │(downloads│ │                │  │
│  └─────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬────────┘  │
│        │            │            │               │           │
│════════╪════════════╪═════════════╪══════════════╪═══════════│
│  Native Modules (core / crust)                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │Bridge.kt │ │CoreMgr.kt│ │SGCManager│ │SherpaOnnx      │   │
│  │(events)  │ │(audio hub│ │(BLE, per │ │Transcriber     │   │
│  │          │ │+ routing)│ │ glasses) │ │                │   │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Extraction assessment

| Component | Files | RN Coupling | Can it become `@mentra/client`? |
|---|---|---|---|
| **WebSocket protocol** | `SocketComms.ts`, `WebSocketManager.ts` | 🔴 High — calls CoreModule, Zustand stores, RN navigation, permissions directly | **This is the extraction target.** Needs to be split into protocol (portable) + platform (RN-specific). |
| **UDP audio** | `UdpManager.ts`, `UdpCrypto.ts` | 🟡 Low — only `react-native-udp` | Swap UDP dependency. Crypto is pure TS (tweetnacl). |
| **REST API** | `RestComms.ts` | 🟡 Low-Medium — Axios is portable, FormData and one CoreModule call aren't | Mostly portable. Small adapter needed. |
| **Local WS server** | `MiniSockets.ts` | 🟢 Very low — just `react-native-tcp-socket` | Swap for `net.createServer()`. Hand-rolled SHA-1 can use `crypto` in Node. |
| **Mini app lifecycle** | `Composer.ts` | 🟠 Medium — expo-file-system, react-native-zip-archive | Business logic is pure TS. Swap FS and zip deps. |
| **BLE** | `modules/core/.../sgcs/*` | ❌ Entirely native | Stays native. Not part of `@mentra/client`. |
| **Audio capture** | `CoreManager.handlePcm()`, `PhoneMic.kt` | ❌ Entirely native | Stays native. Feeds into `client.sendAudio()`. |
| **Local STT** | `SherpaOnnxTranscriber.kt/.swift` | ❌ Native, but self-contained | Clean extraction target. PCM in, text out. |

### The hairball: `SocketComms.ts`

This is the file that becomes `@mentra/client`. Today it's a ~700-line singleton with a giant switch statement dispatching ~30 message types. Every handler directly calls:

- `CoreModule` (native Kotlin/Swift bridge) — for hardware commands
- Zustand stores — for UI state updates
- `displayProcessor` — for rendering display events
- RN navigation — for screen transitions
- `UdpManager` — for audio configuration
- `MantleManager` — for sensor control

**To extract this**, we split it into:

1. **`@mentra/client` protocol layer** (portable TypeScript):
   - WebSocket connection + handshake + reconnection
   - Message parsing + serialization (the switch statement, but emitting typed events instead of calling native)
   - UDP audio framing + encryption
   - REST client
   - Session state machine
   - Subscription tracking

2. **MentraOS mobile adapter** (RN-specific, stays in the mobile app):
   - Listens to `@mentra/client` events
   - Routes `display` events to `CoreModule.displayEvent()`
   - Routes `photo_request` to `CoreModule.photoRequest()`
   - Routes `audio_play` to audio playback service
   - Updates Zustand stores from client state changes
   - Provides platform adapters (RN WebSocket, RN UDP)

The mobile app goes from:

```
SocketComms (does everything) → CoreModule / Stores / UI
```

To:

```
@mentra/client (protocol only) → MentraOS Adapter → CoreModule / Stores / UI
```

The adapter is thin — it's just event listeners that call the right native methods. All the protocol logic lives in `@mentra/client`.

### Native modules stay native

The two Expo native modules (`core` and `crust`) don't change:

- **`core`** — BLE communication (SGCManager per glasses model), audio capture (PhoneMic), LC3 codec, Sherpa-ONNX transcription, Bridge events, GlassesStore
- **`crust`** — Image/video processing (HDR, stabilization, gallery)

`@mentra/client` sits above these. It doesn't know about BLE or audio capture. The mobile app feeds audio from `core` into `client.sendAudio()` and routes `client.on("photo_request")` to `core.photoRequest()`.

### OEM integration with native modules

When an OEM builds their own app, they bring their own native layer:

```
MentraOS App                          OEM App
┌──────────────────────┐              ┌──────────────────────┐
│  @mentra/client      │              │  @mentra/client      │  ← same library
│  core module (ours)  │              │  OEM native layer    │  ← their BLE, mic, etc.
│  SGCManager (ours)   │              │  OEM BLE protocol    │
│  Our BLE protocol    │              │  Their glasses       │
│  Our glasses         │              │                      │
└──────────────────────┘              └──────────────────────┘
```

The OEM implements:
- Their BLE communication (or uses our Mentra Display protocol)
- Audio capture from their glasses mic
- Display rendering on their glasses
- Photo capture (if their glasses have a camera)

They feed audio into `@mentra/client`, receive display events from it, and handle the hardware layer themselves. `@mentra/client` handles everything between the phone and the cloud.

---

## What Needs to Be Built

### Phase 1 — `@mentra/client` library

**Goal:** A standalone TypeScript package that speaks the MentraOS cloud protocol and runs in RN, Node, and Bun.

**Build approach:** Write it from the cloud side, referencing the cloud's message types (`cloud/packages/types/`), WebSocket handlers, and architecture docs. Do NOT extract from the mobile app — the mobile code is too coupled. Build clean, then swap the mobile app onto it.

**What it includes:**

| Module | Purpose |
|---|---|
| `WebSocketTransport` | Connection, handshake, ping/pong, reconnection |
| `UdpTransport` | Audio framing (userIdHash + seq + nonce + ciphertext), encryption (XSalsa20-Poly1305) |
| `RestClient` | Typed HTTP client for cloud REST endpoints |
| `SessionManager` | State machine: disconnected → connecting → connected → reconnecting |
| `MessageRouter` | Parse inbound messages, emit typed events |
| `SubscriptionManager` | Track active subscriptions, re-send on reconnect |
| `DeviceSimulator` | Set glasses model, capabilities, battery, connection state |
| `AudioSender` | Buffer + send PCM/LC3 audio via UDP or WS fallback |

**What it does NOT include:**

- BLE communication (platform layer)
- Audio capture (platform layer)
- UI components (platform layer)
- Local transcription (platform layer)
- Any React Native dependencies

**Package:** `@mentra/client` published to npm. Zero native dependencies. Pure TypeScript with platform adapters injected at construction time.

### Phase 2 — Mobile app migration

**Goal:** Replace `SocketComms.ts` + `UdpManager.ts` + `RestComms.ts` with `@mentra/client` + a thin adapter layer.

1. Install `@mentra/client` in the mobile app
2. Write a `MentraOSAdapter` that:
   - Creates a `MentraClient` instance with RN platform adapters
   - Routes client events to `CoreModule` / Zustand stores / services
   - Feeds `Bridge` events (audio, transcription, buttons) into the client
3. Remove `SocketComms.ts`, `UdpManager.ts`, `WebSocketManager.ts`, `UdpCrypto.ts`
4. `RestComms.ts` either migrates into `@mentra/client` or stays as the mobile-specific REST layer

The mobile app becomes a consumer of `@mentra/client`, not an owner of the protocol.

### Phase 3 — OEM API

**Goal:** OEMs can create users and embed `@mentra/client` in their app.

1. Add OEM API key table + OEM-user mapping table to the database
2. Add `POST /api/oem/users` endpoint (create Mentra user for OEM)
3. Add OEM API key auth middleware
4. Add auth path in `@mentra/client` for `{ oemApiKey, userId }` credentials
5. Document the OEM integration guide
6. Manually onboard first OEM partner (hardcoded key, no portal)

### Phase 4 — Local app runtime

**Goal:** Mini apps can run on the phone without a cloud server.

1. Implement `LocalTransport` — routes messages between the app JS process and the native layer
2. Implement the native transport bridge (`globalThis.__mentraTransport`)
3. Bundle loading — download, cache, verify, and load JS bundles
4. Runtime lifecycle — start/stop apps, manage concurrent sessions
5. Wire up native routers — display, audio, camera, transcription, sensors

This is the biggest phase. The mobile team builds the native side, the cloud/SDK team provides `MentraSession` + `Transport` + the local transport implementation.

### Phase 5 — Testing harness

**Goal:** Automated E2E tests with no hardware.

1. Write a test mini app using `@mentra/sdk` (exercises every manager)
2. MentraClient connects to cloud, simulates a user + glasses
3. Test mini app receives events, sends responses
4. Harness verifies the full round-trip
5. Two tiers: fast (mocked transcription, every PR) and smoke (real Soniox, before deploy)

This is detailed in [cloud-testing.md](./cloud-testing.md) and [testing-plan.md](../drafts/testing/testing-plan.md).

### Phase 6 — App framework + CLI

**Goal:** `mentra dev`, `mentra build`, `mentra publish`.

1. Convention-based project structure: `session/`, `webview/`, `mentra.config.ts`
2. `mentra build` — Bun bundles session code + SDK, generates manifest
3. `mentra dev` — local dev server with hot reload
4. `mentra publish` — build + upload to app store
5. Same code builds for local (phone runtime) and cloud (MiniAppServer) targets

---

## Sequencing

```
Phase 1: @mentra/client library
         ↓
Phase 2: Mobile app migration (swap SocketComms for @mentra/client)
  │      ↓
  │  Phase 3: OEM API (user creation, OEM auth)
  │      ↓
  │  Phase 5: Testing harness (uses @mentra/client to simulate users)
  │
Phase 4: Local app runtime (native transport bridge, bundle loading)
         ↓
Phase 6: App framework + CLI (mentra dev / build / publish)
```

Phases 1-3 and 5 are cloud-team owned. Phase 4 is a joint effort with the client team. Phase 6 is SDK/tooling.

Phase 1 is the foundation. Everything else depends on it.

---

## Examples (explorable code)

The `examples/` directory contains two mock projects that show the concrete developer experience. These are not functional — they're explorable TypeScript that demonstrates the API surfaces, file structures, and integration patterns.

### Mini App Example (`examples/miniapp-example/`)

What a developer's glasses app looks like with the proposed framework. A "Smart Notes" app showing all three layers:

```
miniapp-example/
├── mentra.config.ts          ← package name, permissions
├── client/
│   └── index.ts              ← runs on phone — session logic, subscriptions
├── webview/
│   └── App.tsx               ← React UI — useMentra() one hook for everything
├── server/
│   └── index.ts              ← optional cloud backend (AI summarization)
└── shared/
    └── types.ts              ← AppState type — the contract
```

Key DX patterns demonstrated:
- **`useMentra()`** — one hook gives you `.state`, `.client`, `.server`
- **Exported functions = automatic typed RPC** — export a function from `client/index.ts`, call it from the webview as `mentra.client.saveNote()`. TypeScript infers everything.
- **`state.set()` syncs everywhere** — set in client, read in webview, update from server. No SSE, no manual wiring.
- **`mentra dev` → `mentra build` → `mentra publish`** — the full workflow.
- **What the developer did NOT write:** MiniAppServer, webhooks, WebSocket handling, SSE, auth, reconnection logic.

### OEM Example (`examples/oem-example/`)

What an OEM partner's monorepo looks like. "Acme Glasses" builds their own smart glasses and uses MentraOS for transcription, app ecosystem, and display routing.

```
oem-example/
├── packages/
│   ├── mock-sdks/                    ← API surface definitions for all Mentra packages
│   │   ├── mentra-client.ts          ← @mentra/client — cloud protocol (10 managers)
│   │   ├── mentra-glasses.ts         ← @mentra/glasses — BLE connection + hardware
│   │   └── mentra-simulated-glasses.ts ← @mentra/simulated-glasses — for dev/CI/demos
│   │
│   ├── mobile/                       ← Acme's React Native app
│   │   └── src/
│   │       ├── App.tsx               ← root component, tabs, login flow
│   │       ├── mentra.ts             ← ONE integration file (init, auth, glasses bridge)
│   │       ├── hooks/                ← React hooks (one per manager)
│   │       │   ├── index.ts
│   │       │   ├── useMentra.ts      ← convenience combo hook
│   │       │   ├── useTranscription.ts
│   │       │   ├── useGlasses.ts
│   │       │   ├── useApps.ts
│   │       │   ├── useConnection.ts
│   │       │   ├── useDisplay.ts
│   │       │   └── useSetting.ts
│   │       └── screens/
│   │           ├── HomeScreen.tsx     ← Acme's branded home screen
│   │           └── PairingScreen.tsx  ← BLE scan → connect → bridge
│   │
│   └── tests/                        ← E2E tests with simulated glasses
│       └── e2e/
│           ├── transcription.test.ts   ← audio → transcription → display
│           ├── app-lifecycle.test.ts   ← start/stop apps, state checks
│           ├── glasses-capabilities.test.ts ← capability gating per model
│           └── photo-capture.test.ts   ← photo request round-trip
```

Key patterns demonstrated:

**`@mentra/client` manager API** — the client has 10 managers mirroring the real mobile app's state:

| Manager | What it owns |
|---|---|
| `client.glasses` | Connection, model, battery, WiFi, capabilities, BLE event bridge |
| `client.apps` | Installed, running, foreground, background, start/stop, health |
| `client.connection` | WebSocket status, reconnection, session ID |
| `client.display` | Current display event, main/dashboard view |
| `client.audio` | Mic streaming, format config, mic source ranking |
| `client.transcription` | Live results, capabilities (cloud vs local) |
| `client.user` | Identity, token, ~70 typed settings |
| `client.notifications` | Phone notification forwarding |
| `client.location` | GPS updates, tier management |
| `client.ota` | Firmware update tracking |

**`@mentra/glasses` with manager pattern** — the `Glasses` interface mirrors the SDK:
- `glasses.display.showText()`, `glasses.display.clear()`
- `glasses.camera.takePhoto()`, `glasses.camera.startStream()`
- `glasses.mic.onChunk()`, `glasses.mic.start()`
- `glasses.led.set()`, `glasses.led.off()`
- `glasses.device.onButtonPress()`, `glasses.device.batteryLevel`
- Unavailable methods throw `MentraCapabilityError` with the model name

**`@mentra/simulated-glasses`** — static factories, test assertions:
- `SimulatedGlasses.G1()`, `SimulatedGlasses.MentraLive()`, `SimulatedGlasses.custom({...})`
- `sim.display.waitFor({ timeout: 5000 })` — promise-based test assertions
- `sim.mic.playFile("./fixtures/hello.pcm")` — feed test audio
- `sim.device.pressButton("main")` — simulate hardware events
- `sim.display.history`, `sim.display.last` — inspect what apps sent

**OEM auth** — API key stays on the OEM's backend, never in the mobile app:
```
OEM backend calls: POST /api/oem/auth { oemApiKey, externalUserId }
Gets back: { token }
Mobile app: client.setToken(token) → client.connect()
```

**Glasses wiring** — currently explicit in `mentra.ts` (`connectGlasses()`), will become `client.glasses.attach(glasses)` which auto-wires all events bidirectionally.

**E2E tests** — full stack tested with no hardware:
```typescript
const sim = SimulatedGlasses.G1();
const client = new MentraClient();
client.glasses.attach(sim);
await client.connect();
await client.apps.start("com.example.captions");
await sim.mic.playFile("./fixtures/hello.pcm");
const display = await sim.display.waitFor({ timeout: 10_000 });
expect(display.payload.text).toContain("hello");
```

**Browse the code** — the examples are designed to be read, not run. Each file has comments explaining the patterns.

---

## What's Already Done

This isn't starting from zero. The groundwork is laid:

| What | Status | Where |
|---|---|---|
| SDK v3 transport abstraction | ✅ Shipped | `cloud/packages/sdk/src/transport/` |
| SDK v3 session + 14 managers | ✅ Shipped | `cloud/packages/sdk/src/session/` |
| SDK v3 subscription model | ✅ Shipped | `cloud/packages/sdk/src/session/internal/` |
| Cloud protocol documentation | ✅ Written | `cloud/.architecture/architecture.md` |
| Cloud message types | ✅ Defined | `cloud/packages/types/` |
| Mobile client protocol map | ✅ Written | `cloud/issues/999-cloud-plan/drafts/testing/clients/mobile-client.md` |
| SDK mini app protocol map | ✅ Written | `cloud/issues/999-cloud-plan/drafts/testing/clients/sdk-miniapp.md` |
| Local runtime spike (JS engine, native bridge, bundle loading) | ✅ Written | `cloud/issues/048-sdk-v3/archive/client-sdk-spike.md` |
| On-device architecture spike (three-process model) | ✅ Written | `cloud/issues/999-cloud-plan/drafts/plans/puddle-architecture.md` |
| Testing plan | ✅ Written | `cloud/issues/999-cloud-plan/plans/cloud-testing.md`, `drafts/testing/testing-plan.md` |
| Mobile architecture audit | ✅ Done | This document (above) |
| Sherpa-ONNX local transcription | ✅ Working in production | `mobile/modules/core/.../stt/SherpaOnnxTranscriber.kt/.swift` |
| Working Gemini Live mini app (proof of concept) | ✅ Working | `examples/stream-test/` |
| SDK photo request bridge fix | ✅ Fixed | `cloud/packages/sdk/src/session/managers/CameraManager.ts` |

---

## Package Map

How the npm packages relate — existing, changing, and new:

```
═══ EXISTING (what changes) ═══════════════════════════════════════════════

@mentra/sdk              Server-side SDK. MiniAppServer, MentraSession, managers.
                         Stays as-is. Still used for cloud-hosted mini apps.
                         The session/manager code also gets reused by the
                         on-device runtime (same MentraSession, different transport).

@mentra/react            React hooks for mini app webviews. useMentraAuth, etc.
                         Expands: adds useMentraState, useMentraRPC.
                         Absorbs @mentra/webview-sdk (merge into one package).
                         Used by: mini app developers in their webview/ code.
                         NOT used by the MentraOS mobile app itself.

@mentra/webview-sdk      Currently exists in mobile/webview/sdk/.
                         Merges into @mentra/react — one webview library.

@mentra/cli              CLI tool. Currently: mentra app publish, mentra org.
                         Expands: mentra dev, mentra build, mentra publish.
                         Becomes the full framework CLI.

@mentra/types            Shared TypeScript types. Stays. Expands with
                         RPC contract types, OEM types, state sync types.

@mentra/display-utils    Pixel-accurate text measurement. Stays as-is.
@mentra/cloud            The cloud server. Private. Stays as-is.
@mentra/utils            Internal utilities. Private. Stays as-is.

═══ NEW ════════════════════════════════════════════════════════════════════

@mentra/client           Cloud protocol library. WebSocket + UDP + REST.
                         Pure TS, no native deps.
                         10 managers: glasses, apps, connection, display,
                         audio, transcription, user, notifications, location, ota.
                         Used by: MentraOS mobile app, OEM apps, test harness.
                         NOT used directly by mini app developers.

@mentra/glasses          BLE glasses connection and hardware abstraction.
                         React Native native module (Expo Modules API).
                         Manager pattern: glasses.display, glasses.camera,
                         glasses.mic, glasses.led, glasses.device.
                         Built-in models: MentraLive, G1, Mach1, MentraNex.
                         OEMs register custom models via GlassesModelDriver.
                         Standalone — works without @mentra/client (fully offline).

@mentra/simulated-glasses  Simulated glasses for dev, CI, and demos.
                         Implements the same Glasses interface.
                         Static factories: SimulatedGlasses.G1(), .MentraLive(), etc.
                         Test helpers: .display.waitFor(), .mic.playFile(),
                         .device.pressButton(), .display.history.
                         Headless mode for CI — no UI needed.

@mentra/runtime          The app framework. Convention-based project structure
                         (client/ + webview/ + server/), auto-wiring, build
                         pipeline, dev server. Like "next" for glasses apps.
                         Wraps @mentra/sdk + @mentra/client under the hood.
                         This is what mini app developers interact with.
```

**Who uses what:**

| Package | Mini app developers | MentraOS mobile app | OEM partner apps | Test harness |
|---|---|---|---|---|
| `@mentra/runtime` | ✅ Primary interface | ❌ | ❌ | ❌ |
| `@mentra/react` | ✅ In webview/ code | ❌ | ❌ | ❌ |
| `@mentra/sdk` | Via @mentra/runtime | ❌ | ❌ | ✅ Test mini app |
| `@mentra/client` | ❌ (framework uses it) | ✅ Directly | ✅ Directly | ✅ Directly |
| `@mentra/glasses` | ❌ | ✅ Built-in | ✅ Or own BLE | ❌ |
| `@mentra/simulated-glasses` | ✅ In dev mode | ❌ | ✅ Before hardware ready | ✅ E2E tests |

---

## Addressing Concerns

Anticipated pushback from the client/mobile team, and honest answers.

### "You can't just extract our protocol code — it's too coupled"

We're not extracting their code. `@mentra/client` is built clean from the cloud side, referencing the protocol spec (`cloud/packages/types/`, `cloud/.architecture/architecture.md`). The mobile app's code (`SocketComms.ts`, `UdpManager.ts`) stays as-is until the mobile team chooses to migrate. No disruption, no forced timeline.

When they're ready, migration means: install `@mentra/client`, write a thin adapter that routes client events to `CoreModule` / Zustand stores, then delete `SocketComms.ts`. The adapter is just event listeners calling the same native methods they already call.

### "React hooks don't work in Node/Bun"

Correct. `@mentra/client` is pure TypeScript with no React dependency. It uses an event emitter / callback pattern:

```typescript
// @mentra/client — pure TS, works everywhere
client.on("display", (event) => { ... });
client.on("transcription", (event) => { ... });
```

The mobile app wraps these events however they want — Zustand stores, React hooks, whatever. `@mentra/client` doesn't impose a state management pattern. The mobile team keeps their Zustand stores and their React patterns. They just get events from a different source (`@mentra/client` instead of `SocketComms`).

This is the same split every cross-platform library uses. Axios doesn't use React hooks — `useSWR` wraps Axios with hooks. `@mentra/client` is the Axios. The mobile app's adapter is the `useSWR`.

### "We already have @mentra/webview-sdk — why reinvent it?"

We're not replacing it from scratch. `@mentra/webview-sdk` merges into `@mentra/react` — the capabilities it provides (WebView ↔ native communication for local mini apps) are combined with the existing React hooks for cloud-hosted webviews. One package for all webview contexts, whether the app is local or cloud-hosted. The mobile team's existing work is the foundation, not something we're discarding.

### "The mobile app handles way more than just protocol"

True. `SocketComms` does protocol + orchestration (permission checks, native routing, state updates, error handling). `@mentra/client` only handles protocol + session state. The orchestration stays in the mobile app — it's platform-specific code that belongs there.

What `@mentra/client` saves them: no more hand-maintaining the WebSocket handshake, message serialization, UDP packet framing, encryption, reconnection logic, and session state machine. That's the hard, bug-prone part that should be written once and shared.

### "UDP audio is native, not JS"

The audio capture and LC3 encoding are native and stay native. `@mentra/client`'s UDP layer handles packet framing (the `[userIdHash(4) | seq(2) | nonce(24) | ciphertext]` format) and encryption (XSalsa20-Poly1305). The mobile app feeds raw audio bytes into `client.sendAudio(pcmChunk)` — same as today where native code feeds bytes into `UdpManager.sendAudio()`.

The platform adapter for UDP:
- In React Native: wraps `react-native-udp` (what they already use)
- In Node/Bun: wraps `dgram` / `Bun.udpSocket`

The adapter is ~20 lines. It's just `send(host, port, buffer)` and `onMessage(callback)`. The framing, encryption, and sequencing logic is pure TypeScript in `@mentra/client` and doesn't change per platform.

### "Platform adapters sound like a maintenance nightmare"

There are three adapters total:

| Adapter | RN implementation | Node/Bun implementation |
|---|---|---|
| WebSocket | RN's built-in `WebSocket` | `ws` / `Bun.WebSocket` |
| UDP | `react-native-udp` | `dgram` / `Bun.udpSocket` |
| HTTP | `fetch` (built-in) | `fetch` (built-in) |

Each adapter is a thin interface (~20-30 lines) that wraps a platform-specific socket with `send()`, `onMessage()`, `close()`. The protocol logic, message parsing, encryption, reconnection — all of that is in the shared TypeScript core. The adapters are trivial.

We provide default adapters for RN and Node/Bun. The mobile team doesn't write or maintain adapters. They just pass `{ platform: "react-native" }` and get the right defaults.

### "We don't want to depend on a package the cloud team maintains"

Fair concern. Options:

1. **Shared ownership.** `@mentra/client` lives in the monorepo. Both teams contribute and review. Breaking changes require both teams' approval.
2. **Cloud builds it, mobile validates it.** Cloud team writes and maintains the library. Mobile team has a test suite that validates it works with their app. If a cloud change breaks their tests, it doesn't ship.
3. **API stability contract.** We version `@mentra/client` with semver. The mobile app pins to a version. Breaking changes only in major versions, with migration guides.

Recommendation: option 2 for now (cloud builds, mobile validates), evolve to option 1 as the library matures.

### "Show us it works first"

This is the right ask. Phase 1 is: build `@mentra/client`, build the test harness, demonstrate a simulated user connecting to the real cloud and running a test mini app end to end. No mobile app changes required. Once that works, the mobile team can evaluate it on their own timeline.

---

## Open Questions

| # | Question | Notes |
|---|---|---|
| 1 | **Local app runtime model** | Three options documented above: (A) keep-alive WebView + native HTTP server, (B) separate Hermes JS runtime + optional WebView, (C) hybrid — start with A, add B later. Recommendation is A for v1. Needs alignment with head of client. |
| 2 | **JS engine for local runtime** | Option A uses the WebView's JS engine (JavaScriptCore on iOS, V8 on Android) — no extra engine needed. Option B uses Hermes (already in RN, bytecode precompilation, JSI). Option A is simpler here. |
| 3 | **OEM auth model** | Opaque (API key + externalUserId with lazy provisioning) vs. token exchange (OAuth-style). Both designed above. Start with opaque for v1. |
| 4 | **Where to build `@mentra/client`** | `cloud/packages/cloud-client/` (directory already exists) or `cloud/packages/client/`. Preference? |
| 5 | **OEM BLE abstraction** | Designed: `@mentra/glasses` defines the `Glasses` interface with managers (display, camera, mic, led, device). OEMs implement `GlassesModelDriver` for custom BLE protocols. The `Glasses` interface is the contract — `@mentra/client` consumes it via `client.glasses.attach(glasses)`. |
| 6 | **App sandboxing** | Downloaded JS bundles running locally need permission enforcement. How strict? What can they access? |
| 7 | **Concurrent local apps** | Can multiple mini apps run simultaneously on-device? How do they share the display? (Same question as cloud apps — the OS dashboard already handles this.) |
| 8 | **iOS App Store review** | Apple allows OTA JS execution (React Native, CodePush). But downloading and running arbitrary third-party JS bundles is a grayer area. Needs verification. |
| 9 | **Audio format for OEMs** | Do OEMs send PCM16 like us, or do we support other formats? What if their glasses use a different codec? |
| 10 | **Auth provider for Mentra direct users** | Current Supabase/Authing may not be the long-term answer. WorkOS, Clerk are alternatives. This is independent of OEM auth design and can be decided separately. |
| 11 | **Raw audio access for mini apps** | Apps that need audio processing (custom ASR, emotion detection) should get audio routed to their `server/` code via the cloud SFU — not in the WebView. `session.mic.onChunk()` would only be available in `server/` context. Needs design. |
| 12 | **Mini app framework details** | Convention-based project structure (`client/`, `webview/`, `server/`, `shared/`), typed RPC across boundaries, `state` sync, build pipeline. Needs its own spike once the client library foundation is solid. |

---

## Related Documents

| Document | Purpose |
|---|---|
| **Explorable examples** | |
| [examples/miniapp-example/](../../../../../examples/miniapp-example/) | Mock mini app showing the framework DX: `client/`, `webview/`, `server/`, `shared/` |
| [examples/oem-example/](../../../../../examples/oem-example/) | Mock OEM monorepo: mobile app, mock SDKs, E2E tests with simulated glasses |
| **Prior planning** | |
| [client-sdk-spike.md](../../048-sdk-v3/archive/client-sdk-spike.md) | Detailed spike: Hermes runtime, JSI bridge, bundle loading, on-device transcription, MentraJS framework |
| [on-device architecture draft](../drafts/plans/puddle-architecture.md) | On-device runtime: three-process model, cloud-as-SFU, app distribution, OEM/white-label, sequencing |
| [cloud-testing.md](./cloud-testing.md) | Testing plan: MentraClient, test mini app, E2E harness, CI |
| [testing-plan.md](../drafts/testing/testing-plan.md) | Comprehensive testing plan with sequencing and open questions |
| [mobile-client.md](../drafts/testing/clients/mobile-client.md) | Mobile client protocol map: every transport, message type, flow, failure mode |
| [sdk-miniapp.md](../drafts/testing/clients/sdk-miniapp.md) | Mini app server protocol map: webhooks, WebSocket messages, REST endpoints |
| [mentra-ai-mcp-redesign.md](../../../../docs/architecture/mentra-ai-mcp-redesign.md) | AI tool system redesign: Mastra + MCP, cloud as tool aggregator |
| [039 API map](../../039-sdk-v3-api-surface/) | SDK v3 API surface: v2→v3 mapping |
| [048 SDK v3](../../048-sdk-v3/) | SDK v3 issue: implementation status, architecture decisions |
