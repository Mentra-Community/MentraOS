# Spike: G1 Captions Dropout After BLE Reconnect

## Overview

**What this doc covers:** Investigation of a user-reported complete captions failure on Even Realities G1, traced through phone logs, cloud logs, and BetterStack telemetry to identify three compounding failure modes.
**Why this doc exists:** A user reported captions working for ~20 minutes in a staff meeting then completely disappearing. Multiple app restarts failed to restore transcription. The Even Realities native transcription worked fine on the same glasses immediately after, ruling out hardware failure — this is a MentraOS pipeline issue.
**Who should read this:** Mobile engineers (BLE reconnect path), cloud engineers (transcription stream lifecycle), anyone working on resilience of the audio/transcription pipeline.

---

## Background

The transcription pipeline requires three things to work simultaneously:

1. **BLE mic** — the G1 glasses send audio from the right arm over BLE to the phone
2. **UDP audio** — the phone encodes and streams that audio to the cloud via encrypted UDP
3. **Soniox stream** — the cloud holds an open Soniox SDK stream, feeds it audio, and forwards transcripts to apps

If any leg breaks, transcription stops. This incident involved all three breaking in sequence.

---

## Timeline (from BetterStack, times in UTC)

All times are UTC. The user is in Melbourne (AEDT = UTC+11), so UTC times + 11h = local time.

```
02:03:50  Session created. Soniox initialized.
02:04:10  🚀 STREAM CREATED: [SONIOX] for "transcription:en-US" (718ms)
02:04:12  First UDP audio packet received in AudioManager  ← audio flowing ✅
02:04:22  UDP audio stats (every 10s)  ← healthy for next 10 minutes
...
02:14:05  Last UDP audio stats before failure
02:14:15  ❌ Glasses WebSocket closed / Glasses connection closed  ← first disconnect
          [audio stats stop here — no more UDP audio flowing after this point]
02:15:38  ❌ Glasses WebSocket closed again  ← reconnected but immediately dropped
02:17:52  ❌ Glasses WebSocket closed
02:19:22  ❌ Glasses WebSocket closed
02:20:04  One brief UDP audio stats (momentary reconnect)
02:20:05  ❌ Glasses WebSocket closed
02:21:05  Soniox translation provider disposed
02:21:05  Disposing Soniox provider  ← transcription pipeline fully torn down
```

So the real failure window is 02:04–02:14 UTC (~1:04–1:14 PM AEST) — 10 minutes of working transcription before the first disconnect. The user experienced it as ~20 minutes because captions text lingers on the display after audio stops.

After 02:14:15, the phone reconnected repeatedly but transcription never recovered. By 02:21, the Soniox provider was disposed. The user then restarted the app four more times to no effect.

When the user filed the bug report (~7:40 PM local), they were on cellular — and UDP was completely broken at that point (see Finding 3).

---

## Findings

### 1. Glasses WebSocket disconnecting repeatedly — BLE GATT characteristic failure

After the first disconnect at 02:14:15, the glasses WebSocket reconnects within ~90 seconds but drops again. This cycle repeats five times in six minutes (02:14, 02:15, 02:17, 02:19, 02:20).

From the phone logs, every BLE command issued to the G1 produces this pattern:

```
CORE: G1: ⚠️ peripheral/characteristic not found, resuming immediately
CORE: G1: trying again to send to:L: 1
CORE: G1: ⚠️ peripheral/characteristic not found, resuming immediately
CORE: G1: trying again to send to:R: 1
... (4 retries)
CORE: G1: ❌ Command timed out!
CORE: G1: Reconnection attempt 1
CORE: G1: connnectedDevices.count: (2)
CORE: G1: Connected to device: Even G1_40_L_9D35C7
CORE: G1: Connected to device: Even G1_40_R_013AC2
CORE: G1: 🔵 Attempting to connect by UUID
```

The devices are visible in BLE scan (both arms found), but GATT characteristic discovery is failing on every attempt. The phone can see the glasses but cannot read or write any characteristics — commands queue up, retry 4 times at 100ms intervals, then time out.

This means:

- Mic enable/disable commands never reach the glasses
- The glasses microphone is effectively stuck in whatever state it was last successfully set to
- When the cloud sends `mic_state_change`, the phone tries to push it over BLE, the BLE command times out, and the mic stays in the last known state

**Why the Even Realities native transcription worked:** ER's own app uses a separate BLE connection profile and their own firmware-level audio path. When the user unpaired from MentraOS and connected via the ER app, the G1 GATT services were fully re-negotiated with a fresh connection. The degraded state MentraOS was in didn't carry over to the ER app.

**What likely triggered the degraded state:** The G1 GATT service became unavailable after ~10 minutes of continuous use — possibly the right arm entering a power-saving mode mid-session, or the phone's Core Bluetooth stack losing service discovery for the G1 without triggering a proper disconnect event. The phone thinks it's connected (devices found in scan) but GATT is not functional.

### 2. Soniox stream not recreated after WebSocket reconnect

When the phone WebSocket to the cloud reconnects after the first drop, the cloud takes the fast path:

