# Puddle Architecture: Local Mobile Mini-App SDK

## Overview

This doc proposes the architecture for running mini apps locally on the user's phone instead of on a remote server. The phone becomes the runtime, the cloud becomes an SFU (selective forwarding unit) for audio and transcription, and mini apps download from the app store and run on-device.

This is not a Q2 deliverable. It's a proposal capturing the architectural direction so the team (cloud, client, leadership) has a shared reference. The goal is to show that the groundwork has already been laid in SDK v3 and to propose a concrete architecture before implementation begins.

**Why this doc exists:** Other companies want to use MentraOS with their own hardware. They need mini apps that run locally. The CTO is aligned on direction. The head of client has ideas. This doc captures the cloud team's proposal based on deep understanding of the SDK internals, wire protocol, and session model.

**Target timeline:** June/July 2026, ahead of OEM partner launches.

## The Problem

Today, every mini app runs on a remote server. The flow is:

```
Glasses -> BLE -> Phone -> WebSocket -> Cloud -> WebSocket -> Developer's Server
```

Every event, every display update, every audio chunk goes through the cloud. This means:

- **Latency.** Display updates round-trip through the internet.
- **Fragility.** If the cloud crashes, every user loses every app.
- **Cost.** Every app session is a WebSocket connection the cloud must manage.
- **Dependency.** Developers must host a server. Casual developers and AI agents can't just "make an app" without deployment infrastructure.
- **Third-party blockers.** OEM partners can't ship MentraOS-compatible glasses without depending on our cloud for every app interaction.

## The Vision

Three processes on the phone. One new role for the cloud.

### On the phone

**1. The Puddle** (native or React Native layer)

The Puddle is the local cloud. It does for one user what the cloud does today for all users:

- Manages the user's session
- Tracks app sessions and their subscriptions
- Routes events between apps, glasses, and the cloud
- Handles app lifecycle (start, stop, reconnect)
- Communicates with glasses over BLE
- Communicates with the cloud over WebSocket/UDP for audio and transcription

The Puddle is the platform layer. Apps don't talk to the cloud directly. They talk to the Puddle.

**2. JS Virtual Environment** (per app)

Each downloaded mini app runs in its own sandboxed JavaScript process. This is the equivalent of the developer's server today. The app code is the same code a developer would write for the cloud SDK, but it runs locally.

The JS venv talks to the Puddle via inter-process communication (the "PuddleTransport"). It does not have direct access to BLE, the network, or other apps. It gets events from the Puddle and sends commands back to the Puddle, same as a cloud-hosted app gets events from the cloud and sends commands back.

The JS venv can still make network requests (REST APIs, AI services, etc.) just like any JavaScript process. The difference is it doesn't need a remote server to run the SDK logic.

**3. Webview** (per app, optional)

The app's UI. Renders in a webview. Communicates with the app's JS venv through the Puddle, using the same `useMentraSession` pattern that exists today for React webviews.

The webview does not need to be open for the app to run. The JS venv is the always-running process. The webview is the optional UI layer, same as today where the SDK's AppServer runs independently of the webview.

### The cloud (SFU)

The cloud's role shrinks to:

- **Audio streaming.** UDP audio from the phone to the cloud for transcription/translation (Soniox). Most apps want transcription, and running Soniox locally isn't practical.
- **Transcription/translation delivery.** Cloud processes audio, sends results back to the phone. The Puddle routes them to subscribed apps.
- **App store and registry.** App discovery, download, updates. Developers submit apps, users browse and install.
- **Read-only subscription replica.** The cloud knows what each user's apps are subscribed to so it can efficiently route transcription results. But the source of truth for subscriptions is the Puddle, not the cloud.
- **Optional relay for cloud-hosted apps.** Cloud-hosted mini apps (the current model) still work. The Puddle can talk to both local JS venvs and remote servers. This is backward compatible.

## How the SDK Makes This Possible

SDK v3 was designed for this. The key architectural decisions:

### Transport abstraction

`MentraSession` depends on a `Transport` interface, not WebSocket directly.

```
Required transport interface:
- send JSON text
- send binary data
- emit incoming text
- emit incoming binary
- emit close
- emit error
- expose ready state
```

Today there's `WebSocketTransport`. For local apps, we create `PuddleTransport` that uses inter-process communication instead of WebSocket. The entire session API, all 14 managers, subscriptions, routing, lifecycle, all work unchanged.

Reference: `cloud/issues/048-sdk-v3/private-runtime-architecture.md`, Transport Boundary section.

### Subscription model is declarative

