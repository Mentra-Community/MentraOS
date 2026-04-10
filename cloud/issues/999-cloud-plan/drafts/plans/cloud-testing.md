# Cloud & SDK Testing Plan

## Overview

The cloud and SDK have zero automated tests. Every deploy is validated manually. Regressions are caught by users, not CI. This plan defines what we're going to build, in what order, and what we're explicitly not building yet.

## Current State

- No automated tests of any kind
- Manual validation before every deploy: connect glasses, open app, check manually
- Four layers (glasses firmware, phone client, cloud, mini apps) and four transports (WebSocket, REST, UDP audio, WS audio fallback)
- A bug at any layer can look like a bug at any other layer
- Real users on production. A bad deploy breaks everyone simultaneously.

## What We Need (In Priority Order)

### 1. MentraClient (Simulated Phone + Glasses)

**What:** A TypeScript client library (`@mentra/client`) that speaks the full cloud protocol. Built from the cloud side, because we own the wire protocol and know every message type, REST endpoint, and handshake.

**Why this first:** Everything else depends on being able to simulate a user connecting to the cloud without a real phone or glasses. MentraClient is the foundation for SDK integration tests, cloud API tests, and full E2E tests.

**Why we don't need the mobile team:** The mobile app mixes protocol code with React Native lifecycle, BLE management, UI state, and navigation. We don't need any of that. MentraClient is the protocol layer only:

- WebSocket connection to the cloud (handshake, auth, message types)
- REST calls to cloud endpoints
- UDP audio sending/receiving
- Session state (connected, disconnected, reconnecting)
- Device simulation (what glasses are "connected," what capabilities they report)

No React Native. No BLE. No UI. Just a TypeScript package that speaks the cloud protocol and runs in Bun/Node.

**What MentraClient enables:**

- Simulate any device configuration: phone only, display glasses, camera glasses, or any combination
- All four transports: WebSocket, REST, UDP audio, WS audio fallback
- Simulate user actions: start app, stop app, connect glasses, disconnect glasses, send audio
- Simulate failure modes: drop WebSocket mid-session, delay UDP, glasses disconnect during stream
- Full integration test: simulated client + real cloud + real test mini app
- No glasses, no phone, no manual steps

**How to build it:**

- Reference the cloud's message types (`cloud/packages/types/`)
- Reference the cloud's WebSocket handlers to understand the expected handshake and message flow
- Reference `cloud/.architecture/architecture.md` for the full protocol documentation
- Build it as `cloud/packages/cloud-client/` (directory already exists)
- Keep it minimal: connect, authenticate, send/receive messages, simulate device state
- Don't try to replicate the mobile app. Replicate the contract.

**Open questions:**

- Pre-recorded audio format for test input (PCM16? MP3? What does the UDP path expect?)
- Test user authentication (dedicated test user + API key? test mode on the cloud?)
- How granular should device simulation be? (just "camera glasses" vs full capability matrix)

### 2. SDK Integration Tests

**What:** A test mini app built with the real `@mentra/sdk` that exercises every SDK feature against a running cloud instance, with MentraClient simulating the user.

**Why:** The SDK is our developer-facing product. If a deploy breaks the SDK contract, third-party apps break. This is the highest-value test surface after MentraClient itself.

**How it works:**

- A real mini app using `MiniAppServer` and `MentraSession`
- Connects to a cloud instance (local, staging, or prod)
- MentraClient simulates a user: connects to cloud, starts the test app, simulates glasses
- The test app exercises each manager: transcription, display, camera, speaker, mic, storage, device, phone, LED, location, permissions, dashboard, time
- Validates that subscriptions work, events arrive, and responses have the right shape
- Two modes:
  - **Mocked transcription:** Fast, deterministic, runs on every commit. MentraClient sends pre-recorded audio or the cloud accepts a test audio source.
  - **Real Soniox:** Slower, uses pre-recorded audio through the real transcription pipeline, runs before deploys as a smoke test.

