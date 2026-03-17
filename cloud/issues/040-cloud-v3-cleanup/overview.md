# Cloud v3 — Overview

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this?

This folder contains a set of documents covering the improvements needed in the MentraOS cloud for the v3 release. Each doc focuses on a different concern — maintainability, observability, reliability, scalability, and testing. Together they form the roadmap for making the cloud codebase healthier, more debuggable, and more resilient.

These docs are meant to be read by anyone working on MentraOS — cloud, mobile, firmware, or SDK. Each doc is self-contained, but they reference each other where concerns overlap.

---

## System Architecture

MentraOS is a platform for building apps that run on smart glasses. The system spans multiple layers, each owned by different people:

```
┌──────────┐      ┌──────────────┐      ┌──────────┐      ┌───────────┐
│  Glasses  │◄────►│ Mobile Client │◄────►│  Cloud   │◄────►│ Mini Apps  │
│ (firmware)│ BLE  │ (React Native │  WS  │ (Bun /   │ HTTP │ (3rd party │
│           │      │  + native)    │      │  Hono)   │      │  SDK apps) │
└──────────┘      └──────────────┘      └──────────┘      └───────────┘
                         │
                   ┌─────┴──────┐
                   │ ASG Client  │
                   │ (companion) │
                   └────────────┘
```

### Component roles

| Component              | What it does                                                                                                                                                | Stack                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Glasses (firmware)** | Renders display, captures audio/camera, reports sensors (IMU, touch, etc.)                                                                                  | Even Realities G1 firmware (future: MentraOS glasses)                    |
| **Mobile Client**      | Bridges glasses ↔ cloud. Manages BLE connection to glasses, WebSocket connection to cloud. Handles auth, app management UI.                                | React Native (TypeScript) + native modules (Kotlin/Swift)                |
| **ASG Client**         | Companion app for glasses-specific settings and diagnostics                                                                                                 | Native (Kotlin/Swift)                                                    |
| **Cloud**              | Central hub. Manages user sessions, routes data between clients and mini apps, handles transcription, display composition, dashboard, permissions, storage. | Bun + Hono + MongoDB + WebSocket                                         |
| **Mini Apps**          | Third-party apps built by developers using the MentraOS SDK. Receive transcription, send display content, access camera/location/etc.                       | `@mentra/sdk` (TypeScript) — deployed by developers on their own servers |

### Data flow (simplified)

```
User speaks
  → Glasses mic captures audio
  → BLE to mobile client
  → WebSocket to cloud
  → Cloud routes to Soniox (transcription provider)
  → Transcription result back to cloud
  → Cloud sends to mini app via HTTP webhook
  → Mini app processes, calls session.display.showText("...")
  → Cloud sends DisplayRequest to mobile client via WebSocket
  → Mobile client forwards to glasses via BLE
  → Glasses renders text on display
```

### Key abstractions

| Abstraction       | What it is                                                                                                                                                                                                    | Status                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **`@mentra/sdk`** | TypeScript SDK for building mini apps. Provides `MentraApp`, `AppSession`, and all the manager APIs (display, transcription, camera, etc.)                                                                    | Exists — being redesigned for v3 ([see 039](../039-sdk-v3-api-surface/v2-v3-api-map.md)) |
| **Device Bridge** | Native abstraction on the mobile side for communicating with glasses hardware (BLE protocol, device commands). Allows swapping glass hardware without changing app code.                                      | In development by mobile/firmware team                                                   |
| **Cloud Bridge**  | Proposed TypeScript library (`@mentra/cloud-bridge`) that encapsulates the client ↔ cloud protocol (WebSocket connection, auth, message types). Used by mobile client in production AND by the test harness. | Proposed — see [testing.md](./testing.md)                                                |

---

## Documents in this folder

| Doc                                            | Focus       | One-line summary                                                                  |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| [**overview.md**](./overview.md)               | Context     | You are here — system architecture and doc index                                  |
| [**maintainability.md**](./maintainability.md) | Code health | Dead code removal, god object splitting, Express deletion, cleanup                |
| [**observability.md**](./observability.md)     | Visibility  | Pipeline health tracking, health APIs, on-demand client log collection            |
| [**reliability.md**](./reliability.md)         | Correctness | DisplayManager redesign, view caching, connection stability, graceful degradation |
| [**scalability.md**](./scalability.md)         | Growth      | In-memory session limits, horizontal scaling, multi-region                        |
| [**testing.md**](./testing.md)                 | Confidence  | Cloud-bridge for e2e testing, test mini app, fast vs smoke tests                  |

### Reading order

There's no required reading order. Start with whichever doc is relevant to your work:

- **Cloud engineers**: start with [maintainability](./maintainability.md) and [reliability](./reliability.md)
- **Mobile engineers**: start with [observability](./observability.md) and [testing](./testing.md)
- **Firmware engineers**: start with [reliability](./reliability.md) (display pipeline) and [observability](./observability.md) (log collection)
- **SDK developers**: see [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md) for the SDK-specific doc
- **New to the project**: read this overview first, then whichever area you're working on

---

## How these docs relate

```
                    ┌─────────────────┐
                    │    overview.md   │
                    │  (you are here)  │
                    └────────┬────────┘
                             │
         ┌───────────┬───────┼───────┬────────────┐
         ▼           ▼       ▼       ▼            ▼
  ┌─────────────┐ ┌──────┐ ┌─────┐ ┌──────────┐ ┌───────┐
  │maintainabil.│ │obser.│ │reli.│ │scalabil. │ │testing│
  │    .md      │ │ .md  │ │ .md │ │   .md    │ │  .md  │
  └─────────────┘ └──────┘ └─────┘ └──────────┘ └───────┘
        │              │       │                     │
        │              │       │                     │
        └──────────────┴───────┴─────────────────────┘
              Cross-references where concerns overlap
              (e.g., observability ↔ testing for log collection,
               reliability ↔ maintainability for DisplayManager)
```

---

## Related docs outside this folder

| Doc                                                                                   | What it covers                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [039-sdk-v3-api-surface/v2-v3-api-map.md](../039-sdk-v3-api-surface/v2-v3-api-map.md) | Full SDK v2 → v3 API surface map — every public API, what changes, what's new, what's removed |
| [039-sdk-v3-api-surface/spike.md](../039-sdk-v3-api-surface/spike.md)                 | Original SDK v3 spike — audit of current API patterns and pain points                         |
| [038-sdk-logging-dx](../038-sdk-logging-dx/)                                          | SDK logging improvements (pino integration, log levels)                                       |
