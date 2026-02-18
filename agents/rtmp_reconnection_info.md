# RTMP Reconnection & Resilience Notes

## Historical Issues

- **Silent uplink stalls on hotspot transitions**
  - Symptom: Stream stays “connected” but Cloudflare stops receiving video when the hotspot’s cellular backhaul blips.
  - Root Cause: Wi‑Fi link stays associated, TCP socket never faults, StreamPack keeps writing into a black hole.
  - Impact: Frozen video, no disconnect signal, TPAs assume livestream is still active.

- **Long outages recovered but without fresh keyframe**
  - Symptom: After a 4–5s hotspot outage the stream reconnects automatically, but Cloudflare doesn’t resume video until the next keyframe.
  - Root Cause: Encoder restarts without forcing IDR frame; ingest waits for GOP boundary.

- **RTMP packet flow unmonitored**
  - Symptom: No visibility into whether bytes are actually leaving the device; reconnection logic relied solely on socket errors.
  - Root Cause: StreamPack’s mux listener didn’t expose packet telemetry; RtmpStreamingService lacked a send watchdog.

## Fixes Deployed

1. **Network validation watchdog** (Oct 17)
   - Registers `ConnectivityManager` callback and forces reconnection when validated upstream disappears for >5s.
   - Handles cases where hotspot Wi‑Fi drops entirely.

2. **RTMP reachability probe**
   - Runs a tight TLS/TCP handshake against the ingest host every second (1.5s timeout).
   - After 1 consecutive failure we schedule `scheduleReconnect("reachability_probe_failed")`.
   - Shallow handset backhaul drops now trigger reconnection even if Wi‑Fi remains associated.

3. **Packet-stall watchdog & telemetry**
   - StreamPack’s mux path now exposes `OnPacketListener` events for each successful `endpoint.write`.
   - RtmpStreamingService keeps a millisecond timestamp for the last packet and triggers reconnection if no packets are sent for ≥1s.
   - Prevents “socket still up but no bytes flowing” zombie state.

4. **Immediate keyframe request on reconnect**
   - Added `MediaCodecEncoder.requestKeyFrame()` hook.
   - After each successful reconnection we call it so Cloudflare gets an IDR frame immediately and the stream resumes visually.

5. **Telemetry additions**
   - `StreamingReporting` records network validation loss, reachability failures, and packet stalls for better observability.

## Remaining Edge Cases & Future Work

- **Ultra-fast (~<500ms) uplink blips**
  - Current watchdog (500ms poll / 1s stall) may still miss sub-500ms outages where Cloudflare drops the keyframe.
  - Options: track two consecutive 500ms misses (add 0.5s slack), or request keyframe periodically when audio-only/video-only flow detected.

- **Link-property changes without validation drop**
  - Some hotspot transitions only flip default route without toggling validation.
  - Consider listening to `onLinkPropertiesChanged` and forcing reconnect when Wi‑Fi default route or DNS changes.

- **Encoder imbalance detection**
  - If we see sustained audio but no video packets (or vice versa), trigger keyframe or restart.
  - Requires tracking packet types in the mux listener.

- **Cloudflare ingest quirks**
  - Even after reconnection, Cloudflare sometimes delays video resumption. Continually monitor ingest reports and consider backoff strategies.

- **Watchdog tuning**
  - Continue monitoring logs; adjust probe interval/timeouts if we see excessive reconnect thrash or missed stalls.

## Recommendations

1. Monitor new telemetry (packet stall, reachability failures) in crash/analytics dashboards.
2. If ultra-short freezes persist, implement a dual-threshold packet watchdog (two consecutive misses) and/or keyframe-on-demand when no video packets for N ms.
3. Research hooking camera encoder to request keyframe in response to key network events beyond reconnect (e.g. on keep-alive miss).
4. Document testing playbooks for hotspot toggles and share log expectations with QA.
