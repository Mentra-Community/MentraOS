# Spike: Client SDK — Local Runtime on Mobile

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md)
**Status:** Spike / Brainstorm
**Date:** 2026-03-17

---

## Overview

**What this doc covers:** How to run MentraOS mini apps locally on the phone — same `MentraSession` API, no cloud round-trip — including JS engine options, native bindings, bundle loading, background execution, and app distribution.

**What this doc does NOT cover:** The SDK v3 refactor itself (see [spike.md](./spike.md)). This doc assumes `MentraSession` exists with a `Transport` interface and zero server dependencies.

**Why this matters:** Today, every app round-trips through the cloud: glasses → cloud → app server → cloud → glasses. A captions app shouldn't need internet to display live transcription when the phone can transcribe locally. Local apps unlock offline operation, lower latency, and new categories of apps that need real-time response.

---

## JS Engine Options

### The candidates

| Engine                   | Already in RN?                       | Background?            | Size                            | iOS     | Android | Notes                                                                   |
| ------------------------ | ------------------------------------ | ---------------------- | ------------------------------- | ------- | ------- | ----------------------------------------------------------------------- |
| **Hermes**               | ✅ Default since RN 0.70             | ✅ Yes (native thread) | ~3MB                            | ✅      | ✅      | Bytecode precompilation for instant startup. Meta-maintained.           |
| **JavaScriptCore (JSC)** | ✅ On iOS (system), optional Android | ✅ Yes                 | 0 (iOS system) / ~5MB (Android) | ✅      | ✅      | iOS ships it; Android needs a bundled copy.                             |
| **QuickJS**              | ❌ Must embed                        | ✅ Yes                 | ~210KB                          | ✅      | ✅      | Tiny, embeddable C library. Full ES2023. Used in embedded systems.      |
| **V8 (react-native-v8)** | ❌ Optional                          | ✅ Yes                 | ~8MB                            | ❌ Poor | ✅      | Overkill for this use case. iOS support is weak.                        |
| **Node.js Mobile**       | ❌ Separate binary                   | ✅ Yes                 | ~20MB                           | ✅      | ✅      | Full Node API but extremely heavy. `nodejs-mobile-react-native` exists. |

### Recommendation: Hermes

**Hermes is the clear winner.** Reasons:

1. **Already bundled.** React Native uses Hermes as its default engine. The binary is already in the app. No additional size cost.

2. **Bytecode precompilation.** Hermes can compile JS to `.hbc` (Hermes bytecode) files ahead of time. First-run startup is near-instant — no parsing needed. The app store CDN could serve precompiled `.hbc` files.

3. **JSI (JavaScript Interface).** Hermes uses JSI for its native bridge — synchronous, zero-serialization C++ calls between JS and native. This is how we'd expose `session.display.showText()` as a native call that sends a Bluetooth command to the glasses with no async overhead.

4. **Separate context isolation.** We can create a dedicated Hermes runtime instance for mini apps, separate from the main RN UI thread. If a mini app crashes, the MentraOS UI stays alive. Similar to Chrome's V8 isolates per tab.

5. **Meta-maintained, actively developed.** Not going anywhere.

### Why not the others?

- **JSC:** Good on iOS (system library, free), but on Android you have to bundle it separately. Hermes is already there on both platforms. No bytecode precompilation.
- **QuickJS:** Incredibly small and fast, but we'd have to build and maintain the native module integration ourselves. Hermes gives us this for free via RN's existing infrastructure.
- **V8:** Too heavy, iOS support is poor, and we don't need its JIT — Hermes's AOT bytecode is better for mobile startup.
- **Node.js Mobile:** 20MB binary for full Node API. We don't need `fs`, `http`, `net`, etc. Our session layer is pure JS.

---

## Background Execution

Running JS in the background on mobile is the hardest problem. Both iOS and Android aggressively kill background processes to save battery.

### How MentraOS gets around this

**MentraOS is a Bluetooth accessory app.** Both iOS and Android grant extended background execution rights to apps that maintain active Bluetooth connections:

- **iOS:** `UIBackgroundModes: bluetooth-central` and `bluetooth-peripheral` in Info.plist. The app stays alive as long as the BLE connection to the glasses is active. Core Bluetooth framework handles reconnection.
- **Android:** Foreground Service with `FOREGROUND_SERVICE_CONNECTED_DEVICE` type. The notification tray shows "MentraOS is connected to your glasses." The process stays alive.

