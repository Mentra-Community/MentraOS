# Mentra Runtime Protocol (transport)

The service-agnostic transport contract between the on-device Mentra Runtime
(the client module we own) and Mentra Runtime Services (`@mentra/cloud-runtime`).
It defines the envelope, handshake, auth, control, error model, and REST
conventions shared by every runtime service. Each service documents its own
messages, endpoints, and payloads on top of this frame:

- Audio service wire surface: [`audio/wire.md`](./audio/wire.md)
- Camera service wire surface: [`camera/README.md`](./camera/README.md)

This is a clean v2-native protocol. It does not carry the v1 phone contract; see
[`audio/wire.md`](./audio/wire.md) for what that means for the audio path.

## Goals

- One source of truth for the wire types, living next to the runtime code and
  exported separately so the client imports types without server code:
  - `@mentra/cloud-runtime` is the server.
  - `@mentra/cloud-runtime/protocol` is pure, isomorphic types plus zod
    validators, with zero server imports (no `node:*`, no service code). A build
    check keeps that entrypoint dependency-isolated so nothing leaks into the RN
    bundle.
- Transport-neutral framing. The envelope does not assume who sends the bytes,
  so the client transport (RN built-in WebSocket, or `react-native-nitro-websockets`
  later) is a swappable choice, not part of the contract.