```
[UserSession:createOrReconnect] Existing session found, updating WebSocket
[UserSession:updateWebSocket] Updating WebSocket connection for user
[UserSession:setupGlassesHeartbeat] Heartbeat established
[UserSession:updateWebSocket] Scheduling mic state resync after WebSocket reconnect
```

The UserSession is reused, WebSocket is swapped in, and a mic resync is scheduled. But there is **no Soniox stream recreation** in this path.

After 02:14:15, the logs show zero `STREAM CREATED` entries — the Soniox stream that was opened at 02:04:10 is never reopened. The cloud's subscription manager evaluates existing streams and finds them "healthy" (the stream object still exists), but audio has stopped flowing because the mic is stuck on the glasses side.

The result: the Soniox stream is open, audio arrives at zero packets, no transcription is produced. The cloud doesn't detect that audio has gone silent — it has no "no audio received in N seconds" watchdog.

Two problems stacked:

1. The reconnect path doesn't force stream health re-evaluation
2. There's no dead-stream detection (Soniox stream open but receiving 0 bytes for an extended period)

### 3. UDP IPv4 failure on IPv6-only cellular — subsequent attempts fully blocked

From the phone logs at feedback submission time (~7:40 PM local, on cellular):

```
UDP: Initial probe for 20.239.105.210:8000
UDP: Failed to send ping: IPv6 has been deactivated due to bind/connect,
     and DNS lookup found no IPv4 address(es).
UDP: Ping send failed, retrying...
[repeats 3 times, then]
UDP: Probe timed out after all retries
UDP: Stopped
[5 seconds later: Retry probe → same failures]
```

The UDP endpoint `20.239.105.210` is a raw IPv4 address (East Asia cluster). On Australian cellular networks, many carriers (Telstra, Optus, Vodafone) run IPv6-only access networks. Reaching a raw IPv4 address from an IPv6-only network requires NAT64, but NAT64 only works with hostnames — it can't synthesize an IPv6 destination for a raw IPv4 literal.

So every UDP probe fails permanently when the phone is on cellular with an IPv6-only carrier. The cloud correctly registers each UDP probe arrival (`Session registered for UDP audio - ready to receive packets`), but the phone can never actually send audio packets.

This explains why restarting the app four times didn't help: by the time the user was attempting reconnection, the underlying cellular network had taken over from WiFi (or the WiFi at the meeting venue was gone), and UDP was structurally broken regardless of app state.

The initial session likely worked on the venue's WiFi (dual-stack, both IPv4 and IPv6), and the failure at 02:14 coincided with a WiFi interruption that triggered the BLE degradation.

### 4. DisplayManager not ready on reconnect

In the cloud logs provided with the incident (the final reconnection at ~02:40 UTC), there are repeated warnings throughout the reconnection burst:

```
Display request not sent - DisplayManager is not ready for user
```

These fire dozens of times across the reconnection window, suggesting the display pipeline is also not initializing cleanly during rapid reconnect cycles. This is a secondary symptom — display worked before the failure — but it shows the reconnect path has multiple services that don't come back cleanly.

---

## Conclusions

| Finding                                                                   | Severity | Layer                |
| ------------------------------------------------------------------------- | -------- | -------------------- |
| G1 GATT characteristic discovery failing after ~10min session — mic stuck | High     | Mobile / G1 firmware |
| Soniox stream not recreated on WebSocket reconnect                        | High     | Cloud                |
| No dead-stream detection (0 audio bytes for extended period)              | High     | Cloud                |
| UDP IPv4 fails permanently on IPv6-only Australian cellular               | High     | Mobile / Infra       |
| DisplayManager not ready during rapid reconnect cycles                    | Medium   | Cloud                |

The failure is a cascade:

```
G1 GATT degrades after 10min
  → BLE commands time out
  → Mic enable fails silently
  → UDP audio stops flowing (no source)
  → Soniox gets 0 bytes (no watchdog to detect this)
  → WebSocket drops (maybe related to BLE / keep-alive interaction)
  → Reconnect fast-path skips stream recreation
  → UDP now on cellular IPv6-only → structurally broken
  → Transcription never recovers across 4+ restarts
```

The Even Realities native app bypasses all of this because it owns its own BLE profile, its own audio path, and doesn't depend on MentraOS cloud infrastructure.

---

## Next Steps

1. **Cloud:** Add a watchdog to the transcription pipeline — if a Soniox stream has received 0 audio bytes for >30s while `hasMedia=true` subscriptions are active and glasses are marked connected, tear down and recreate the stream.
2. **Cloud:** Force stream health re-evaluation (not just `updateWebSocket`) in the fast-path reconnect. If subscriptions call for an active transcription stream and none is healthy, create one.
3. **Mobile:** Investigate G1 GATT degradation after extended sessions. Does the right arm BLE service become unavailable? Is there a keepalive or re-discovery that should be triggered periodically?
4. **Mobile / Infra:** Use a hostname (not raw IP) for the UDP endpoint so NAT64 can resolve it on IPv6-only cellular networks. Or add fallback UDP paths via hostname-based endpoints per region.
5. Write `spec.md` once the cloud-side watchdog and reconnect behavior are agreed on.
