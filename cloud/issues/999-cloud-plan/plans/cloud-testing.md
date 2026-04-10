# E2E Testing

TODO: Detailed implementation plan needs to be written. The sections below capture what we know so far.

## Why MentraClient

The MentraOS cloud has zero automated tests. The only way to verify the cloud works is to physically connect glasses, open the app, and check manually. This is true for every deploy, every bug fix, every feature. It does not scale.

Mentra Live units are actively shipping. A single cloud deploy can break captions for every connected user simultaneously. We find out when users tell us. There is no CI gate, no smoke test, no regression check. The cloud compiles, so it ships.

When something does break, diagnosing it is slow. The system has four layers (glasses firmware, phone client, cloud, MiniApps) and four transports (WebSocket, REST, UDP audio, WS audio fallback). A bug at any layer can look like a bug at any other layer. Issue 079 is an example: the cloud was blamed for broken sessions, but production data proved 7 out of 13 cases were the phone failing to reconnect. That investigation took days of manual log analysis. A test that simulates a reconnection would have caught it before it shipped.

The missing piece is a client we can run without hardware. Not a mock. Not a test double. The actual protocol implementation that the mobile app uses in production, extracted into a standalone package that runs in both React Native/Expo and Node/Bun. If it passes a test, it works in production, because it is the production code.

That's MentraClient. It unlocks automated testing for the entire platform: cloud, client, and SDK. Every device type (display glasses, camera glasses, phone). Every transport. Every protocol message. Without touching a pair of glasses.

## MentraClient

`@mentra/client` is a TypeScript implementation of the MentraOS client protocol. It covers every transport and every message type the cloud sends or receives. It runs in both React Native/Expo (production mobile app) and Node/Bun (automated tests, future desktop client).

The mobile app imports MentraClient and adds UI. Tests import MentraClient and add assertions. Same code, same protocol, same behavior. If tests pass, production works.

MentraClient can simulate any device configuration:

- **Phone** connecting to cloud, sending device state, location, notifications
- **Display glasses** (G1, G2, Mentra Display) receiving text, markdown, and UI updates over BLE
- **Camera glasses** (Mentra Live) streaming audio, capturing photos, recording video
- **Any combination** of the above, including multiple simultaneous connections

All four transports between client and cloud:

1. **WebSocket** (glasses-ws, app-ws). Session init, subscriptions, display updates, pings, connection lifecycle.
2. **REST** (HTTP API). Device state, location, notifications, photos, settings.
3. **UDP audio**. Real-time audio streaming for transcription.
4. **WebSocket audio**. Fallback when UDP is unavailable.

Client and server state tracking:

- Session status (connected, disconnected, grace period)
- Active subscriptions
- Connection state per transport
- Device state, capabilities
- Last received display update

This unlocks automated testing for the entire platform:

- **Cloud testing.** Simulate phones and glasses connecting, sending audio, receiving display updates. Test the cloud without hardware.
- **Client testing.** The mobile app uses the same protocol code. Testing MentraClient tests the real client transport layer.
- **SDK testing.** Simulate a full user session (glasses connected, phone connected, audio flowing) hitting a MiniApp. SDK developers can run automated tests for their apps locally without real hardware or a running cloud.

Right now the only way to test the cloud is with physical hardware. MentraClient removes that constraint.

**Key constraint:** MentraClient must be extracted from the existing mobile client's transport/protocol code, not reimplemented from scratch. This means it needs to be decoupled from React Native UI concerns while remaining importable by both Expo and Node/Bun. The React Native app wraps it with UI. Node/Bun wraps it with test assertions or a CLI.

## Test MiniApp

A real MiniApp built with `@mentra/sdk` that exercises every SDK feature. Not a mock. A real app using the real production SDK.

- Transcription, display, dashboard, camera, audio, location, storage, device, phone, permissions, lifecycle
- Runs on the cloud like any other MiniApp
- Tests connect MentraClient, the cloud routes to the test MiniApp, and assertions verify the full round trip
- Covers both display glasses scenarios (text rendering, scrolling, dashboard) and camera glasses scenarios (photo capture, video, streaming)

## Test Harness

Orchestrates: MentraClient (simulated user with simulated glasses) + real cloud + test MiniApp.

- Event-based assertions, not timing-based. No `sleep(500)`. Use `await client.waitForDisplayUpdate({ timeout: 10000 })`.
- Two tiers: fast tests (mocked transcription, every commit) and smoke tests (real Soniox, before deploys)

## What still needs to be figured out

- How tangled is the mobile client's transport/protocol code with React Native? Can it be extracted cleanly into a package that works in both Expo and Node/Bun?
- Where does the mock transcription provider live? Cloud-side plugin? Separate Soniox mock server?
- Test environment setup (local server? staging? Docker compose?)
- Test user authentication (hardcoded test accounts? ephemeral tokens?)
- Pre-recorded audio format for test input (PCM? LC3?)
- CI infrastructure (GitHub Actions? acceptable suite duration?)
- Package structure. Separate `@mentra/client` package, or a subpath export from an existing package?
- BLE simulation. How much of the glasses BLE layer needs to be modeled, or is it enough to simulate at the phone-to-cloud boundary?
