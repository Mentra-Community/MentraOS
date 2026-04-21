# SDK v3 Implementation Progress

Last updated: 2026-03-21

## Current Intent

Issue 048 is being implemented as an SDK architecture refactor that preserves the existing cloud and mobile wire contract.

The immediate target is:

- ship the new public v3 naming and session architecture in the SDK,
- keep legacy apps working against the current cloud,
- avoid mobile or ASG client changes in this pass,
- defer deeper cloud/runtime redesigns unless they are required for compatibility.

Recent design decisions now frozen in spec:

- v3 reconnect protocol includes `sdkVersion` on both `CONNECTION_INIT` and `RECONNECT`
- cloud restart recovery uses `RECONNECT_DEFERRED` plus parked `MentraSession` state
- deferred sockets remain open as unattached control channels
- parked timeout defaults to 30 seconds
- SDK should expose `session.onReconnected()` for reconnect/reattach of the same logical session

## Naming Decision

The server-side host class should be `MiniAppServer`, not `MentraApp`.

Reasoning:

- `MentraSession` is intended to become the runtime-agnostic per-user API.
- the cloud-hosted Node/Hono wrapper is specifically the server host for a mini app.
- using `MiniAppServer` avoids future confusion once local mini apps run on-device or on-phone and are still "apps" but not servers.

Compatibility naming:

- `MiniAppServer`: new v3 server host
- `MentraSession`: new v3 per-user session abstraction
- `AppServer`: deprecated compatibility surface
- `AppSession`: legacy compatibility surface behind the transition

## What Was Audited

### Specs

Read and cross-checked:

- `cloud/issues/048-sdk-v3/spike.md`
- `cloud/issues/048-sdk-v3/reconnection-architecture-spike.md`
- `cloud/issues/048-sdk-v3/cloud-websocket-bootstrap-spike.md`
- `cloud/issues/048-sdk-v3/private-runtime-architecture.md`
- `cloud/.architecture/architecture.md`
- `cloud/.architecture/auth.md`
- `cloud/issues/048-sdk-v3/client-sdk-spike.md`
- `cloud/issues/048-sdk-v3/session-camera-spike.md`
- `cloud/issues/048-sdk-v3/session-device-spike.md`
- `cloud/issues/048-sdk-v3/session-mic-spike.md`
- `cloud/issues/048-sdk-v3/session-phone-spike.md`
- `cloud/issues/048-sdk-v3/session-speaker-spike.md`
- `cloud/issues/048-sdk-v3/session-state-spike.md`
- `cloud/issues/048-sdk-v3/docs-update-spec.md`
- `cloud/issues/048-sdk-v3/sdk-cicd-plan.md`
- `cloud/issues/048-sdk-v3/sdk-release-sop.md`
- `cloud/issues/048-sdk-v3/remaining-work.md`
- `cloud/issues/039-sdk-v3-api-surface/v2-v3-api-map.md`

### Legacy SDK

Read the active pre-v3 runtime path:

- `cloud/packages/sdk/src/app/server/index.ts`
- `cloud/packages/sdk/src/app/session/index.ts`
- `cloud/packages/sdk/src/app/session/events.ts`
- `cloud/packages/sdk/src/app/session/modules/*`

### Cloud Runtime

Read the current cloud-side session and websocket flow:

- `cloud/packages/cloud/src/services/session/UserSession.ts`
- `cloud/packages/cloud/src/services/session/AppManager.ts`
- `cloud/packages/cloud/src/services/session/AppSession.ts`
- `cloud/packages/cloud/src/services/session/SubscriptionManager.ts`
- `cloud/packages/cloud/src/services/session/MicrophoneManager.ts`
- `cloud/packages/cloud/src/services/session/DeviceManager.ts`
- `cloud/packages/cloud/src/services/session/handlers/*`
- `cloud/packages/cloud/src/services/websocket/*`

### Mobile Contract

Read the active mobile transport path for contract awareness only:

- `mobile/src/services/SocketComms.ts`
- `mobile/src/services/WebSocketManager.ts`
- `mobile/src/services/UdpManager.ts`
- `mobile/src/services/RestComms.ts`
- `mobile/src/services/MantleManager.ts`

No mobile or ASG client refactor is planned as part of this issue.

## Current Code Reality

### Legacy Surface Is Still Active

The active public SDK still runs through:

- `cloud/packages/sdk/src/app/server/index.ts`
- `cloud/packages/sdk/src/app/session/index.ts`

Cloud still expects the legacy routes and wire behavior:

