# Cloud Client: runtime module (`cloud.runtime`)

**Status:** Placeholder. Part of the Cloud Client (see ../README.md). To be specified.

The live-session transport, the stateful, latency-sensitive part of the client.
It implements the client end of
[`../../002-cloud-runtime/protocol.md`](../../002-cloud-runtime/protocol.md):

- WS connection lifecycle: `connection.init` / `connection.ack` handshake (Bearer
  from `cloud.auth`), reconnect with backoff, client-driven liveness ping.
- Subscriptions (full-replace, typed `AudioSubscription[]`).
- Stream events (typed, per-event methods): transcript, translation.
- Managed photo and managed stream (REST request plus async result).
- UDP audio coordination: receives `sessionTag`, the advertised UDP host/port, and
  the per-session encryption key from `connection.ack.audio`, and hands them to the
  injected native UDP transport, which encrypts each frame. The audio byte path is
  native; the bytes do not flow through JS.

Depends on the open subscription-transport decision
([`../../002-cloud-runtime/audio/subscription-transport.md`](../../002-cloud-runtime/audio/subscription-transport.md))
and the locked `protocol.md`.