Subscriptions are derived from handler registrations, not manually maintained state. When an app calls `session.transcription.on(callback)`, the subscription is automatically tracked. This means the Puddle can reconstruct subscriptions for any app at any time without the app explicitly managing them.

### Reconnection model supports transport swaps

The v3 lifecycle model (connected, running, transport down, reconnected, stopped) means a transport blip doesn't kill the session. Handlers, state, and subscriptions are preserved. This is critical for the Puddle because inter-process communication on a phone can be interrupted (app backgrounding, memory pressure, etc.) and the session needs to survive.

### Message routing is registry-based

Messages are routed through a `_MessageRouter` with a `MessageHandlerRegistry` and `DataStreamRouter`. No giant conditional chains. This means the same routing logic works regardless of where the messages come from (cloud WebSocket, Puddle IPC, or anything else).

## Architecture Diagram

```
Phone
+-----------------------------------------------+
|                                               |
|  +----------+  +----------+  +----------+    |
|  | Webview  |  | Webview  |  | Webview  |    |
|  | (App A)  |  | (App B)  |  | (App C)  |    |
|  +----+-----+  +----+-----+  +----+-----+    |
|       |              |              |          |
|  +----+-----+  +----+-----+  +----+-----+    |
|  | JS venv  |  | JS venv  |  | JS venv  |    |
|  | (App A)  |  | (App B)  |  | (App C)  |    |
|  +----+-----+  +----+-----+  +----+-----+    |
|       |              |              |          |
|       +--------------+--------------+          |
|                      |                         |
|               +------+------+                  |
|               |   Puddle    |                  |
|               | (platform)  |                  |
|               +--+-------+--+                  |
|                  |       |                     |
+-----------------------------------------------+
                   |       |
            BLE    |       |  WebSocket + UDP
                   |       |
            +------+    +--+--------+
            |Glasses|   |   Cloud   |
            +-------+   | (SFU)    |
                        +-----------+
```

## Communication Between Processes

### JS venv to Puddle (PuddleTransport)

This replaces `WebSocketTransport`. The exact IPC mechanism depends on the mobile platform:

- **React Native:** Bridge calls, JSI, or a local WebSocket on localhost (simplest, most portable)
- **Native (iOS/Android):** Platform-specific IPC

The transport interface is the same regardless of mechanism. The SDK doesn't care how messages get from the JS venv to the Puddle, just that they do.

The simplest v1 approach: the Puddle runs a local WebSocket server on a localhost port. Each JS venv connects to it with a regular WebSocket. The `PuddleTransport` is literally `WebSocketTransport` pointed at `ws://localhost:<port>`. This is the lowest-risk path because it reuses existing, tested transport code.

### Webview to JS venv (via Puddle)

Webviews use `useMentraSession` to interact with the app. Today this goes through the SDK's webview bridge. In the Puddle architecture:

- Webview sends a message to the Puddle (via the React Native webview bridge, same as today)
- Puddle routes it to the correct app's JS venv
- JS venv processes it and responds through the Puddle back to the webview

From the developer's perspective, `useMentraSession` works the same way. The routing layer changes, the API doesn't.

### Puddle to Cloud

The Puddle maintains:

- A WebSocket connection to the cloud for control messages, subscription updates, and transcription delivery
- UDP audio streaming to the cloud for Soniox transcription

The Puddle sends the cloud a subscription manifest: "this user has these apps running, they're subscribed to these events." The cloud uses this to know what transcription results to send back. But the cloud doesn't manage app sessions or route events between apps. That's the Puddle's job.

## App Distribution

### How apps get to the phone

1. Developer builds a mini app (same code as today, using `@mentra/sdk`)
2. Developer submits to the Mentra App Store via `mentra app publish` or the developer console
3. The app's JavaScript bundle is hosted in an app registry
4. User browses the store on their phone, taps install
5. The app bundle downloads to the phone
6. When the user starts the app, the Puddle launches a JS venv with that bundle

### What gets submitted

The app bundle. This is the compiled JavaScript output of the developer's mini app. Not the source code, not the node_modules. The build step produces a bundle, the developer submits it, the registry hosts it.

The same app can also run as a cloud-hosted mini app if the developer wants to host their own server. The two modes are not mutually exclusive. A developer could offer both: a local version for basic features and a cloud-hosted version for features that need a backend.

### Versioning and updates

The registry handles versioning. When a developer publishes a new version, users get the update (auto-update, manual update, or whatever the mobile client implements). The Puddle restarts the JS venv with the new bundle.

## What Moves From Cloud to Puddle