- `/webhook`
- `/tool`
- `/settings`
- `/photo-upload`
- `/health`

Current cloud session and identity assumptions also still exist:

- app sessions are initialized via the current `/app-ws` flow,
- app `sessionId` is still derived in cloud as `${userId}-${packageName}`,
- reconnect and resurrection logic still centers on cloud `AppSession`.

### Staged v3 Tree Exists But Was Not Integrated

The following staged SDK refactor files exist under new paths and were untracked when audited:

- `cloud/packages/sdk/src/session/*`
- `cloud/packages/sdk/src/transport/*`
- `cloud/packages/sdk/src/utils/error-utils.ts`

These files are substantial, but they were not wired into the active exports/runtime:

- `cloud/packages/sdk/src/session/DataStreamRouter.ts`
- `cloud/packages/sdk/src/transport/Transport.ts`
- `cloud/packages/sdk/src/transport/WebSocketTransport.ts`
- `cloud/packages/sdk/src/session/managers/*`

Important nuance:

- these files are new in the current worktree and path layout,
- not necessarily conceptually new compared with older SDK modules.

## Code Changes Already Made

### Docs Updated For Naming

The main spec docs were updated to use `MiniAppServer` instead of `MentraApp`:

- `cloud/issues/039-sdk-v3-api-surface/v2-v3-api-map.md`
- `cloud/issues/048-sdk-v3/spike.md`
- `cloud/issues/048-sdk-v3/remaining-work.md`
- `cloud/issues/048-sdk-v3/sdk-release-sop.md`
- `cloud/issues/048-sdk-v3/docs-update-spec.md`

The legacy cloud architecture docs were intentionally left untouched as historical references.

Added:

- `cloud/.architecture/architecture-v3.md`

### Transitional SDK Surface Added

Added:

- `cloud/packages/sdk/src/MiniAppServer.ts`
- `cloud/packages/sdk/src/session/index.ts`

Updated:

- `cloud/packages/sdk/src/index.ts`
- `cloud/packages/sdk/src/transport/WebSocketTransport.ts`

Current transitional behavior:

- `MiniAppServer` subclasses legacy `AppServer`
- callback-style v3 naming exists without changing the live cloud/mobile contract
- transport compile issue in `WebSocketTransport.ts` was fixed

This is intentionally a bridge, not the final architecture.

### Real v3 Session Runtime Started

Added:

- `cloud/packages/sdk/src/session/MentraSession.ts`

Updated:

- `cloud/packages/sdk/src/session/managers/DeviceManager.ts`
- `cloud/packages/sdk/src/index.ts`
- `cloud/packages/sdk/src/session/internal/*`
- `cloud/packages/sdk/src/internal/_MiniAppServerCallbackBridge.ts`
- `cloud/packages/sdk/src/MiniAppServer.ts`
- `cloud/packages/sdk/src/app/server/index.ts`

Current behavior:

- the real `MentraSession` class now exists as a transport-driven runtime entrypoint
- it wires the staged managers into:
  - `Transport`
  - `MessageHandlerRegistry`
  - `DataStreamRouter`
  - connection init / ack
  - subscription sync
  - ping keepalive
  - reconnect attempts
- its hidden orchestration is now split into underscore-prefixed internal managers for:
  - transport lifecycle
  - raw message routing
  - subscription bookkeeping
- `MiniAppServer` remains a compatibility host and does not yet construct the new `MentraSession`
- `MiniAppServer` now also uses a private underscore-prefixed callback/session bridge internally so the public class stays lean
- the legacy SDK server now exposes additive namespaced route aliases:
  - `/api/_mentraos/webhook`
  - `/api/_mentraos/tool`
  - `/api/_mentraos/settings`
  - `/api/_mentraos/photo-upload`
  - `/api/_mentraos/health`
  - `/api/_mentraos/auth`
- a compatibility adapter now exists over the new session runtime as groundwork for the eventual server-side cutover:
  - `cloud/packages/sdk/src/session/internal/_CompatMentraSessionAdapter.ts`
  - `cloud/packages/sdk/src/session/internal/_CompatEventManagerAdapter.ts`
- the first real server-side cutover primitives now exist:
  - `cloud/packages/sdk/src/internal/_MentraSessionServerFactory.ts`
  - `cloud/packages/sdk/src/internal/_MiniAppSessionRegistry.ts`
  - `cloud/packages/sdk/src/internal/_MiniAppServerRuntime.ts`
