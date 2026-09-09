# Spike: UDP liveness and reversible WebSocket audio fallback

**Status:** Spiked. Needs implementation and test harness work.

## Motivation

UDP is the right primary transport for production audio: it has lower overhead
and matches the cloud-v2 stateless audio ingress design. But some networks allow
the WebSocket control/session path while blocking UDP completely. In that case,
the phone can look connected, the mic can be active, and the runtime WebSocket can
keep passing pings/pongs, but the cloud never receives audio.

The fix is not transcript inference. Soniox, subscriptions, provider workers, or
codec mismatches can all produce "no transcript" while UDP is fine. We need a
direct transport signal: can a UDP packet for this session reach cloud right now?

## Current cloud-v2 state

- `@mentra/cloud-client` opens the runtime WebSocket and sends audio through
  `UdpAudio`.
- `RuntimeSnapshot` now exposes runtime WebSocket state and
  `audioTransport: "udp" | "ws" | "none"`.
- The runtime/cloud side already has a documented WS binary audio fallback path
  in `002-cloud-runtime/audio/design.md`, and both UDP and WS binary audio
  converge into the same Redis audio stream.
- The missing piece is phone-side transport selection and UDP liveness.

## Previous v1 system

Useful pieces to carry forward:

- `mobile/src/services/SocketComms.ts` configured UDP from `connection_ack` and
  handled `udp_ping_ack`.
- The retired V1 runtime sent `udp_ping_ack` back over the WebSocket after its
  UDP server saw a ping, and separated UDP ping handling from audio forwarding
  so ping packets did not become transcription audio.

The important lesson is that UDP liveness should be acknowledged over the already
authenticated WebSocket. That lets the client prove the exact network path:

```txt
phone UDP packet -> runtime UDP ingress -> runtime WS ack -> phone
```

## Previous-system issue to avoid

The old behavior could fall back to WebSocket audio and then stay there. That is
not acceptable for cloud-v2. WebSocket audio is the last-resort cloud path, not a
permanent mode. UDP must keep being tested while WS fallback is active, and one
successful UDP ack should move the session back to UDP.

## Clarified product behavior

We are not trying to score UDP quality. The condition is binary:

- if at least one UDP liveness packet gets through, UDP is available;
- if no UDP liveness packets get through within the timeout, UDP is unavailable.

No multi-probe confidence threshold is required. The design is intentionally
simple because the failure mode we care about is network policy or path change:
UDP is either traversing the user's current network or it is not.

## Fallback rule

Only fall back to WebSocket audio when both are true:

- the runtime WebSocket is alive, using the existing ping/pong liveness system;
- UDP liveness is dead for the current runtime audio session.

If WebSocket is not alive, WS audio fallback is not available. In that case the
client should report no usable cloud audio transport and let local/offline
fallback policy handle the user-visible behavior.

## Open questions

- Exact UDP probe wire encoding: reserve a probe frame type inside the encrypted
  UDP payload, or define a small authenticated probe packet alongside audio.
- Exact timeout/cadence values for mobile battery and recovery latency.
- Whether normal UDP audio packets should also count as liveness when already on
  UDP. The likely answer is yes.
- Whether the runtime should expose per-session UDP liveness telemetry for
  Porter dashboards and harness assertions.
