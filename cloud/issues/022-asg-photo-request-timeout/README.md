# Photo Capture Timeout Bug

ASG client camera keep-alive timer closes camera mid-capture, causing 30s timeouts in SDK.

## Documents

- **photo-system-architecture.md** - E2E photo capture flow from SDK to glasses
- **photo-timeout-bug.md** - Root cause analysis and fix

## Quick Context

**Current**: Photo requests intermittently time out after exactly 30 seconds. The pattern is random - sometimes several succeed in a row, then one fails.

**Root Cause**: The ASG client's `CameraNeo.java` has a keep-alive timer that isn't cancelled when processing immediate photo requests, causing the camera to close mid-capture.

## Key Context

The photo capture system spans 4 components: SDK (app server) → Cloud → Mobile App → ASG Client (glasses). When the keep-alive timer fires, the camera closes before the photo is saved/uploaded, so the SDK never receives a response and times out.

## Status

- [x] Root cause identified (CameraNeo keep-alive timer bug)
- [x] Architecture documented
- [ ] Fix implemented in ASG client
- [ ] Tested in production