The mini app JS runtime runs in the same process as the MentraOS app. It stays alive as long as the Bluetooth connection does — which is always, while the user is wearing glasses.

### Execution model

```
MentraOS App Process
├── Main Thread (React Native UI)
│   └── App management, settings screens, etc.
│
├── MentraOS Runtime Thread (native)
│   ├── Hermes JS Engine Instance (dedicated)
│   │   ├── Mini App A bundle
│   │   ├── Mini App B bundle
│   │   └── ...
│   │
│   └── JSI Bindings → Native APIs
│
├── Bluetooth Thread (already exists)
│   └── BLE connection to glasses
│
└── Audio Thread (already exists)
    └── Mic input processing
```

The Runtime Thread is a native thread (not the RN JS thread) that hosts its own Hermes instance. Mini app bundles are loaded into this instance. JSI bindings expose native capabilities (Bluetooth, GPS, audio, etc.) as synchronous calls from JS.

**Key: the mini app Hermes instance is separate from the RN UI Hermes instance.** They share no state. Communication between them (if needed) goes through native modules, not JS globals.

---

## SDK is TypeScript — Only the Transport is Native

A key architectural clarification: **the SDK (`@mentra/sdk/session`) is written entirely in TypeScript.** `MentraSession`, `TranscriptionManager`, `DisplayManager`, all the managers — all TypeScript. It gets bundled into the mini app's JS bundle by Bun and runs inside the Hermes context just like any other JS code.

The only native part is the **transport** — a thin pipe that sends and receives message strings. Everything else (parsing messages, routing to managers, maintaining state, capability checks, subscription logic) lives in the TypeScript SDK.

```
What's TypeScript (bundled with the app):
  MentraSession           — thin orchestrator
  TranscriptionManager    — handles transcription events, capabilities
  TranslationManager      — handles translation events
  DisplayManager          — display commands, text wrapping
  SpeakerManager          — audio output
  MicManager              — audio input
  DeviceManager           — hardware events, WiFi, capabilities
  PhoneManager            — notifications, calendar, battery
  LocationManager         — GPS
  ... all other managers, all event handling, all state

What's native (provided by phone runtime, injected as a global):
  globalThis.__mentraTransport — just send(string) and onMessage(callback)
  That's it. One object. Two functions.
```

### How the transport bridge works

The phone runtime, before loading any mini app bundle, injects a native transport object as a global:

```typescript
// Phone runtime (native, C++ via JSI) does this before loading the bundle:
globalThis.__mentraTransport = {
  send(data: string): void {
    /* routes to BLE, Sherpa, GPS, etc. */
  },
  onMessage(handler: (data: string) => void): void {
    /* native → JS events */
  },
  onClose(handler: (code: number, reason: string) => void): void {
    /* glasses disconnect */
  },
  close(): void {
    /* cleanup */
  },
  readyState: 1, // "open" while glasses connected
};
```

The SDK picks this up on initialization:

```typescript
// Inside @mentra/sdk/session — TypeScript, bundled with the app
class NativeBridgeTransport implements Transport {
  private bridge = globalThis.__mentraTransport;

  send(data: string) {
    this.bridge.send(data);
  }
  onMessage(handler: (data: string) => void) {
    this.bridge.onMessage(handler);
  }
  onClose(handler: (code: number, reason: string) => void) {
    this.bridge.onClose(handler);
  }
  close() {
    this.bridge.close();
  }
  get readyState() {
    return this.bridge.readyState;
  }
}
```

**The developer never sees any of this.** They import `@mentra/sdk/session`, it bundles normally via Bun, and the SDK internally detects whether it's running on a server (WebSocket available) or on a phone (native transport global available).

### What the native transport routes to

The native side receives message strings (same protocol as the cloud WebSocket) and routes them:

| Message type                         | Native action                                |
| ------------------------------------ | -------------------------------------------- |
| `DisplayRequest`                     | BLE write to glasses display characteristic  |
| `SubscriptionUpdate` (transcription) | Start/stop Sherpa-ONNX or cloud Soniox       |
| `SubscriptionUpdate` (location)      | Start/stop CoreLocation / FusedLocation      |
| `AudioPlayRequest`                   | Download audio, stream via BLE audio channel |
| `PhotoRequest`                       | BLE camera command to glasses                |

And in the other direction, native sends messages TO the SDK:

| Native event                       | Message sent to SDK                  |
| ---------------------------------- | ------------------------------------ |
| Transcription result (Sherpa-ONNX) | `DataStream` with transcription data |
| Button press (BLE)                 | `DataStream` with button event       |
| Location update (GPS)              | `DataStream` with location data      |
| Phone notification                 | `DataStream` with notification data  |
| Battery update (BLE)               | `DataStream` with battery level      |

Same message types as the cloud WebSocket. The SDK TypeScript code processes them identically.

---

## Bundle Loading & Caching

### How bundles get onto the phone

**Store path (recommended):**

1. Developer submits bundle to MentraOS dev console
2. We compile to Hermes bytecode (`.hbc`) on our build servers
3. Host on CDN (fast, globally cached)
4. Phone downloads on app install
5. Cached in app sandbox — works offline after first download
6. Version check on app launch (or periodic background check)

**Self-host / sideload path (development):**

1. Developer runs `mentra dev` — starts local dev server
2. Phone fetches raw JS from developer's URL (ngrok / local network)
3. Hermes executes raw JS directly (no `.hbc` needed in dev — slower first parse but works)
4. Hot reload on save

### Update model

Like a PWA with service workers:

1. On app launch, check the bundle URL for a new version (ETag / Last-Modified / version.json)
2. If unchanged → use cached bundle immediately (instant startup)
3. If changed → download new bundle in background
4. Swap on next app launch (not mid-session — avoid runtime inconsistency)
5. Rollback: keep the previous bundle in case the new one crashes on startup

### Bundle format (output of `mentra build`)

```
dist/
├── manifest.json           # Package name, version, permissions, entry points
├── session.hbc             # Hermes bytecode — the always-on glasses logic
├── session.js              # Source JS fallback (if .hbc version mismatch)
└── webview/                # Optional — phone companion UI (only if webview/ source exists)
    ├── index.html
    └── bundle.js
```

```json
// manifest.json
{
  "packageName": "com.example.captions",
  "version": "1.2.0",
  "session": "session.hbc",
  "webview": "webview/index.html",
  "permissions": ["microphone", "display"],
  "minOsVersion": "2.0.0"
}
```

### Security

Bundles from the store are signed with our key. The phone verifies the signature before loading. Self-hosted bundles in dev mode skip verification (but show a "dev mode" indicator in the UI).

Bundles run in a sandboxed Hermes context — no access to the filesystem, network, or native APIs beyond what the native transport exposes. The permission system (from `manifest.json`) controls which native capabilities are available to the transport.

---

## App Lifecycle

### How a local app starts

```
1. User opens MentraOS app (or glasses connect automatically)
2. MentraOS reads installed apps from local DB
3. For each app marked "auto-start":
   a. Inject globalThis.__mentraTransport (native bridge)
   b. Load cached bundle into Hermes runtime
   c. Bundle includes @mentra/sdk/session (TypeScript, bundled by Bun)
   d. SDK detects native transport, creates MentraSession internally
   e. Runtime calls the app's exported onSession(session)
4. App is now running — receiving events, sending display commands
```

### How a local app's entry point looks

```typescript
// session/index.ts — compiled to session.hbc
import { MentraSession } from "@mentra/sdk/session";

// The runtime calls this when the session is ready
export default function onSession(session: MentraSession) {
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });
}

// Optional: called when the session ends (glasses disconnect, app stopped)
export function onStop(session: MentraSession) {
  console.log("bye");
}
```

This is the same pattern as cloud apps:

```typescript
// Cloud app (for comparison)
const app = new MentraApp({ packageName: "...", apiKey: "..." });

app.onSession((session) => {
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });
});
```

The only difference: cloud apps use `MentraApp` (Hono server that creates sessions from webhooks). Local apps export `onSession` and the phone runtime calls it directly. The `MentraSession` class and all managers are the same TypeScript code in both cases — only the transport differs.

---

## On-Device Transcription

### Current state

MentraOS **already has local transcription** via **Sherpa-ONNX**. It works — English edge quality is "pretty good" per Cayden (audio lead). The main problem isn't the model, it's the **spaghetti code**: local captions is the only offline mini app that uses the mic, and it's deeply intertwined with the rest of the mobile app. Every client change risks breaking it.

Captions 3.0 is being planned (Isaiah + Matt + Israelov meeting Wednesday) to add online/offline switching and clean up the spaghetti. The local runtime architecture in this spike is the long-term fix — if local captions ran as a proper mini app with `MentraSession`, it wouldn't be entangled with the rest of the mobile app.

