# 004 Cloud Client

`@mentra/cloud-client` is the phone's connection to Cloud V2: a TypeScript library
(just code, no UI) that opens the connection, sends requests up, and receives events
back. The on-device Mentra Runtime (`@mentra/island`) plugs into it; OEM hosts embed
the same library; and the backend test harness runs the **same** library on a server,
so the tests drive the exact client the phone uses. It's a dependency the mobile app
uses, not the app itself.

Docs:

- [`architecture.md`](./architecture.md): the whole picture, how a miniapp runs on
  the phone and reaches the cloud, what the cloud-client is and why, how auth works
  for Mentra and OEMs, and the decisions. **Start here.**
- [`spec.md`](./spec.md): the concrete API (the three modules, construction, the
  injected transports).

## Design goals

- **Just code, runs anywhere.** No React Native, Expo, or web-page imports in the
  core. The platform-specific pieces (WebSocket, UDP socket, secure storage) are
  passed in, and chosen by import path: `@mentra/cloud-client/react-native` on the
  phone, `@mentra/cloud-client/node` for tests. You construct it with
  `new CloudClient(config)`.
- **v2-native.** It speaks only the v2 protocol; none of the v1 message shapes
  (`phone_subscription_update`, `data_stream`, legacy REST).
- **Typed, no magic strings.** Subscriptions and events use the typed definitions
  from `@mentra/cloud-runtime/protocol` (the one source of truth), not hand-written
  strings.

## The three modules

A single `CloudClient` owns the endpoints, proxy routing, and the shared login
state, and exposes three areas (full API in [`spec.md`](./spec.md)):

- **`cloud.auth`:** login and tokens. Gets and refreshes the Mentra access token,
  and mints the per-miniapp tokens. The access token is the Bearer to Mentra's own
  APIs but is never handed to a miniapp. The client half of
  [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md#miniapp-auto-auth).
- **`cloud.runtime`:** the live audio and event session. Connection handshake,
  subscriptions, transcript/translation events, managed photo/stream, UDP audio.
  Implements [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).
- **`cloud.core`:** the other v2 REST calls the device makes (miniapp bundles +
  catalog, user profile). Calls [`../001-cloud-core/`](../001-cloud-core/) services.
  Device-facing only, no Dev Console / OEM Portal / store web UI.

## Consumers

- **On device:** `@mentra/island`, wired in at the host's `configureRuntime` hook.
- **Backend test harness:** the same library on a server (Node/Bun), so tests run the
  real connection and auth flow (this answers the 003-audio "test client deployment"
  open question).

## Related

- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the v2
  protocol `cloud.runtime` implements.
- [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md): the auth
  design `cloud.auth` consumes.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md)
