# 011: AppManager Refactor

Slim down AppManager (1613 lines) by moving per-app logic to AppSession, making AppManager a thin orchestrator.

## Documents

- **app-manager-spec.md** - Problem, goals, constraints
- **app-manager-architecture.md** - Technical design

## Quick Context

**Current**: AppManager is 1613 lines and handles app lifecycle, webhook calls, authentication, connection setup, state broadcasting, and message routing. Methods like `startApp()` (230+ lines) and `handleAppInit()` (220+ lines) do too much.

**Proposed**: AppSession owns per-app operations (authenticate, start, stop, webhook). AppManager becomes thin orchestrator (~400 lines) that creates/destroys AppSessions and handles multi-app operations.

## Key Context

AppSession was recently created to consolidate per-app state (WebSocket, subscriptions, heartbeat, grace period). The next step is moving per-app _operations_ there too. AppManager should just orchestrate - it shouldn't know how to authenticate an app or call a webhook.

## Current State

```
AppManager (1613 lines)
├── startApp() - 230+ lines (hardware check, DB lookup, webhook, wait for connection)
├── handleAppInit() - 220+ lines (auth, connection setup, subscription restore)
├── stopApp() - 130+ lines
├── handleAppConnectionClosed() - 100+ lines
├── sendMessageToApp() - message routing with resurrection
├── triggerAppWebhookInternal() - webhook calling
├── broadcastAppState() - multi-app state sync
└── startPreviouslyRunningApps() - restart logic

AppSession (820 lines)
├── Connection state machine
├── WebSocket lifecycle
├── Heartbeat management
├── Grace period handling
├── Subscription management
└── Ownership release tracking
```

## Proposed State

```
AppManager (~400 lines)
├── getOrCreateAppSession() - factory
├── removeAppSession() - cleanup
├── broadcastAppState() - multi-app operation
├── startPreviouslyRunningApps() - multi-app operation
├── refreshInstalledApps() - DB sync
└── route messages to AppSessions

AppSession (~1000 lines, owns per-app ops)
├── start() - hardware check, webhook, wait for connection
├── stop() - cleanup, optional restart
├── authenticate(initMessage) - JWT verify, connection setup
├── triggerWebhook() - call app server
├── handleConnectionClosed() - grace period or cleanup
├── [existing] state machine, heartbeat, subscriptions, etc.
```

## Status

- [ ] Design approved
- [ ] Move `authenticate()` logic to AppSession
- [ ] Move `triggerWebhook()` to AppSession
- [ ] Move `start()` logic to AppSession
- [ ] Move `stop()` logic to AppSession
- [ ] Slim AppManager to orchestrator role
- [ ] Update tests
- [ ] Verify no behavior change

## Key Files

- `packages/cloud/src/services/session/AppManager.ts` - 1613 lines → ~400 lines
- `packages/cloud/src/services/session/AppSession.ts` - 820 lines → ~1000 lines

## Dependencies

- Should be done after **009-001** (message routing extraction) since that also touches AppManager
- No mobile client changes required

## Related Issues

- **009-bun-time** - Message routing refactor touches AppManager
- **010-audio-manager-consolidation** - Similar pattern (consolidating related logic)