**What the test app looks like:**

- Registers with the cloud like any real app
- On session start, runs through a checklist of SDK operations
- Reports pass/fail per operation
- Can be run from CLI: `bun test:sdk --cloud=staging`

**What MentraClient does in this setup:**

- Simulates the user's phone connecting to the cloud
- Simulates glasses being connected (with configurable capabilities)
- Starts the test app (same as a user tapping the app)
- Feeds audio to the cloud via UDP (for transcription tests)
- Responds to photo requests, display updates, etc. (validates the round-trip)

### 3. Cloud API Tests

**What:** Direct tests against the cloud's REST and WebSocket endpoints using MentraClient. No SDK involved.

**Why:** Validates the cloud's behavior independent of the SDK. Catches regressions in auth, session management, app lifecycle, and message routing. Also validates the fail-fast behavior: correct error codes, per-hop deadline enforcement, structured error responses.

**How it works:**

- MentraClient connects as a user
- Tests exercise specific cloud behaviors:
  - Auth: valid token, invalid token, expired token
  - Session: create, reconnect, dispose, grace period
  - App lifecycle: start, stop, restart, reconnect after transport loss
  - Message routing: subscribe, receive events, unsubscribe
  - Error handling: request with disconnected glasses, request with disconnected phone WS, request to non-existent app
  - Fail-fast: verify that precondition failures return structured errors immediately, not timeouts
- Runs against local or staging cloud

### 4. CI Integration

**What:** Run tests automatically on PR and before deploy.

**Tiers:**

- **On every PR:** Cloud API tests + SDK integration tests with mocked transcription against a local cloud instance spun up in CI (Docker compose)
- **Before deploy to staging:** SDK integration tests with real Soniox against staging
- **Before deploy to prod:** Smoke test against staging with real transcription

**Infrastructure needed:**

- CI can spin up a local cloud instance (Docker compose)
- Test user credentials available in CI secrets
- MentraClient and test mini app runnable in CI
- Results reported in PR checks

## What We're Not Building Yet

- **Load testing.** Important for scaling but not the immediate gap. Correctness first. Once MentraClient exists, load testing becomes "spin up N MentraClients and see what breaks."
- **BLE simulation.** MentraClient simulates above BLE. It tells the cloud "I have glasses connected with these capabilities." It doesn't simulate the actual BLE protocol.
- **Visual/display testing.** No way to validate what actually renders on glasses. Tests validate that the right messages are sent, not that they look correct.
- **Mobile client tests.** Not cloud team's scope. But MentraClient could eventually be used by the mobile team too, since it's the same protocol.

## Sequencing

All phases are cloud-owned. No external dependencies.

```
Phase 1: MentraClient library (the protocol client)
         ↓
Phase 2: SDK integration tests + cloud API tests (both use MentraClient)
         ↓
Phase 3: CI integration (run tests on PR and before deploy)
```

## How This Connects to the Puddle Architecture

The Puddle changes where session management runs (device instead of cloud), but it doesn't change what needs testing. The same SDK managers, the same subscriptions, the same message routing all need to work whether the transport is WebSocket-to-cloud or inter-process-to-Puddle.

Because SDK v3 is transport-agnostic, the same test mini app and the same assertions work in both modes. The test harness just swaps the transport:

- Cloud mode: MentraClient connects to cloud, mini app uses `WebSocketTransport`
- Local mode: MentraClient connects to Puddle, mini app uses `PuddleTransport` (future)

Investing in MentraClient and SDK integration tests now pays off twice.

MentraClient is also useful beyond testing. It could become the foundation for:

- A desktop client (connect glasses via USB/BLE dongle, no phone needed)
- A CLI-based development tool (run your app without touching a phone)
- Load testing (spin up hundreds of simulated users)
- Demos and trade shows (scripted user behavior without real hardware)
