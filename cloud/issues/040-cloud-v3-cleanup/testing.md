# Cloud v3 — Testing

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc covers the testing strategy for MentraOS — specifically, the infrastructure needed to run automated end-to-end tests across the cloud, SDK, and client protocol layers.

## Why it matters

MentraOS currently has no automated end-to-end testing. When a change is made to the cloud, the SDK, or the mobile client, the only way to know if things still work is to manually test with real glasses. This is slow, unreliable, and doesn't scale. Bugs ship to users, regressions go unnoticed, and confidence in making changes is low.

The goal is to build a test harness where the cloud, SDK, and client protocol are all exercised by real production code — not mocks, not separate test implementations, not reimplementations of the protocol. The same code that runs in production runs in tests. If the test passes, production works. If the test fails, production is broken.

## System context

See [overview.md](./overview.md) for full system architecture. The key insight for testing:

```
Glasses ←BLE→ Mobile Client ←WebSocket→ Cloud ←HTTP→ Mini Apps
```

- The **Mini App side** already has a production library: `@mentra/sdk`. A test can spin up a real mini app using the real SDK. No simulation needed.
- The **Client side** has no reusable library. The WebSocket protocol, authentication, and message handling are embedded in the React Native mobile app. This needs to be extracted into a shared library.

The missing piece is a **client-side protocol library** — a TypeScript package that any client (mobile, desktop, test harness) can use to connect to the cloud and speak the MentraOS protocol.

---

## The Cloud Bridge (`@mentra/cloud-bridge`)

### What it is

A TypeScript library that encapsulates the client ↔ cloud protocol:

- WebSocket connection management
- Authentication handshake
- Message serialization / deserialization
- Sending: audio chunks, location updates, button events, gesture events, device state, etc.
- Receiving: display requests, transcription results, app lifecycle events, etc.
- Reconnection logic

### Who uses it

| Consumer                         | Environment     | Purpose                                                                      |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| **Mobile client** (React Native) | Production      | The actual production client. Uses cloud-bridge for all cloud communication. |
| **E2E test harness**             | CI / local dev  | Simulates a client connecting to the cloud. Exercises the full protocol.     |
| **Future desktop client**        | Electron / Node | A desktop app for MentraOS (if built). Same protocol, same library.          |

### Why it must be the same code

This is the most important constraint. The cloud-bridge library used in tests **is** the production library used by the mobile client. Not a copy, not a reimplementation, not a test mock. The same package.

If the test harness uses a separate "test client" that reimplements the WebSocket protocol:

- The test client and the real client will inevitably drift
- Tests pass when production is broken (the test client handles a message differently)
- Tests fail when production is fine (the test client has its own bugs)
- Two codebases to maintain instead of one

By using the same library, any protocol change that breaks the test also breaks the mobile client — and vice versa. The tests are a truthful signal.

### Where the code lives today

The mobile client is React Native. The TypeScript/JavaScript layer in React Native already handles the WebSocket connection to the cloud. Extracting cloud-bridge means pulling that protocol logic out of the React Native app into a standalone package (`@mentra/cloud-bridge`) and having the React Native app import it.

This is an extraction, not a rewrite. The code already exists — it just needs to be decoupled from React Native UI concerns.

### Relationship to device-bridge

The mobile team is building a **device-bridge** — an abstraction between the mobile client and the glasses hardware (BLE protocol, device commands). Cloud-bridge is the mirror on the other side:

```
Glasses ←[device-bridge]→ Mobile Client ←[cloud-bridge]→ Cloud ←[HTTP]→ Mini Apps
                                │
                          React Native UI
```

Together they form two clean abstraction layers. The mobile app's React Native code sits between them, handling UI and business logic.

---

## The Test Mini App

### What it is

A real mini app built with `@mentra/sdk` that exercises every SDK feature. It's the other half of the e2e harness — the cloud-bridge simulates a client on one end, and the test mini app is the real app on the other end.

