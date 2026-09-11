# Design: UDP liveness and reversible WebSocket audio fallback

**Status:** Draft.

## Components

### `@mentra/cloud-client`

Add a runtime audio transport manager inside the runtime module. It owns:

- WebSocket liveness input from `Connection`;
- UDP liveness input from a new UDP prober;
- active transport selection;
- status emission;
- `sendAudioFrame` routing to UDP or WS.

Suggested files:

- `src/modules/runtime/audio-udp.ts`: keep UDP frame/probe construction and
  socket send.
- `src/modules/runtime/audio-ws.ts`: send binary audio frames on the live
  WebSocket.
- `src/modules/runtime/audio-transport.ts`: state machine that chooses UDP, WS,
  or none.
- `src/modules/runtime/status.ts`: keep public status types.

### React Native build

The React Native build must use the same transport manager. Only the injected
socket implementations differ:

- UDP socket from the native RN adapter.
- WebSocket from the RN runtime connection.
- Secure storage unchanged.

The mobile debug pill should keep reading `RuntimeSnapshot.audioTransport`.

### Node/Bun build

The Node build must support the same UDP probe and WS fallback path using `dgram`
and `ws`. This is required so CI can prove the transport policy without a phone.

### `@mentra/cloud-runtime`

Runtime needs to:

- recognize UDP liveness probes at ingress;
- validate that the probe belongs to a live session;
- send `audio.udp_liveness_ack` over that session's WebSocket;
- accept WS binary audio frames and write them to the same Redis audio stream as
  UDP audio frames;
- tag telemetry/logs with `transport=udp|ws|probe`.

## State machine

Internal cloud-client state:

```ts
type WsLiveness = "alive" | "dead"
type UdpLiveness = "unknown" | "alive" | "dead"
type RuntimeAudioTransport = "udp" | "ws" | "none"
```

Selection:

```txt
on ws_alive:
  if udp_alive -> udp
  else -> ws

on ws_dead:
  none

on udp_ack:
  udp_alive
  if ws_alive -> udp

on udp_timeout:
  udp_dead
  if ws_alive -> ws
  else -> none
```

No consecutive-success threshold. One UDP ack is enough.

## Probe cadence

Use short timeout values in tests and configurable values in production. The
production defaults should balance battery and recovery:

- send UDP probe on session start;
- while active transport is UDP, let real audio packets refresh liveness and send
  a low-rate probe only when no audio is flowing;
- while active transport is WS, send probes periodically so recovery is automatic.

The exact constants should live in cloud-client config with safe defaults and
test overrides.

## Avoid duplicate audio

When `audioTransport === "ws"`, real audio frames are sent only over WS. UDP
packets during this state are probes and must be ignored by the audio pipeline.

When `audioTransport === "udp"`, real audio frames are sent only over UDP. WS
binary audio is idle.

## Error handling

- A UDP probe send error marks UDP dead for that probe window.
- A missing UDP ack marks UDP dead after timeout.
- A WebSocket liveness failure marks WS dead and disables WS fallback.
- A session reconnect clears old UDP liveness and starts over with the new
  `sessionTag`.

## Observability

Emit structured logs and status transitions:

- `udp_probe_sent`
- `udp_probe_ack`
- `udp_liveness_timeout`
- `audio_transport_selected` with `from`, `to`, and `reason`
- `ws_binary_audio_frame_sent`

Harnesses should be able to assert these events from logcat or test logs.