| Responsibility             | Today (Cloud)      | Puddle Architecture                                 |
| -------------------------- | ------------------ | --------------------------------------------------- |
| User session management    | Cloud              | Puddle                                              |
| App session management     | Cloud              | Puddle                                              |
| Subscription tracking      | Cloud              | Puddle (source of truth), Cloud (read-only replica) |
| Event routing between apps | Cloud              | Puddle                                              |
| Display routing            | Cloud              | Puddle                                              |
| App lifecycle (start/stop) | Cloud              | Puddle                                              |
| Audio streaming            | Cloud (UDP)        | Cloud (UDP), routed through Puddle                  |
| Transcription/translation  | Cloud (Soniox)     | Cloud (Soniox), results delivered to Puddle         |
| App store / registry       | Cloud              | Cloud                                               |
| Photo capture routing      | Cloud              | Puddle                                              |
| Mini app hosting           | Developer's server | Phone (JS venv) or developer's server (optional)    |

## What the Cloud Keeps

- **Audio pipeline.** UDP audio ingestion, Soniox transcription, translation. This is compute-heavy and not practical to run on-device.
- **App store and registry.** App submission, hosting, discovery, updates.
- **Authentication.** User identity, Mentra UUID, core token. Every user needs a Mentra account for the app store.
- **Cloud-hosted app relay.** For apps that still run on remote servers (backward compat, or apps that need a backend).
- **Analytics/telemetry.** Usage data, crash reporting, etc.

## Third-Party / White-Label Support

OEM partners want to:

- Build their own apps for their glasses
- Use MentraOS as the platform
- Have their own users sign up through their system

This requires:

- **Mentra UUID for every user.** Even if they sign up through an OEM partner, they get a Mentra UUID for app store auth. This could be transparent (the OEM partner's auth layer creates a Mentra UUID behind the scenes).
- **Auth system redesign.** The current core token system needs to support federated auth. An OEM user authenticates with the OEM partner, the partner tells Mentra "this is a valid user," Mentra issues a Mentra UUID. Details TBD.
- **Custom app stores (maybe).** An OEM partner might want their own curated store. The registry could support namespaced stores or partner-specific collections. Not required for v1.

## Risks and Open Questions

**JS virtual environment on mobile.** What runtime? JavaScriptCore on iOS, Hermes on Android (via React Native), V8 via some other mechanism? Each has different capabilities, performance profiles, and sandboxing stories. This needs a spike.

**Sandboxing and permissions.** A downloaded app running locally has more potential to misbehave than a cloud-hosted app. The Puddle needs to enforce permissions (camera, mic, location, etc.) and prevent apps from accessing things they shouldn't. The current permission model in the cloud needs to be replicated in the Puddle.

**Battery and resource management.** Multiple JS venvs running simultaneously could drain battery. The Puddle needs to manage this: suspend background apps, limit concurrent active apps, etc.

**App size limits.** Bundled JavaScript apps need to be small enough to download quickly and not fill up the phone. Need to define size limits and potentially support code splitting / lazy loading.

**Offline behavior.** If the cloud is unreachable, local apps can still run (no transcription, but display, storage, device state all work). This is a feature, but the Puddle needs to handle the cloud-disconnected state gracefully.

**Migration path.** Existing cloud-hosted apps should continue to work without changes. The Puddle architecture is additive, not a replacement. Developers choose whether their app runs locally, remotely, or both.

## Sequencing

This is a proposal for discussion, not a committed plan.

1. **SDK v3 ships as stable.** The transport abstraction, subscription model, and lifecycle model are the foundation. This must be solid first.
2. **PuddleTransport spike.** Can a JS venv on the phone connect to a Puddle process via localhost WebSocket and run the SDK unchanged? Proof of concept.
3. **Puddle prototype.** Minimal Puddle that manages one user session, one app session, routes events. No cloud integration yet, just local.
4. **Cloud SFU mode.** Cloud accepts a "Puddle client" connection that sends audio and receives transcription. No app session management, just forwarding.
5. **App registry.** Submission, hosting, download. This can be built incrementally on top of the existing app store.
6. **Integration and testing.** Full flow: user downloads app from store, app runs locally, transcription comes from cloud, display updates go to glasses.

## Related Documents

| Document                                                  | Purpose                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `cloud/issues/048-sdk-v3/private-runtime-architecture.md` | SDK v3 internals, transport abstraction, subscription model |
| `cloud/issues/999-cloud-plan/plans/cloud-scaling.md`      | How the Puddle changes the cloud scaling story              |
| `cloud/issues/999-cloud-plan/plans/cloud-testing.md`      | Testing strategy that works for both cloud and local modes  |
| `cloud/.architecture/architecture.md`                     | Current cloud architecture reference                        |