- Structured, versioned, typed. The envelope is service-agnostic. Per-service
  payloads reference their service's canonical types (for example the audio
  `AudioSubscription` defined in [`audio/spec.md`](./audio/spec.md#subscription-model)),
  and are never redefined here.

## Channels

The split is deliberate: the client initiates over REST, the cloud pushes over
the WebSocket. REST gives request/response correlation, retries, idempotency,
standard Bearer-header auth, and per-request tracing. The WebSocket is mostly a
downstream channel for data the client did not directly request, plus the
handshake that establishes the runtime session.

- **Client-initiated commands: REST.** Stateless and pod-agnostic: behind the
  normal load balancer, any pod serves them. Per-service endpoints are documented
  in each service doc.
- **Cloud-to-client push: WebSocket, JSON envelope.** Handshake
  (`connection.init` / `connection.ack`), control (`ping`/`pong`), errors, and
  per-service push events.
- **Audio ingest: UDP, binary frames.** Audio service only; documented in
  [`audio/wire.md`](./audio/wire.md).

## Envelope

Every WebSocket message is a JSON object with this shape:

```ts
interface Envelope<T = unknown> {
  v: 2;            // protocol major; mismatched major is rejected at handshake
  type: string;    // namespaced, e.g. "stream.transcript"
  id?: string;        // optional, only when a message needs request/ack correlation
  timestamp: number;  // epoch milliseconds (Unix time)
  payload: T;
}
```

Unknown `type` values are answered with a non-fatal `error` (code `UNKNOWN_TYPE`)
and the connection stays open, so adding message types is backward compatible
within a major version.

## Auth and handshake

Runtime accepts a `cloud-runtime` audience token. The issuer is deployment
configured: hosted Runtime normally trusts the normalized Cloud Runtime issuer
from Core/Auth, while an OEM-hosted Runtime can trust the OEM's own issuer/JWKS
through environment config. Runtime verifies tokens locally (signature, issuer,
audience, expiry, and identity claim mapping); it does not call Core on each
request.

The token is sent in the first frame. The v1-style `?token=` query parameter is
supported as a fallback because the dev stack already exercises it and it is
useful under the Chrome JS debugger, where header-based auth does not work. A
real `Authorization: Bearer` header (RN supports it natively) and Nitro
token-refresh are future enhancements that do not change this contract.

The handshake establishes the runtime session generically. Service-scoped config
rides in scoped blocks; today the only one is `audio`. As services are added, the
handshake gains their config blocks, leaving the rest of the message stable.

Sequence:

1. Client opens the WebSocket (token in the first frame, or via the `?token=`
   fallback).
2. Client sends `connection.init`.
3. Server replies with `connection.ack` on success, or `error` (fatal) then
   closes.

### `connection.init` (client to cloud)

```ts
interface ConnectionInit {
  token?: string;          // omitted if provided via ?token= fallback
  protocolVersion: string; // semver of the client protocol build, e.g. "2.0.0"
  client?: {
    platform: "ios" | "android";
    appVersion?: string;
  };
  // Service-scoped config blocks. Audio is the only one today.
  audio?: {
    codec: "lc3" | "pcm";
    sampleRate: number;             // e.g. 16000
    // Optional initial subscription set, seeded atomically with the session so
    // audio that starts before the first REST update is not transcribed with an
    // empty set. AudioSubscription is canonical in audio/spec.md.
    initialSubscriptions?: AudioSubscription[];
  };
}
```

### `connection.ack` (cloud to client)

```ts
interface ConnectionAck {
  sessionId: string;        // runtime session identifier
  negotiatedVersion: string;
  // Audio session ingest coordinates (audio service).
  audio?: {
    sessionTag: number;     // u32 the client stamps into UDP audio frames
    udp: { host: string; port: number };
    // Per-session key for encrypting UDP audio. Delivered here because the
    // handshake is over the TLS WebSocket. See audio/wire.md "Encryption".
    encryption: {
      algorithm: "xsalsa20-poly1305";  // NaCl secretbox
      key: string;                      // base64, 32 bytes
    };
  };
}
```

### Session identifiers

The handshake returns two ids for the same session, shaped for two planes. They
are not the same value.

- **`sessionId`** (string, top-level): the **control-plane** id. It is issued
  unconditionally and is what REST requests carry (for example the subscription
  guard). It is transport-independent: present whether audio runs over UDP, over
  the WS fallback, or not at all.
- **`sessionTag`** (u32, under `audio`): the **data-plane** id. It is stamped into
  every UDP audio frame so the connectionless, stateless ingress can route the
  datagram and select its decryption key. It is a compact fixed-size integer
  because it rides a binary header sent tens of times a second.

Both map to the same session server-side. The `audio` block (`sessionTag`, `udp`,
`encryption`) is UDP-path specific: on the WS audio fallback the frames ride the
per-user WS, which already identifies the session and is TLS-encrypted, so neither
the tag nor the secretbox key is needed there. The one id you always have is
`sessionId`.

## Control

- `control.ping` (either direction), answered by `control.pong`. Used for
  liveness and RTT, separate from the WebSocket ping frame. The cloud is passive
  on connection liveness (see [`audio/design.md`](./audio/design.md)); the client
  owns reconnect.

## Errors

```ts
interface ProtocolError {
  code: string;
  message: string;
  fatal: boolean; // if true, the server closes the socket after sending
}
```

| code                  | fatal | meaning                                          |
| --------------------- | ----- | ------------------------------------------------ |
| `AUTH_FAILED`         | yes   | token missing or invalid                         |
| `AUTH_EXPIRED`        | yes   | token expired; client should refresh and reopen  |
| `UNSUPPORTED_VERSION` | yes   | protocol major mismatch                          |
| `BAD_REQUEST`         | no    | malformed payload for a known type               |
| `UNKNOWN_TYPE`        | no    | unrecognized `type`                              |
| `INTERNAL`            | no    | server-side failure                              |

Services may define additional codes for their own payloads (for example the
audio service's `SUBSCRIPTION_INVALID`); those are documented in the service doc.

## REST conventions

- All client-initiated commands are REST, stateless, and pod-agnostic, behind the
  normal load balancer. Auth is
  `Authorization: Bearer <cloud-runtime token>`.
- Endpoints live under an `/api/...` prefix on the runtime's own domain, scoped by
  service, with **no version segment**: the domain (a fresh v2 service) already
  distinguishes this from the legacy cloud, and the runtime API is on its first
  version. If a breaking change is ever needed, it takes `/api/v2/...`.
- Per-service endpoints live in their service doc (audio subscriptions in
  [`audio/wire.md`](./audio/wire.md); managed photo and managed stream in
  [`camera/README.md`](./camera/README.md)).

## Message type registry (transport-level)

| type                | direction       | payload         |
| ------------------- | --------------- | --------------- |
| `connection.init`   | client to cloud | ConnectionInit  |
| `connection.ack`    | cloud to client | ConnectionAck   |
| `control.ping`      | either          | {}              |
| `control.pong`      | either          | {}              |
| `error`             | cloud to client | ProtocolError   |

Per-service push events (for example `stream.transcript`) are registered in their
service docs. Each WebSocket type maps 1:1 to a zod schema in
`@mentra/cloud-runtime/protocol`, combined into a discriminated union on `type`
for parse-time validation on both ends.

## Versioning

`v: 2` in the envelope plus a `protocolVersion` semver negotiated in the
handshake. Unknown `type` is non-fatal so message types can be added within a
major version. A mismatched major is rejected at the handshake with
`UNSUPPORTED_VERSION`.
