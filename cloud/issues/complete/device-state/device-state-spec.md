# Device State REST API - Spec

## Overview

REST endpoint for mobile client to report glasses connection state. Cloud automatically infers `connected` from `modelName` presence, simplifying mobile implementation.

## Problem

Mobile maintains two sources of truth that never sync:

- `CoreStatusProvider.status.glasses_info.model_name` (from Android Core) ✅
- `useGlassesStore.connected` (Zustand) ❌ Stale

Result: Cloud thinks glasses disconnected when they're actually connected → display requests fail.

Production error rate: ~30% of display requests fail with `GLASSES_DISCONNECTED`

## Solution

Single REST endpoint for explicit state updates. Cloud infers connection from model name:

- `modelName` present → `connected: true`
- `modelName` null/empty → `connected: false`

Mobile only needs to send model name, not both fields.

## API Contract

### Endpoint

```
POST /api/client/device/state
Authorization: Bearer {coreToken}
Content-Type: application/json
```

### Request Body

Type: `Partial<GlassesInfo>` - send only changed properties

**Glasses connected:**

```json
{
  "modelName": "Mentra Live"
}
```

Cloud infers `connected: true` automatically.

**Glasses disconnected:**

```json
{
  "modelName": null
}
```

Cloud infers `connected: false` automatically.

**WiFi status change:**

```json
{
  "wifiConnected": true,
  "wifiSsid": "Home-Network"
}
```

**Explicit connection (optional):**

```json
{
  "connected": true,
  "modelName": "Mentra Live"
}
```

Explicit values override inference.

### Response (200 OK)

```json
{
  "success": true,
  "appliedState": {
    "isGlassesConnected": true,
    "isPhoneConnected": true,
    "modelName": "Mentra Live",
    "capabilities": {
      "modelName": "Mentra Live",
      "hasCamera": true,
      "hasDisplay": true,
      "hasMicrophone": true,
      "hasWifi": true
    }
  },
  "timestamp": "2025-11-13T22:19:16.272Z"
}
```

### Response (500 Error)

```json
{
  "success": false,
  "message": "Failed to update device state",
  "timestamp": "2025-11-13T22:19:16.272Z"
}
```

## GlassesInfo Type

From `@mentra/types`:

```typescript
export interface GlassesInfo {
  // Connection state
  connected?: boolean // Optional - inferred from modelName
  modelName?: string | null // Primary field - triggers inference

  // Device identification
  androidVersion?: string
  fwVersion?: string
  buildNumber?: string
  bluetoothName?: string
  serialNumber?: string

  // WiFi info (WiFi-capable devices only)
  wifiConnected?: boolean
  wifiSsid?: string | null
  wifiLocalIp?: string

  // Battery info
  batteryLevel?: number
  charging?: boolean
  caseBatteryLevel?: number

  // Hotspot info
  hotspotEnabled?: boolean
  hotspotSsid?: string
  hotspotPassword?: string

  // Metadata
  timestamp?: string
}
```

## Cloud Processing

```typescript
// 1. Infer connection state
if (payload.modelName && payload.connected === undefined) {
  payload.connected = true // Model present = connected
}
if (!payload.modelName && payload.connected === undefined) {
  payload.connected = false // No model = disconnected
}

// 2. Update device state
await userSession.deviceManager.updateDeviceState(payload)

// 3. Update capabilities (if model changed)
// 4. Stop incompatible apps
// 5. Notify MicrophoneManager
// 6. Update PostHog analytics
```

## Mobile Integration

CoreStatusProvider watches Core status and sends updates:

```typescript
// CoreStatusProvider.tsx
const payload = {
  modelName: parsedStatus.glasses_info?.model_name || null,
}

// Add WiFi if available
if (parsedStatus.glasses_info?.glasses_use_wifi) {
  payload.wifiConnected = parsedStatus.glasses_info.glasses_wifi_connected
  payload.wifiSsid = parsedStatus.glasses_info.glasses_wifi_ssid
}

restComms.updateDeviceState(payload)
```

## What Cloud Uses

**Primary (always):**

- `connected` - For hardware request validation
- `modelName` - For capability detection

**Secondary (conditional):**

- `wifiConnected` - For WiFi-requiring operations
- `wifiSsid` - For logging/debugging
- `timestamp` - For staleness detection (warns if >60s old)

**Future (available but unused):**

- Device metadata - For analytics
- Battery info - Already sent via separate stream
- Hotspot info - Mobile UI only

## Connection State Inference

**Rules:**

1. If `modelName` provided and not empty → `connected: true`
2. If `modelName` is null or empty string → `connected: false`
3. If `connected` explicitly provided → use explicit value (no inference)

**Examples:**

```typescript
// Mobile sends
{ modelName: "Mentra Live" }
// Cloud sees
{ connected: true, modelName: "Mentra Live" }

// Mobile sends
{ modelName: null }
// Cloud sees
{ connected: false, modelName: null }

// Mobile sends
{ connected: false, modelName: "Mentra Live" }
// Cloud sees - explicit wins (creates inconsistent state, avoid this)
{ connected: false, modelName: "Mentra Live" }
```

## Deployment

**Phase 1 (Done):**

- ✅ Cloud REST endpoint deployed
- ✅ Connection inference implemented
- ✅ DeviceManager refactored
- ✅ Backward compatible with WebSocket

**Phase 2 (Mobile team):**

- [ ] Mobile calls REST endpoint from CoreStatusProvider
- [ ] Remove Zustand glasses store
- [ ] Remove SocketComms.sendGlassesConnectionState()

**Phase 3 (After mobile deployed):**

- [ ] Remove WebSocket GLASSES_CONNECTION_STATE handler
- [ ] Remove legacy code paths

## Success Metrics

| Metric                      | Before     | Target | Current |
| --------------------------- | ---------- | ------ | ------- |
| Display request success     | 70%        | 100%   | TBD     |
| GLASSES_DISCONNECTED errors | 30%        | 0%     | TBD     |
| API latency p95             | N/A        | <50ms  | TBD     |
| State sync reliability      | Unreliable | 100%   | TBD     |

## Non-Goals

- ❌ Migrating battery updates to REST (already works via stream)
- ❌ Real-time connection monitoring (use WebSocket streams)
- ❌ Historical state tracking (not needed)
- ❌ Multiple device support (one glasses per user)

## Open Questions

1. **Should we deprecate explicit `connected` field entirely?**
   - Pro: Simpler API, impossible to have mismatched state
   - Con: Less flexible for edge cases
   - **Decision**: Keep both for now, revisit after mobile migration

2. **Should we validate WiFi fields only for WiFi-capable models?**
   - Currently: Accept any WiFi fields regardless of model
   - Alternative: Reject WiFi fields for BLE-only glasses
   - **Decision**: Accept all fields, ignore if not applicable (simpler)

3. **Timeout for stale state?**
   - Currently: Warn if >60s old, but still accept
   - Alternative: Reject if >5min old
   - **Decision**: Keep warning only, don't reject (network issues happen)