### Engine options

| Engine                      | Status                | Streaming? | Quality (WER)    | Notes                                                                                                    |
| --------------------------- | --------------------- | ---------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| **Sherpa-ONNX**             | ✅ Already integrated | ✅ Yes     | Good for English | Current production local engine. ONNX runtime, multiple model support.                                   |
| **Soniox (cloud)**          | ✅ Already integrated | ✅ Yes     | Best (~0.05 WER) | Rich data: diarization, language detection, word timestamps, confidence.                                 |
| **Cactus Compute**          | ❓ Evaluating         | ❓ Unknown | Varies by model  | Third-party edge SDK. Supports Whisper, Moonshine, Parakeet. NPU support. Founders actively pitching us. |
| **Apple Speech Framework**  | Not integrated        | ✅ Yes     | Good             | iOS only. Free, zero download. Limited languages.                                                        |
| **Google on-device Speech** | Not integrated        | ✅ Yes     | Good             | Android only. ~50MB per language.                                                                        |

**Cactus Compute** is interesting — their benchmark shows NVIDIA Parakeet-CTC-0.6b at 0.093 WER with NPU acceleration and 5M+ decode tokens/sec. But Cayden's concern: "not sure if any of these are streaming." Batch benchmarks don't guarantee real-time streaming works. Needs hands-on testing before any decision.

**Current recommendation:** Keep Sherpa-ONNX as the edge engine. Evaluate Cactus as a potential upgrade path. The architecture below supports swapping engines transparently — the mini app developer never knows which engine is running.

### The data shape problem

This is the critical design challenge. Soniox gives us rich transcription data:

```typescript
// What Soniox provides (cloud):
{
  text: "Hello everyone",
  isFinal: true,
  language: "en",              // ✅ auto-detected
  speakerId: "1",              // ✅ diarization
  utteranceId: "utt_42",       // ✅ utterance grouping
  confidence: 0.97,            // ✅ per-segment
  startTime: 1200,             // ✅ word-level timestamps
  endTime: 1850,               // ✅
  metadata: { /* token-level */ }
}
```

Sherpa-ONNX running locally provides much less:

```typescript
// What Sherpa-ONNX provides (local):
{
  text: "Hello everyone",
  isFinal: true,
  language: undefined,          // ❌ no auto-detect (single-language model)
  speakerId: undefined,         // ❌ no diarization
  utteranceId: "utt_7",        // ✅ from VAD segmentation layer
  confidence: undefined,        // ❌ not surfaced by most models
  startTime: undefined,         // ⚠️ depends on model
  endTime: undefined,           // ⚠️ depends on model
  metadata: undefined
}
```

**If a developer writes code that relies on `speakerId` for a multi-person view, and the user goes offline, `speakerId` silently becomes `undefined`. Their app doesn't crash — it just shows wrong UI.**

### Solution: TranscriptionCapabilities

Every field on `TranscriptionEvent` stays optional. The developer queries capabilities to know what's available from the current backend:

```typescript
interface TranscriptionCapabilities {
  /** Can detect the spoken language automatically. */
  languageDetection: boolean;

  /** Can identify different speakers. */
  diarization: boolean;

  /** Provides word-level start/end timestamps. */
  wordTimestamps: boolean;

  /** Provides per-segment confidence scores. */
  confidence: boolean;

  /** Which languages the current engine supports. */
  supportedLanguages: string[];

  /** Whether the engine is running locally or in the cloud. */
  local: boolean;
}
```

Usage:

```typescript
export default function onSession(session: MentraSession) {
  // Always works — text and isFinal are always present
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });

  // Check capabilities before relying on optional fields
  const caps = session.transcription.capabilities;

  if (caps.diarization) {
    session.transcription.on((data) => {
      if (data.speakerId) {
        showSpeakerLabel(data.speakerId, data.text);
      }
    });
  }

  // React to capability changes (e.g., network drops, switch to local)
  session.transcription.onCapabilitiesChange((newCaps) => {
    if (!newCaps.diarization) {
      // Switched to local model — hide speaker labels
      hideSpeakerLabels();
    }
  });
}
```

### Capabilities by engine