### What it covers

The test mini app should call every major SDK API so the e2e harness can verify the cloud handles them correctly:

| Feature area  | SDK calls exercised                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Transcription | `session.transcription.on()`, `session.transcription.onLanguage()`, `session.transcription.configure()`                   |
| Display       | `session.display.showText()`, `session.display.showCard()`, `session.display.showDoubleText()`, `session.display.clear()` |
| Dashboard     | `session.dashboard.showText()`, `session.dashboard.clear()`                                                               |
| Camera        | `session.camera.takePhoto()`                                                                                              |
| Audio         | `session.audio.play()`, `session.audio.speak()`                                                                           |
| Location      | `session.location.onUpdate()`, `session.location.lat`, `session.location.lng`                                             |
| Storage       | `session.storage.get()`, `session.storage.set()`, `session.storage.delete()`                                              |
| Device        | `session.device.batteryLevel`, `session.device.onButtonPress()`, `session.device.onTouchEvent()`                          |
| Phone         | `session.phone.notifications.on()`, `session.phone.calendar.on()`                                                         |
| Permissions   | `session.permissions.has()`, `session.permissions.getAll()`                                                               |
| Lifecycle     | `app.onSession()`, `app.onStop()`                                                                                         |

### Why it must be a real mini app

The test mini app uses `@mentra/sdk` — the actual production SDK. It receives real webhook calls from the cloud, processes them with real SDK code, and sends real responses back. If the test mini app works, any developer's app using the same SDK calls will work too.

It's not a mock. It's not a stub. It's a real app that happens to exist for the purpose of testing.

### Keeping it in sync

The test mini app doesn't need to be perfect or exhaustive from day one. Start with the core features (transcription, display, lifecycle) and add coverage as needed. The goal is to have the infrastructure in place — cloud-bridge + test mini app + harness — so that adding test coverage for a new feature is easy.

---

## E2E Test Harness

### How it works

The e2e test orchestrates three real components:

```
┌──────────────┐     ┌──────────┐     ┌────────────────┐
│ Cloud Bridge  │◄───►│  Cloud   │◄───►│ Test Mini App   │
│ (simulated    │ WS  │ (real)   │ HTTP│ (real, using    │
│  client)      │     │          │     │  @mentra/sdk)   │
└──────────────┘     └──────────┘     └────────────────┘
       ↑                                      ↑
       └──────────── Test Harness ────────────┘
                   (orchestrates both)
```

1. **Cloud** — real cloud server, running locally or in a test environment
2. **Test Mini App** — real mini app using the real SDK, started by the harness
3. **Cloud Bridge client** — real protocol library, connecting as a simulated user

### Example test flow

```
test("transcription → display update e2e", async () => {
  // 1. Start the test mini app (real SDK, real webhook server)
  //    The app subscribes to transcription and shows text on display
  const app = await startTestMiniApp();

  // 2. Connect as a simulated client
  const client = new CloudBridgeClient({ userId: testUser, token: testToken });
  await client.connect();

  // 3. Send pre-recorded audio chunks (simulates glasses mic)
  await client.sendAudioChunks(preRecordedPCM);

  // 4. Wait for a display update to arrive (not a timing assertion — event-based)
  const display = await client.waitForDisplayUpdate();

  // 5. Verify the display contains transcribed text
  expect(display.layout.text).toContain("hello world");

  // Cleanup
  await client.disconnect();
  await app.stop();
});
```

Every piece is real except the glasses hardware. The protocol code is the same as production. The SDK code is the same as production.

### Fast tests vs. smoke tests

| Type            | What it tests                          | External dependencies                            | Speed                   | When to run                   |
| --------------- | -------------------------------------- | ------------------------------------------------ | ----------------------- | ----------------------------- |
| **Fast tests**  | Cloud logic, protocol, SDK integration | Mocked transcription provider (echoes back text) | Milliseconds to seconds | Every commit, every PR        |
| **Smoke tests** | Full end-to-end including Soniox       | Real Soniox, real cloud, real SDK                | 5-10 seconds per test   | Before deploys, on a schedule |

