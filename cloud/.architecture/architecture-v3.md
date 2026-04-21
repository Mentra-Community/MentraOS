# MentraOS Cloud Architecture v3

- author: Codex + Isaiah Ballah
- status: draft
- last updated: 2026-03-19

> Forward-looking architecture for SDK v3 and the cloud/runtime changes needed to support it.

## Purpose

This document is intentionally separate from [`architecture.md`](./architecture.md).

- `architecture.md` remains the reference for the legacy/active pre-v3 model.
- this document captures the v3 runtime direction without deleting that historical reference.

## Core Naming

- `MiniAppServer`: cloud/server host abstraction for mini apps
- `MentraSession`: per-user runtime abstraction for app logic
- `AppServer` / `AppSession`: legacy compatibility surface

## High-Level Direction

The v3 system keeps the same four hops, but changes the internals of Hop 3 and Hop 4.

### Hop 3: Cloud → SDK

Still uses:

- webhook start/stop
- websocket app connection

But the contract is evolving toward:

- cloud-owned app-session UUIDs
- canonical `websocketUrl` in webhook payloads
- namespaced websocket path `/ws/miniapp` with legacy `/app-ws` retained
- explicit reconnect protocol:
  - `RECONNECT`
  - `RECONNECT_ACK`
  - `RECONNECT_DEFERRED`
  - `RECONNECT_REJECTED`

### Hop 4: SDK → Developer Code

Developer code should target:

- `MiniAppServer`
- `MentraSession`

The SDK should keep top-level public classes lean and push orchestration into private underscore-prefixed internals.

## Session Identity

Legacy:

- app identity often derived from `${userId}-${packageName}`

v3 direction:

- cloud owns a real UUID per app session
- webhook start payload carries that UUID as `sessionId`
- `CONNECTION_ACK` / `RECONNECT_ACK` are authoritative for live runtime identity

## Reconnect Model

v3 distinguishes:

- transport reconnect
- resurrection
- cloud restart recovery

Cloud restart recovery direction:

- cloud remains authoritative
- v3 app reconnects may be deferred while cloud is booting or restoring app state
- deferred sockets can remain open temporarily
- SDK parks `MentraSession` state rather than destroying it immediately
- manual stop bypasses parked recovery and tears down immediately

## Cloud Ownership Model

- `UserSession` remains glasses/mobile-owned
- `/app-ws` or `/ws/miniapp` should not create speculative full `UserSession`s
- deferred v3 app sockets live outside `UserSession` until attach is possible

## Compatibility Rules

- old SDKs must continue to work with the new cloud
- legacy routes and webhook fields remain supported during transition
- new reconnect behavior is version-gated to v3-aware SDK clients

## Current State

As of this draft:

- the new `MentraSession` runtime exists
- `MiniAppServer` exists
- cloud deferred reconnect support exists in first-pass form
- the system is still hybrid, with compatibility layers still in place

## Remaining Work

- finish hardening `MiniAppServer` + `MentraSession` for fresh app authors
- validate reconnect/resurrection behavior end to end
- continue removing hybrid assumptions from cloud and SDK internals
- update developer-facing docs once the runtime is stable enough to recommend broadly