| Capability           | Soniox (cloud) | Sherpa-ONNX (local) | Cactus (TBD) | Apple Speech | Google on-device |
| -------------------- | -------------- | ------------------- | ------------ | ------------ | ---------------- |
| `languageDetection`  | ✅             | ❌                  | ❓           | ❌           | ❌               |
| `diarization`        | ✅             | ❌                  | ❓           | ❌           | ❌               |
| `wordTimestamps`     | ✅             | ⚠️ model-dependent  | ❓           | ✅           | ✅               |
| `confidence`         | ✅             | ⚠️ model-dependent  | ❓           | ✅           | ✅               |
| `supportedLanguages` | 50+            | 1–3 per model       | varies       | ~20          | ~50              |
| `local`              | ❌             | ✅                  | ✅           | ✅           | ✅               |

### Same pattern for TranslationCapabilities

Translation has the same problem — cloud translation (Soniox) gives you source language detection and multiple simultaneous targets. Local translation (if we ever add it) would be more limited. The `TranslationCapabilities` pattern is identical:

```typescript
interface TranslationCapabilities {
  sourceDetection: boolean; // can auto-detect source language?
  supportedPairs: string[][]; // [["en", "es"], ["en", "ja"], ...]
  simultaneousTargets: number; // how many targets at once? Soniox: many, local: 1
  local: boolean;
}
```

### The contract

**Guaranteed fields (always present):**

- `text: string` — the transcribed/translated text
- `isFinal: boolean` — interim vs final

**Optional fields (depend on capabilities):**

- `language`, `speakerId`, `utteranceId`, `confidence`, `startTime`, `endTime`, `metadata`

**The developer's rule:** If you use an optional field, check capabilities first (or handle `undefined`). The SDK could even log a warning in dev mode: "You're accessing `data.speakerId` but `capabilities.diarization` is false — this will always be undefined with the current engine."

### Hybrid switching

The phone OS runtime can switch engines mid-session:

1. User is online → Soniox (cloud). Full capabilities.
2. Network drops → auto-switch to Sherpa-ONNX (local). Capabilities shrink.
3. `onCapabilitiesChange` fires. Developer adapts UI.
4. Network returns → auto-switch back to Soniox. Capabilities restore.
5. `onCapabilitiesChange` fires again.

The `TranscriptionEvent` shape never changes — only which fields are populated. The developer's `on()` handler keeps running through the switch. No re-subscription needed.

---

## Hybrid Apps: Local + Cloud

A mini app doesn't have to be 100% local or 100% cloud. It can be hybrid:

- **Low-latency features run locally:** display updates, camera capture, audio playback, button responses
- **Heavy features hit the cloud:** LLM inference, complex transcription (rare languages), RTMP streaming, server-side storage

Example: an AI assistant app that shows live captions locally (Whisper) but sends the transcript to an LLM in the cloud for responses:

```typescript
export default function onSession(session: MentraSession) {
  // Local: real-time captions via on-device Sherpa-ONNX
  session.transcription.on((data) => {
    session.display.showText(data.text);

    if (data.isFinal) {
      // Cloud: send to LLM for a response
      askCloudLLM(data.text).then((response) => {
        session.speaker.speak(response);
      });
    }
  });
}

async function askCloudLLM(text: string): Promise<string> {
  const res = await fetch("https://api.example.com/chat", {
    method: "POST",
    body: JSON.stringify({ message: text }),
  });
  const data = await res.json();
  return data.reply;
}
```

**`fetch` is available in Hermes** — mini apps can make HTTP requests to their own servers. The SDK doesn't need to mediate this. The phone's network stack handles it normally.

---

## MentraJS Framework & Build Pipeline

### The vision

MentraJS is a framework for building glasses apps — like Next.js but for smart glasses. "Full-stack" means glasses logic + phone companion UI + background processing, all in one project, one language, one dev experience.

```
Next.js:
  Server code (API routes, SSR)  → runs on Node
  Client code (React components) → runs in browser
  One project, framework handles the boundary

MentraJS:
  Session code (glasses logic)   → runs in Hermes (background, always on)
  Webview code (phone UI)        → runs in webview (foreground, when visible)
  One project, framework handles the boundary
```

### Project structure

The framework uses a convention-based folder structure:

```
my-app/
├── mentra.config.ts           # package name, permissions, etc.
├── session/
│   └── index.ts               # entry point — runs in Hermes, always on
├── webview/                    # optional — not all apps need a phone UI
│   ├── index.html
│   └── App.tsx
├── shared/                    # optional — shared types/utils
│   └── types.ts
└── package.json
```