- `MiniAppServer` now instantiates and configures that new internal runtime
- `MiniAppServer` now overrides the inherited webhook start/stop handling so webhook-driven session lifecycle is routed through the new runtime while still populating the base server's active-session map for transitional compatibility
- the new runtime now includes a compatibility camera adapter:
  - `cloud/packages/sdk/src/session/internal/_CompatCameraAdapter.ts`
- camera compatibility is materially improved:
  - new `CameraManager` now supports unmanaged RTMP streaming
  - new `CameraManager` now supports managed stream lifecycle and status
  - compatibility `requestPhoto()` now routes through `AppServer` pending-photo state and `/photo-upload` instead of hard-failing
- runtime disconnect semantics are now closer to legacy `AppServer` behavior:
  - temporary transport disconnects no longer immediately evict active sessions
  - permanent disconnects now trigger compatibility stop-handler flow
  - active-session removal is now identity-safe during session replacement
- SDK-side reconnect protocol scaffolding is now in place:
  - `AppToCloudMessageType.RECONNECT`
  - `CloudToAppMessageType.RECONNECT_ACK`
  - `CloudToAppMessageType.RECONNECT_REJECTED`
  - `CloudToAppMessageType.RECONNECT_DEFERRED`
  - `MentraSession` now sends `sdkVersion`
  - `MentraSession` now exposes `onReconnected()`
  - `MentraSession` can enter parked state on deferred reconnect
- cloud-side deferred reconnect support has now started:
  - added deferred v3 app socket registry in `cloud/packages/cloud/src/services/websocket/DeferredAppConnectionRegistry.ts`
  - `/app-ws` Bun handler now recognizes `RECONNECT`
  - when no `UserSession` exists yet, authenticated v3 reconnects are deferred instead of immediately hard-failing
  - deferred sockets now time out after 30 seconds with terminal rejection
  - `AppManager.startApp()` now prefers consuming a waiting deferred socket before sending a fresh webhook
  - `AppManager.handleReconnect()` now supports immediate attach, defer, or terminal rejection for v3 reconnects
  - SDK transport factory now sends app identity headers (`x-user-id`, `x-session-id`, `x-package-name`, `x-api-key`) to support cloud-side deferred attach
- app creation defaults are now aligned across the console and CLI API path:
  - when a create request omits `permissions`, the shared console app-create service now adds `MICROPHONE`
  - explicit `permissions: []` still opts out, matching the console UI behavior where microphone is preselected but removable
- handshake/identity cleanup progressed further:
  - cloud `AppSession` now owns a real UUID session identity instead of relying only on `${userId}-${packageName}`
  - session-start webhooks now carry the cloud-owned app-session UUID
  - key cloud-to-app message paths now emit the real app-session UUID rather than reconstructing `userId-packageName`
  - cloud websocket aliases now include `/ws/client` and `/ws/miniapp` alongside legacy `/glasses-ws` and `/app-ws`
  - `MentraSession` now uses the live runtime session ID internally instead of continuing to emit the original configured session ID after ACK/reconnect
  - v3 `CONNECTION_INIT` no longer sends `sessionId` from the new SDK runtime
  - terminal `RECONNECT_REJECTED` cases (`NOT_RUNNING`, `BOOT_TIMEOUT`) no longer blindly fall back to fresh `CONNECTION_INIT`
- root exports now include the real `MentraSession`
- `MiniAppServer` callback registration is now typed around `MentraSession` for new v3 app authors, while inherited `AppServer` override paths remain available for compatibility
- added a dedicated minimal validation target:
  - `cloud/packages/apps/v3-smoke-test`
  - this app uses `MiniAppServer` + `MentraSession` directly and is intended to validate the fresh v3 authoring path without unrelated frontend/app complexity
- the v3 smoke app now also exercises the Hono/Bun webview developer path:
  - real `/` and `/webview` HTML routes served through Bun's HTML bundle/HMR flow
  - SDK-owned webview auth is now auto-mounted by `AppServer` / `MiniAppServer`
  - canonical auth init path is now `/api/_mentraos/auth/init`
  - `/api/mentra/auth/init` remains as a compatibility alias during transition
  - public auth helpers now include:
    - `createAuthMiddleware()`
    - `getMentraAuth(c)`
    - `requireMentraAuth(c)`
  - authenticated probe routes now exist for both cookie-backed auth and frontend-token auth without app code reading raw Hono context variable names
  - local validation now confirms the generated HTML shell and Bun chunk assets are served correctly
  - fixed a real subscription bug in the v3 transcription path:
    - `transcription:auto` is now parsed as a valid subscription
    - cloud app-matching now treats `transcription:auto` as a wildcard for any detected transcription language

