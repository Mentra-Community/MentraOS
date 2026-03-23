# 📸 Photo Request Test App

**Verifies OS-947 & OS-951** — Mini apps get specific photo error messages instead of generic 30-second timeouts.

## Problem

When a photo capture fails (camera busy, streamer running, no glasses connected, etc.), the error flows:

1. Phone → Cloud REST (`POST /api/client/photo/response`)
2. Cloud → SDK via WebSocket (`PhotoResponse` with `success: false`)
3. SDK's `handleMessage()` receives it

**Before the fix:** The Hono SDK ignored this WebSocket message, logging "Legacy photo response" and doing nothing. The developer's `await camera.requestPhoto()` would hang for 30 seconds then reject with a generic "Photo request timed out" — giving no indication of what actually went wrong.

**After the fix:** The SDK properly resolves/rejects the pending photo request promise from the WebSocket `PhotoResponse`, so developers get immediate, specific error messages like `CAMERA_BUSY: Streamer is running`.

## What This App Tests

| Test | What It Verifies |
|------|-----------------|
| **📸 Take Photo** | Standard photo request — success path via `/photo-upload` HTTP |
| **📷 Small + Compressed** | Photo with `size: small` and `compress: heavy` options |
| **⚡ Rapid Fire (3x)** | Multiple concurrent photo requests — stress test |
| **Error detection** | Whether errors arrive as specific messages (✅ PASS) or generic timeouts (❌ FAIL) |

Each result card shows:
- **Status**: success / error / timeout / pending
- **Duration**: how long the request took (errors should be fast, not 30s)
- **Error message**: the actual error string from the SDK
- **Verdict**: PASS (got specific error) or FAIL (got generic timeout = OS-947 not fixed)

## How to Run

```bash
# From the monorepo root
cd cloud/packages/apps/photo-test

# Install dependencies (uses workspace:* for @mentra/sdk)
bun install

# Set required env vars
export PACKAGE_NAME="com.mentra.phototest"      # or your registered package name
export MENTRAOS_API_KEY="your-api-key-here"

# Run in dev mode (hot reload)
bun run dev
```

Then open `http://localhost:3000` in a browser.

### Using the Dashboard

1. **Connect your glasses** — launch the app on your MentraOS glasses
2. **Enter your User ID** in the input field (get it from the glasses session or server logs)
3. **Click Connect** to start the SSE stream
4. **Click "📸 Take Photo"** to trigger a photo request
5. **Observe the result card**:
   - ✅ **success** — photo captured, shows size
   - ✅ **error with specific message** — e.g., `CAMERA_BUSY: Streamer is running` (this is the fix working!)
   - ❌ **timeout** — generic "Photo request timed out" after 30s (OS-947 NOT fixed)

### Testing the Error Path

To deliberately trigger a photo error:
- Start an RTMP stream on the glasses, then request a photo → should get `CAMERA_BUSY` error
- Start video recording, then request a photo → should get a specific error
- Disconnect glasses WiFi, then request a photo → should get a connection error

The key metric: **errors should arrive in < 5 seconds**, not 30 seconds.

## Architecture

```
Browser (dashboard)
  │
  ├─ POST /api/photo/take ──► PhotoTestApp.takePhoto()
  │                              │
  │                              ▼
  │                           session.camera.requestPhoto()
  │                              │
  │                              ▼
  │                    SDK sends PHOTO_REQUEST via WS
  │                              │
  │                    ┌─────────┴──────────┐
  │                    ▼                    ▼
  │              SUCCESS PATH          ERROR PATH
  │           (glasses → HTTP)    (phone → cloud → WS)
  │                    │                    │
  │                    ▼                    ▼
  │           /photo-upload         handleMessage()
  │           resolves promise      rejects promise ← THE FIX
  │                    │                    │
  │                    └─────────┬──────────┘
  │                              ▼
  │                     PhotoTestResult
  │                     (with timing data)
  │                              │
  ◄── SSE stream ───────────────┘
```

## Files

```
photo-test/
├── src/
│   ├── index.ts                    # Entry point + inline HTML dashboard
│   └── backend/
│       ├── PhotoTestApp.ts         # AppServer subclass + session store
│       └── api.ts                  # REST routes (take photo, results, SSE)
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
```

## Related

- **SDK fix**: `cloud/packages/sdk/src/app/session/index.ts` — `handleMessage()` now handles `isPhotoResponse()` properly
- **Cloud endpoint**: `cloud/packages/cloud/src/api/hono/client/photo.api.ts` — REST endpoint for phone error reporting
- **Camera module**: `cloud/packages/sdk/src/app/session/modules/camera.ts` — `requestPhoto()` implementation
- **Tickets**: OS-947 (photo error messages), OS-951 (camera busy during streaming)