# 009: Bun Time - Cloud Architecture Refactor

Refactor cloud WebSocket services to leverage Bun's native capabilities and clean up architectural code smells.

## Documents

- **bun-time-spec.md** - Problem, goals, constraints
- **bun-time-architecture.md** - Technical design and implementation plan

## Sub-Issues

- **001-extract-message-routing.md** - Move message handling from WebSocket services to UserSession/Managers
- **002-bun-native-websocket.md** - Replace `ws` package with Bun's native WebSocket server
- **003-config-extraction.md** - Move hardcoded values (CORS, timeouts) to config
- **004-metrics-observability.md** - Add connection metrics, correlation IDs, structured logging
- **005-dead-code-cleanup.md** - Remove dead WebSocket handlers from core→mantle migration

## Quick Context

**Current**: WebSocket services (`websocket-glasses.service.ts`, `websocket-app.service.ts`) are 1200+ lines each with giant switch statements handling 20+ message types inline. Using Node.js `ws` package instead of Bun's native WebSocket. No connection metrics.

**Proposed**: Thin WebSocket services that only handle connection lifecycle. Message routing delegated to `UserSession` → Managers. Native Bun WebSocket for performance. Proper metrics/observability layer.

## Key Context

The `UserSession` → Manager → Session hierarchy is already solid (good work on that refactor). The remaining cleanup is moving the message handling logic OUT of WebSocket services and INTO this hierarchy. WebSocket services should be ~200 lines, not ~1200.

## Priority Order

1. **001-extract-message-routing** - Biggest impact, lowest risk
2. **003-config-extraction** - Quick win, reduces noise
3. **004-metrics-observability** - Needed for production visibility
4. **002-bun-native-websocket** - Performance win, but more invasive

## Status

- [x] 001: Extract message routing to UserSession ✅ COMPLETE
- [x] 002: Bun native WebSocket migration ✅ COMPLETE
- [x] 003: Config extraction (CORS only) ✅ COMPLETE
- [ ] 004: Metrics and observability layer
- [x] 005: Dead code cleanup (core→mantle migration) ✅ COMPLETE

## Key Files

- `packages/cloud/src/index.ts` - Entry point, Express + http.Server
- `packages/cloud/src/services/websocket/websocket.service.ts` - WebSocket server setup
- `packages/cloud/src/services/websocket/websocket-glasses.service.ts` - 1256 lines, needs slimming
- `packages/cloud/src/services/websocket/websocket-app.service.ts` - 1062 lines, needs slimming
- `packages/cloud/src/services/session/UserSession.ts` - Target for message routing
- `packages/cloud/src/services/session/AppManager.ts` - Already has good patterns
- `packages/cloud/src/services/session/AppSession.ts` - Per-app state container
