# UDP liveness and reversible WS audio fallback

**Status:** Partially implemented.

This sub-issue covers the cloud-client transport policy for cloud audio:
UDP is the preferred production transport, WebSocket binary audio is the fallback,
and the client must automatically return to UDP as soon as UDP is reachable again.

Docs:

- [`spike.md`](./spike.md): motivation, current system, v1 lessons, and open
  questions.
- [`spec.md`](./spec.md): the desired contract and behavior.
- [`design.md`](./design.md): implementation shape across cloud-client,
  cloud-runtime, React Native, and Node/Bun tests.
- [`testing.md`](./testing.md): unit, integration, harness, local phone, and
  Porter E2E coverage.

## One-line problem

Today cloud-client can have a healthy runtime WebSocket while UDP audio is
blocked by the user's network, which means the app can appear connected while
cloud transcription receives no audio.

## Target behavior

- Prefer UDP whenever any UDP packet can reach the runtime.
- Fall back to WebSocket audio only when the runtime WebSocket is alive and UDP
  liveness is dead.
- While on WebSocket audio, continue sending lightweight UDP probes.
- Switch back to UDP immediately when one UDP probe is acknowledged.
- Expose this through `RuntimeSnapshot.audioTransport` so mobile debug UI,
  harnesses, and developers can see the active transport.

## Current implementation slice

- Cloud-client sends encrypted UDP liveness probes and switches
  `audioTransport` between `udp`, `ws`, and `none`.
- Runtime UDP ingress recognizes probe payloads, does not append them to the
  audio stream, and sends `audio.udp_liveness_ack` over the owning WebSocket.
- Node/Bun and React Native WebSocket transports can send binary fallback audio.
- Local in-process cloud test covers same-pod UDP probe ack.

Still pending:

- Cross-pod UDP probe ack routing when the UDP packet lands on a pod that does
  not own the WebSocket.
- First-class phone E2E harness scenarios for UDP blocked/restored.
