# 001: Add Observability to LiveKit Bridge

**Status**: DONE

## Problem

The Go livekit-bridge had zero visibility in BetterStack for audio playback operations. All logging used `log.Printf()` which only goes to stdout, not to our centralized logging.

When investigating audio playback failures, we found:

- PlayAudio requests returning `FAILED` with empty error strings
- No way to see what happened between request and failure
- No correlation between Go logs and TypeScript logs (different field names)

## Solution

Added comprehensive BetterStack logging to the Go livekit-bridge.

### Changes Made

#### 1. Logger Improvements (`logger/betterstack.go`)

- **Standardized field names** to match TypeScript:
  - `userId` at root level (was `extra.user_id`)
  - Added `sessionId`, `roomName`, `requestId`, `trackId`, `trackName`
  - Added `env`, `server`, `region` for environment context
  - Added `feature` field for filtering

- **Added typed fields** for audio-specific data:
  - `audioUrl`, `contentType`, `durationMs`, `sampleRate`, `channels`, `bytesRead`
  - `totalSamples`, `receivedPackets`, `droppedPackets`

- **Added ContextLogger** for carrying user context through call chains:
  ```go
  lg := s.bsLogger.WithContext(logger.LogContext{
      UserID:    req.UserId,
      RequestID: req.RequestId,
      Feature:   "livekit-grpc",
  })
  lg.Info("PlayAudio request received", logger.LogEntry{AudioURL: url})
  ```

#### 2. Service Logging (`service.go`)

Added logging to all gRPC methods:

- `JoinRoom` - room join, session replacement, connection success/failure
- `LeaveRoom` - leave requests, session cleanup
- `StreamAudio` - stream lifecycle, errors
- `PlayAudio` - full request lifecycle with URL validation
- `StopAudio` - stop requests, track cleanup
- `HealthCheck` / `GetStatus` - status queries

#### 3. Playback Logging (`playback.go`)

Added detailed logging for audio processing:

- HTTP fetch: duration, status code, content-type, content-length
- Format detection: MP3 vs WAV routing
- Decoder init: sample rate, channels, resample ratio
- Progress: every 5 seconds (samples processed, bytes read)
- Completion: total samples, duration, any errors

#### 4. Session Logging (`session.go`)

Added logging for track management:

- Track creation with sample rate, channels
- Track publishing with SID
- Track close operations
- Playback stop (all tracks vs single track)
- Session close with resource counts

### URL Validation Fix

Also added URL validation to catch invalid URLs early:

```go
if req.AudioUrl == "" || req.AudioUrl == "nothing" || !hasValidScheme(req.AudioUrl) {
    // Return clear error instead of cryptic "unsupported protocol scheme"
}
```

This catches the app-side bug where `camera.template.aryan` was sending `audioUrl: "nothing"`.

## Example Logs

After these changes, BetterStack will show:

```json
{"dt":"...","level":"info","env":"debug","server":"livekit-bridge","service":"livekit-bridge","feature":"livekit-grpc","userId":"user@email.com","requestId":"audio_req_123","trackId":2,"trackName":"tts","message":"PlayAudio request received","audioUrl":"https://..."}

{"dt":"...","level":"info","userId":"user@email.com","message":"Audio file fetched successfully","audioUrl":"https://...","contentType":"audio/mpeg","durationMs":150}

{"dt":"...","level":"info","userId":"user@email.com","trackName":"tts","message":"Track published successfully","extra":{"track_sid":"TR_abc123"}}

{"dt":"...","level":"info","userId":"user@email.com","message":"MP3 playback complete","totalSamples":48000,"bytesRead":12000,"durationMs":3000}
```

## Files Changed

- `cloud/packages/cloud-livekit-bridge/logger/betterstack.go`
- `cloud/packages/cloud-livekit-bridge/service.go`
- `cloud/packages/cloud-livekit-bridge/playback.go`
- `cloud/packages/cloud-livekit-bridge/session.go`

## Next Steps

1. Deploy to debug environment
2. Reproduce the "first works, subsequent fail" issue
3. Analyze new logs to find where playback fails