The simplest possible app — just live captions, no phone UI:

```
captions-app/
├── mentra.config.ts
├── session/
│   └── index.ts
└── package.json
```

Three files. That's it.

### Build pipeline

`mentra build` takes the source project and produces what the phone needs:

```
Source:                          Build:                         Output:
session/index.ts  ──→  bun build  ──→  session.js  ──→  hermesc  ──→  session.hbc
webview/App.tsx   ──→  bun build  ──→  webview/index.html + bundle.js
mentra.config.ts  ──→  generate   ──→  manifest.json
```

Steps:

1. **`bun build session/index.ts --outfile dist/session.js`** — bundles session code + `@mentra/sdk/session` into a single JS file. Pure JS, no Node/Bun APIs. The SDK is TypeScript — it bundles in normally.
2. **`bun build webview/`** (if exists) — bundles the web app into static HTML/CSS/JS assets.
3. **`hermesc dist/session.js -emit-binary -out dist/session.hbc`** — compile to Hermes bytecode for instant startup. (Skipped in dev mode.)
4. **Generate `dist/manifest.json`** from `mentra.config.ts`.

Output:

```
dist/
├── manifest.json
├── session.hbc          # Hermes bytecode (production)
├── session.js           # JS source (dev fallback)
└── webview/             # static web assets (if webview/ source exists)
    ├── index.html
    └── bundle.js
```

**Important:** `@mentra/sdk/session` is NOT externalized — it's bundled into `session.js` as normal TypeScript. The only thing the phone runtime provides is `globalThis.__mentraTransport`. The SDK detects it at initialization and uses it as the transport.

### CLI

```bash
mentra dev              # Start dev server, hot reload, phone loads raw JS
mentra build            # Production build → dist/
mentra publish          # Build + upload to MentraOS app store
```

**`mentra dev`:**

- Starts a local dev server (Bun)
- Watches `session/` and `webview/` for changes
- Phone connects, loads raw JS (no `.hbc` — Hermes can execute raw JS, just slower first parse)
- Hot reload on file save
- Both session logic and webview UI reload

**`mentra build`:**

- Bundles via Bun
- Compiles to `.hbc` via `hermesc` (the Hermes compiler, ~5MB binary — bundled with MentraJS CLI, or skip and let the app store compile)
- Generates manifest
- Output in `dist/`

**`mentra publish`:**

- Runs `mentra build`
- Uploads `dist/` to MentraOS app store
- Store can re-compile `.hbc` for different Hermes versions if needed
- Review process, signing, CDN distribution

### Session + Webview communication

For apps that have both `session/` and `webview/`, the framework provides a shared state bridge:

```typescript
// session/index.ts — runs in Hermes, always on
import { state } from "@mentra/sdk/session";

export default function onSession(session: MentraSession) {
  session.transcription.on((data) => {
    // Update shared state — webview sees this when active
    state.set("lastTranscript", data.text);
    state.set("language", data.language);

    session.display.showText(data.text);
  });

  // React to webview actions
  state.on("settingsChanged", (newSettings) => {
    session.transcription.configure({
      languageHints: [newSettings.preferredLanguage],
    });
  });
}
```

```tsx
// webview/App.tsx — runs in webview, only when phone screen is on
import { useMentraState } from "@mentra/sdk/webview";

function App() {
  const lastTranscript = useMentraState("lastTranscript");
  const language = useMentraState("language");

  return (
    <div>
      <h1>Live Captions</h1>
      <p>{lastTranscript}</p>
      <p>Detected: {language}</p>
      <SettingsPanel />
    </div>
  );
}
```

The framework handles the bridge between the Hermes runtime and the webview (native module syncs state when webview is active). The developer just reads and writes shared state — no manual `postMessage` wiring.

### Same code, two deployment targets

The same `session/index.ts` code works as both a local app and a cloud app:

```bash
mentra build            # produces dist/ for phone (local app)
mentra build --cloud    # produces a MentraApp server deployment
```

For `--cloud`, the build wraps the session code in a `MentraApp` (Hono server) that creates `MentraSession` instances from webhooks with `WebSocketTransport`. The session code is unchanged — only the host environment differs.

---

## What Needs to Exist on the Mobile Side

This is a rough breakdown of the native work needed to support local apps:

### Native modules to build

The native side is thin — it implements the transport bridge and routes messages to platform APIs:

