# Spec: UDP liveness and reversible WebSocket audio fallback

**Status:** Draft.

## Goals

- Keep UDP as the preferred production audio transport.
- Fall back to WebSocket binary audio only when UDP is unreachable and the
  runtime WebSocket is confirmed alive.
- Continue probing UDP while WebSocket audio is active.
- Return to UDP immediately when any UDP probe or audio packet is acknowledged.
- Keep probe packets out of transcription/audio streams.
- Run the same cloud-client transport logic in React Native and Node/Bun tests.

## Non-goals

- Do not infer transport health from transcripts.
- Do not permanently disable UDP after a fallback.
- Do not make local/offline STT part of cloud-client transport selection.
- Do not add a new mobile-only implementation that cannot run in CI.

## Public client state

`RuntimeSnapshot.audioTransport` remains the public host signal:

```ts
type RuntimeAudioTransport = "udp" | "ws" | "none"

interface RuntimeSnapshot {
  status: "connecting" | "connected" | "reconnecting" | "disconnected"
  audioTransport: RuntimeAudioTransport
}
```

Meaning:

- `udp`: cloud audio frames are currently being sent over UDP.
- `ws`: cloud audio frames are currently being sent over the runtime WebSocket
  binary fallback path.
- `none`: no cloud audio transport is usable or configured.

The client may have richer internal state, but hosts should not need to inspect it
for normal UI.

## UDP liveness

The client sends UDP liveness packets for the current session. The runtime UDP
ingress validates them and sends a WebSocket ack for the same session.

Any valid ack means UDP is available now. Missing acks for the configured timeout
means UDP is unavailable now.

Normal UDP audio packets may also refresh UDP liveness if the runtime can safely
ack them without excessive overhead. Probe packets are still required while
WebSocket fallback is active, because real audio is not being sent over UDP in
that state.

## Transport decision rules

```txt
if runtime WS is not alive:
  audioTransport = "none"
else if UDP is alive:
  audioTransport = "udp"
else:
  audioTransport = "ws"
```

When `audioTransport` changes, `onStatusChanged` emits a new `RuntimeSnapshot`.

## Wire behavior

Client to runtime UDP:

- Send an authenticated UDP liveness probe for the active audio session.
- The probe must carry enough session identity to route to the correct runtime
  session.
- The probe must not be forwarded into Redis as audio.

Runtime to client WebSocket:

```ts
type: "audio.udp_liveness_ack"
payload: {
  sessionId: string
  sessionTag: number
  probeId: string
  receivedAt: number
}
```

The exact names can change when protocol types are implemented, but the ack must
be typed in `@mentra/cloud-runtime/protocol` and consumed by cloud-client.

## WebSocket binary audio fallback

When active transport is `ws`, `sendAudioFrame(frame)` sends the same encoded
audio payload over the runtime WebSocket as a binary audio frame. The runtime must
write that audio to the same Redis stream shape used by UDP ingress so workers and
providers do not know which transport delivered it.

The client must not send the same real audio frame over both UDP and WS. During
WS fallback, UDP packets are probes only.

## Recovery

While active transport is `ws`, the client continues UDP probes. On the first
valid UDP liveness ack, the client switches `audioTransport` back to `udp` and
subsequent real audio frames go over UDP.

## Session boundaries

UDP liveness belongs to the current runtime session and current audio sessionTag.
On reconnect:

- clear previous UDP liveness;
- configure the new sessionTag/key from `connection.ack.audio`;
- start probing again;
- decide transport from the new WebSocket and UDP liveness state.

