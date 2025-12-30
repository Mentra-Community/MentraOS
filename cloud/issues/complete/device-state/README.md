# Device State REST API

REST endpoint for mobile to report glasses connection state. Cloud infers `connected` from `modelName` presence.

## Documents

- **device-state-spec.md** - Problem, API contract, success metrics
- **device-state-architecture.md** - Implementation details, code paths

## Quick Context

**Before**: Mobile sends stale state via WebSocket → 30% of display requests fail with `GLASSES_DISCONNECTED`

**After**: Mobile sends model name via REST → Cloud infers connection → 100% success

## Key Insight

If mobile knows the glasses model, glasses must be connected. No need for redundant `connected` field.

```typescript
// Mobile sends
{ modelName: "Mentra Live" }

// Cloud infers
{ connected: true, modelName: "Mentra Live" }
```

## Status

### Cloud (Done)

- [x] REST endpoint `/api/client/device/state`
- [x] Connection inference in DeviceManager
- [x] Clear getters: `isPhoneConnected` / `isGlassesConnected`
- [x] Remove redundant state flags (`phoneConnected`, etc.)
- [x] Logging with `feature: "device-state"` tag

### Mobile (TODO)

- [ ] Call REST endpoint from CoreStatusProvider
- [ ] Remove Zustand glasses store
- [ ] Remove WebSocket `sendGlassesConnectionState()`

### Cleanup (After Mobile Deployed)

- [ ] Remove WebSocket `GLASSES_CONNECTION_STATE` handler
- [ ] Remove Simulated Glasses hotfix

## Key Metrics

| Metric                      | Before | Target | Current |
| --------------------------- | ------ | ------ | ------- |
| Display success rate        | 70%    | 100%   | Testing |
| GLASSES_DISCONNECTED errors | 30%    | 0%     | Testing |
| API latency p95             | N/A    | <50ms  | ~10ms   |

## Better Stack Query

```
feature:"device-state" AND userId:"user@example.com"
```

Shows: API requests, inference logs, validation checks, errors