| Module                  | Purpose                                                                  | Complexity | Notes                                                                    |
| ----------------------- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| **MentraRuntime**       | Hermes instance management, `__mentraTransport` injection, lifecycle     | High       | Core of the system. Manages app contexts, loads bundles.                 |
| **NativeTransport**     | The `globalThis.__mentraTransport` implementation — `send` + `onMessage` | High       | Routes message strings to/from native. Single object, two key functions. |
| **DisplayRouter**       | Receives DisplayRequest messages from transport, sends via BLE           | Medium     | Already partially exists in mobile.                                      |
| **AudioRouter**         | Mic input (BLE → transport) and speaker output (transport → BLE)         | Medium     | Already exists in mobile for cloud audio path.                           |
| **CameraRouter**        | BLE camera commands + receives photo data                                | Medium     | Already exists in mobile for cloud photo path.                           |
| **TranscriptionRouter** | Sherpa-ONNX / Soniox → DataStream messages into transport                | Medium     | Already exists in mobile. Needs capability normalization layer.          |
| **SensorRouter**        | Location, notifications, calendar → DataStream messages                  | Low        | Already piped to cloud today. Reformat as transport messages.            |
| **StorageRouter**       | Per-app sandboxed key-value storage                                      | Low        | SQLite or MMKV.                                                          |
| **BundleLoader**        | Download, cache, verify, and load bundles                                | Medium     | HTTP client + file cache + signature verification.                       |

This work is parallel to the SDK v3 refactor. The SDK v3 refactor produces the `MentraSession` + `Transport` interface that the mobile runtime consumes. The mobile work builds the native side that implements that interface.

---

## Alignment with Head of Client

**Critical:** The head of client is reportedly building something on the mobile side for local apps. If they design their own session management with different method names, different event patterns, different manager structure — we end up with two SDKs that do the same thing differently.

**The contract is `MentraSession` + `Transport`.**

- The SDK team (this spike) defines `MentraSession`, the managers, the message types, and the `Transport` interface.
- The mobile team implements `NativeBridgeTransport` and the native modules that fulfill the JSI bindings.
- Both teams use the same message protocol. A `DataStream` with transcription data looks identical whether it came from cloud Soniox or on-device Whisper. A `DisplayRequest` is the same over WebSocket or JSI bridge.

**Action item:** Share this spike + the SDK v3 spike with the head of client. Align on `MentraSession` as the shared contract before either team builds further.

---

## Open Questions

| #   | Question                                      | Notes                                                                                                                                                                                                         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Hermes context isolation**                  | Can we run multiple mini app bundles in a single Hermes instance (separate realms), or do we need one Hermes instance per app? Separate instances are safer but heavier.                                      |
| 2   | **JSI bindings for `fetch`**                  | Does Hermes in a standalone context (not RN) have `fetch` built in? Or do we need to polyfill it via JSI? Need to test.                                                                                       |
| 3   | **Hermes bytecode versioning**                | Hermes bytecode format changes between versions. If we precompile on the server, we need to match the Hermes version on the phone. How do we handle version mismatches? Fallback to raw JS?                   |
| 4   | **App sandboxing**                            | How strict is the sandbox? Can a mini app `import` anything, or only what the runtime provides? Should we whitelist specific modules?                                                                         |
| 5   | **Memory limits**                             | What's the memory budget per mini app? Hermes contexts are lightweight but transcription models are not. Need to measure.                                                                                     |
| 6   | **Hot reload for development**                | Can we support Metro-like hot reload for local app development? Hermes supports HMR in the RN context — does it work in a standalone context?                                                                 |
| 7   | **Multi-app concurrency**                     | Can multiple mini apps run simultaneously? If so, how do they share the display? Priority system? (Same question as cloud apps — the OS dashboard already handles this.)                                      |
| 8   | **`whisper.rn` production readiness**         | The `whisper.rn` package exists but how production-ready is it? Battery impact? Thermal throttling? Need benchmarks on target devices.                                                                        |
| 9   | **iOS App Store review**                      | Will Apple approve an app that downloads and executes arbitrary JS bundles? This is what React Native already does (CodePush, OTA updates). But it's worth verifying our specific use case won't get flagged. |
| 10  | **Shared vs. dedicated Bluetooth connection** | The main MentraOS app already has a BLE connection to the glasses. Does the mini app runtime share this connection, or does it open its own? Sharing is more efficient; dedicated is more isolated.           |
