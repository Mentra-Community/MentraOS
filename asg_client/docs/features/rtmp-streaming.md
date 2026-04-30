# Live streaming (RTMP / SRT / WHIP)

ASG Client streams the camera feed to a remote server in real time. Three protocols are supported and selected automatically by URL prefix:

| Prefix | Protocol | Service class |
|--------|----------|---------------|
| `rtmp://` / `rtmps://` | RTMP | `RtmpStreamingService` |
| `srt://` | SRT | `SrtStreamingService` |
| `https://` / `http://` | WHIP (WebRTC) | `WhipStreamingService` |

Source: `app/src/main/java/com/mentra/asg_client/io/streaming/services/`. Phone-side dispatch goes through `StreamCommandHandler`.

The wire-level command schema (request fields, response types, error codes) lives in [ASG_CLIENT_API.md → Streaming](../ASG_CLIENT_API.md#streaming-rtmp--srt--whip). This doc covers the **lifecycle** and **operational behavior**.

## Commands

Four commands handle all three protocols:

- `start_stream` — start a stream (URL prefix selects the protocol)
- `stop_stream` — stop whichever stream is active
- `get_stream_status` — query streaming/reconnecting state
- `keep_stream_alive` — heartbeat to extend the timeout

See the [API doc](../ASG_CLIENT_API.md#streaming-rtmp--srt--whip) for fields and response shapes.

## Stream lifecycle

### Start

1. **Validate URL.** The URL prefix selects the protocol; an unknown prefix is rejected with `Unknown stream URL protocol`.
2. **Battery check.** Reject if battery is below `BatteryConstants.MIN_BATTERY_LEVEL` (currently 10%) — `BATTERY_LOW` error.
3. **WiFi check.** All three protocols require WiFi.
4. **Stop any existing stream** to avoid camera contention; brief pause so the camera HAL releases.
5. **Resolution check (WHIP only).** Reject if requested resolution exceeds the camera's supported output (`WhipCameraFormatSelector`).
6. **Disable EIS** during streaming to reduce camera HAL thermal load (`SysControl.setEisEnable(context, false)`). Re-enabled on stop.
7. **Start the protocol-specific service** with the resolved `streamId`, `flash`, `sound`, and the protocol's config object.

### Active stream

Status callbacks emit `stream_status` messages back to the phone. Status values include `streaming_started`, `reconnecting`, `error`, `stopping`, `error_not_streaming`.

### Keep-alive timeout

Each stream has a **60-second inactivity timeout** (`STREAM_TIMEOUT_MS = 60000` in each `*StreamingService`). The phone must call `keep_stream_alive` regularly to prevent it.

```
phone   ─►  glasses : keep_stream_alive (streamId, ackId)
glasses ─►  phone   : keep_alive_ack (streamId, ackId)
```

Recommended cadence: every 15 seconds. The phone gets up to ~3 missed ACKs before considering the link degraded.

`StreamCommandHandler` validates the `streamId` against the active stream and silently drops keep-alives missing either `streamId` or `ackId`.

### Reconnect

If the network drops mid-stream, the streaming service enters reconnect:

- `isReconnecting()` returns true
- `getReconnectAttempt()` reports the attempt counter
- Status response includes `"reconnecting": true, "attempt": N`

The reconnection backoff is internal to each streaming service. The phone can call `get_stream_status` at any time to inspect the current attempt.

### Stop

`stop_stream` finds whichever service is currently active (`isStreaming()` or `isReconnecting()`), calls `stopStreaming(context)`, and re-enables EIS.

If no stream is active, the response is `error_not_streaming`.

## Resource constraints

- **Battery** — start gated at `MIN_BATTERY_LEVEL`. The phone gets `BATTERY_LOW` and the user hears a low-battery audio cue.
- **WiFi** — required for all three protocols. Mobile data is not used.
- **Camera contention** — only one stream at a time; starting a second stream stops the first. Buffer recording, photos, and video recording all share the same camera and yield to (or reject) streams.
- **Thermal** — EIS is disabled while streaming.

## Network expectations

| | Minimum | Recommended |
|---|---------|-------------|
| Upload bandwidth | 1 Mbps | 2-3 Mbps |
| Latency | < 200 ms RTT | < 100 ms RTT |
| Stability | reconnects within ~30 s tolerated | sustained connection |

## Logcat tags

| Tag | What |
|-----|------|
| `StreamCommandHandler` | Command dispatch, protocol detection |
| `RtmpStreamingService` | RTMP lifecycle, reconnect |
| `SrtStreamingService` | SRT lifecycle |
| `WhipStreamingService` | WHIP lifecycle |
| `WhipCameraFormatSelector` | WHIP resolution validation |
| `MediaManager` | Status callback dispatch over BLE |

Useful filters:

```bash
# Everything streaming-related
adb logcat | grep -E "StreamCommandHandler|RtmpStreamingService|SrtStreamingService|WhipStreamingService"

# Keep-alive traffic
adb logcat | grep -E "keep_stream_alive|keep_alive_ack"
```

## Common issues

- **Stream stops after ~60 s** — keep-alives aren't reaching the glasses, or `streamId` doesn't match the active stream.
- **`error_not_streaming` on stop** — stream already stopped on its own (timeout, reconnect-failure). Treat as idempotent.
- **WHIP `Resolution too high`** — requested `width`/`height` exceeds what the camera can output. Reduce resolution or let the config use defaults.
- **Stream won't start** — check the `BATTERY_LOW` / `no_wifi_connection` error details and the `Unknown stream URL protocol` log.