**Fast tests** replace Soniox with a mock transcription provider at the cloud level. The mock receives audio and immediately returns a canned transcription result. This tests the entire pipeline — client protocol, cloud routing, webhook to mini app, display response — without the latency and cost of hitting a real transcription service. These run fast enough to be part of CI on every commit.

**Smoke tests** hit real Soniox with real audio. They prove the full system actually works end-to-end, including the external transcription provider. They're slower and depend on Soniox being available, so they run less frequently — before deploys or on a scheduled cadence.

### Avoiding flaky tests

Tests that rely on timing (`sleep(500)`, `setTimeout`) are the main source of flakiness. The harness should use **event-based assertions** — wait for a specific event to arrive, with a generous timeout, rather than asserting something happened within X milliseconds.

```
// BAD — flaky
await sleep(500);
expect(client.lastDisplay).toBe("hello");

// GOOD — event-based
const display = await client.waitForDisplayUpdate({ timeout: 10000 });
expect(display.layout.text).toContain("hello");
```

The timeout is a safety net (fail if nothing arrives in 10 seconds), not an assertion about speed. This makes tests resilient to variable processing times without being flaky.

---

## Implementation Priority

### Phase 1 — Foundation

1. **Extract cloud-bridge from mobile client** — pull the WebSocket protocol layer out of React Native into `@mentra/cloud-bridge`. Mobile client imports it.
2. **Build the test mini app** — a simple app using `@mentra/sdk` that covers core features (transcription → display, lifecycle).
3. **Write the first e2e test** — cloud-bridge connects, sends audio, verifies display update. Proves the harness works.

This alone is a massive improvement — going from zero automated e2e tests to one that exercises the core path.

### Phase 2 — Coverage

4. **Add mock transcription provider** — enables fast tests that don't hit Soniox.
5. **Expand test mini app coverage** — add more SDK features (camera, location, storage, dashboard, etc.).
6. **Add to CI** — fast tests run on every PR.

### Phase 3 — Confidence

7. **Smoke tests on a schedule** — full e2e with real Soniox, run before deploys and hourly/daily.
8. **Test connection edge cases** — reconnection, WebSocket drops, slow webhooks, concurrent sessions.

---

## Related docs

- [overview.md](./overview.md) — system architecture that the test harness exercises
- [observability.md](./observability.md) — pipeline health tracking can be validated by the test harness; on-demand log collection can be tested too
- [reliability.md](./reliability.md) — the e2e harness can simulate scenarios like rapid display updates (§1), connection drops (§3), and slow mini apps (§5)
- [maintainability.md](./maintainability.md) — SDK route namespacing (§6) needs testing for both old and new paths

---

## Open Questions

| #   | Question                                                                | Notes                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | How tangled is the mobile client's WebSocket code with React Native UI? | Determines how hard the cloud-bridge extraction is. If it's already somewhat modular, extraction is straightforward. If it's deeply coupled to React state/hooks, more work needed. |
| Q2  | Mock transcription provider — where does it live?                       | A cloud-level config flag (`transcriptionProvider: 'mock'`)? A test-only provider alongside Soniox/Alibaba?                                                                         |
| Q3  | Test environment setup                                                  | Does the test spin up a real cloud server locally? Use a shared staging environment? Docker compose?                                                                                |
| Q4  | Test user / auth                                                        | How does the simulated client authenticate? Test-only user accounts? Bypass auth in test mode?                                                                                      |
| Q5  | Pre-recorded audio format                                               | What format/encoding for test audio chunks? Needs to match what the mobile client sends (PCM/LC3).                                                                                  |
| Q6  | CI infrastructure                                                       | Where do tests run? GitHub Actions? How long is acceptable for the test suite?                                                                                                      |
