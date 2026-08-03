# 004 Cloud Client

`@mentra/cloud-client` is the phone's connection to Cloud V2: a TypeScript library
(just code, no UI) that opens the connection, sends requests up, and receives events
back. The on-device Mentra Runtime (`@mentra/engine`) plugs into it; OEM hosts embed
the same library; and the backend test harness runs the **same** library on a server,
so the tests drive the exact client the phone uses. It's a dependency the mobile app
uses, not the app itself.

Docs:

- [`architecture.md`](./architecture.md): the whole picture, how a miniapp runs on
  the phone and reaches the cloud, what the cloud-client is and why, how auth works
  for Mentra and OEMs, and the decisions. **Start here.**
- [`spec.md`](./spec.md): the public API (the three modules, construction, the
  injected transports).
- [`design.md`](./design.md): how it's built behind that API (the connection
  lifecycle, token refresh, the transports, the mechanics behind each method). The
  build plan.
- [`udp-liveness-fallback/`](./udp-liveness-fallback/): spike/spec/design/testing
  for UDP liveness, WebSocket audio fallback, and automatic switchback to UDP.

## What makes it worth a separate library

- **The same code runs on the phone and on a server.** The library has no
  phone-only or browser-only imports. The parts that only exist on a real phone (the
  network sockets, secure storage) are passed in from outside, picked by which build
  you import (`@mentra/cloud-client/react-native` on the phone,
  `@mentra/cloud-client/node` for tests). That's the payoff: the backend test harness
  is literally this same library, so a passing test is evidence the phone works too.
- **It only knows the v2 cloud.** It carries none of the old v1 cloud's messages or
  REST calls, so there's no v1 baggage to keep alive or accidentally lean on. The v1
  connection stays separate (see [`architecture.md`](./architecture.md)).
- **The cloud's types are the only types.** Subscriptions and events are built from
  the shared definitions in `@mentra/cloud-runtime/protocol`, the exact ones the
  cloud server uses. So if the phone and the cloud ever disagree about a message, it's
  a compile error here, not a bug in the field.

(More on the why in [`architecture.md`](./architecture.md) section 5.)

## The three modules

A single `CloudClient` owns the endpoints, proxy routing, and the auth providers,
and exposes three areas (full API in [`spec.md`](./spec.md)):

- **`cloud.auth`:** token providers. Supplies a `cloud-runtime` token for live
  Runtime Services, and, when Core is configured, a `cloud-core` token plus
  per-miniapp tokens. Core/runtime bearer tokens are never handed to a miniapp.
  The client half of
  [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md#miniapp-auto-auth)
  and [`../007-runtime-auth-independence/README.md`](../007-runtime-auth-independence/README.md).
- **`cloud.runtime`:** the live audio and event session. Connection handshake,
  status, subscriptions, transcript/translation events, managed photo/stream, UDP
  audio. Implements [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).
- **`cloud.core`:** the other v2 REST calls the device makes (miniapp bundles +
  catalog). Calls [`../001-cloud-core/`](../001-cloud-core/) services. Device-facing
  only, no Dev Console / OEM Portal / store web UI. Optional in runtime-only mode.

## Consumers

- **On device:** `@mentra/engine`, wired in at the host's `configureRuntime` hook.
- **Backend test harness:** the same library on a server (Node/Bun), so tests run the
  real connection and auth flow (this answers the 003-audio "test client deployment"
  open question).

## Related

- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the v2
  protocol `cloud.runtime` implements.
- [`udp-liveness-fallback/`](./udp-liveness-fallback/): the dedicated issue for
  UDP liveness and reversible WebSocket audio fallback.
- [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md): the auth
  design `cloud.auth` consumes.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md)