## Verification Already Run

Passed:

- `bunx tsc -p cloud/packages/sdk/tsconfig.json --noEmit`
- `bun run --cwd cloud/packages/sdk build:js-only`
- `bun run --cwd cloud/packages/sdk build`
- `bunx tsc -p cloud/packages/apps/v3-smoke-test/tsconfig.json --noEmit`
- `bun install` (workspace refresh after adding v3 smoke app frontend dependencies)
- local curl validation of `v3-smoke-test`:
  - `/` returns the Bun HTML shell
  - Bun-generated JS/CSS chunk assets resolve successfully
  - `/api/health` returns the app runtime health JSON
  - `/api/mentra/auth/init` returns the expected 400 when no auth token is provided

## Important Compatibility Findings

### Safe To Preserve In First Pass

- Keep the current websocket message shapes.
- Keep existing cloud routes working unchanged.
- Keep legacy `AppServer` and `AppSession` import paths usable.
- Make cloud changes additive and version-aware if needed.

### Still High-Risk / Needs Care

- camera is no longer a hard blocker, but the mixed model remains subtle:
  - public v3 `session.camera.takePhoto()` still assumes top-level `PHOTO_RESPONSE`
  - legacy-compatible `requestPhoto()` on `MiniAppServer` sessions now uses `/photo-upload`
  - this split is intentional for now but should stay documented
- permissions in the staged managers are cleaner than the currently exposed cloud payloads and may need compatibility handling.
- reconnect semantics in the 048 spike go beyond the currently deployed cloud `AppSession` behavior.
- inherited `AppServer` behavior still assumes enough of the old `AppSession` surface that more edge-case compatibility review is still warranted.
- cloud-side reconnect protocol now exists in first-pass form:
  - `/app-ws` Bun handler recognizes v3 `RECONNECT`
  - cloud now supports `RECONNECT_DEFERRED`, `RECONNECT_ACK`, and `RECONNECT_REJECTED`
  - deferred unattached app sockets are held outside `UserSession`
  - `AppManager.startApp()` can consume a deferred socket instead of always issuing a fresh webhook
- webhook/bootstrap contract cleanup has also advanced:
  - `SessionWebhookRequest` now has canonical `websocketUrl`
  - legacy `mentraOSWebsocketUrl` and `augmentOSWebsocketUrl` remain as compatibility aliases
  - cloud now emits the canonical namespaced websocket URL (`/ws/miniapp`) while still including legacy aliases
  - JWT-authenticated fresh app websocket init no longer requires `x-session-id`; reconnect still does

## Remaining Work

### SDK

1. `MentraSession` orchestrator now exists and is being used by `MiniAppServer` webhook session creation, but it still needs broader runtime validation against inherited `AppServer` behaviors.
2. Keep the current `MiniAppServer` bridge working while the real orchestrator is hardened.
3. Continue validating which managers are safe to fully trust against the current cloud contract:
   - lower risk: transcription, translation, display, speaker, mic, device, phone, dashboard, led, location, time
   - medium risk: camera now mostly covered but still split across new/public vs compat/server photo paths
   - higher risk: storage, permissions edge cases
4. Add compatibility surfaces on top of the real session as needed:
   - deprecated `session.events`
   - legacy module/property aliases
   - old convenience methods
5. Validate reconnect and stop semantics against live cloud assumptions.
6. Keep deprecated compatibility shims in place until migration docs and validation are complete.

### Cloud

Still required in this refactor:

1. Keep removing remaining hybrid identity assumptions from cloud websocket/session handling.
2. Confirm `CONNECTION_ACK` / `RECONNECT_ACK` contain everything the real `MentraSession` managers need.
3. Audit reconnect/session state behavior against the new SDK timing and deferred attach model.
4. Validate cloud restart, resurrection, and manual stop behavior end to end.

Deferred unless explicitly pulled in:

1. full reconnection architecture rewrite from the spike
2. user/session identity redesign beyond the current cloud-owned app-session UUID
3. local-runtime support
4. mobile protocol changes

## Recommended Next Implementation Step

Audit and close the remaining compatibility edges around inherited `AppServer` behavior and the cloud websocket bootstrap path now that `MiniAppServer` webhook lifecycle is already on the new `MentraSession` runtime.

The biggest runtime questions left are no longer naming or scaffolding; they are compatibility edge cases, reconnect/resurrection behavior, and the last old `AppSession` assumptions in the inherited server path.
