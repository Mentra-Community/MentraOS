# 004 Cloud Client

The headless, isomorphic client library we own: `@mentra/cloud-client`. It is the
device's single connection to Cloud V2, and it is a **dependency** the mobile
client uses, not the mobile client app itself. The on-device Mentra Runtime
(`@mentra/island`) plugs into it through its `configureRuntime` adapters; OEM
hosts embed the same library; and the backend test harness drives the **same**
library from Node/Bun.

Docs: [`architecture.md`](./architecture.md) (the e2e on-device + transport
architecture and the cloud-client decisions, the alignment doc), [`spec.md`](./spec.md)
(the concrete API), [`spike.md`](./spike.md) (design rationale),
[`island-adapter.md`](./island-adapter.md) (the proposed island wiring).

## Design goals

- **Headless and isomorphic.** Pure TS core with no React Native, Expo, or DOM
  imports. Platform-specific pieces (WebSocket, UDP, secure storage) are injected
  and selected by import path: `@mentra/cloud-client/react-native` on device,
  `@mentra/cloud-client/node` for tests. Construction is `new CloudClient(config)`.
- **v2-native.** It speaks only the runtime protocol; none of the v1 message
  shapes (`phone_subscription_update`, `data_stream`, legacy REST).
- **Typed, no stringly surface.** Subscriptions and events use the typed unions
  from `@mentra/cloud-runtime/protocol` (the one source of truth), not strings.

## Modules

A single `CloudClient` owns endpoints, proxy routing, and the shared token state,
and exposes three modules:

- [`auth`](./auth/): token lifecycle. Holds and refreshes the Mentra access
  token, mints miniapp-scoped tokens. This is the **client half** of
  [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md#miniapp-auto-auth); the
  raw access token never leaves the client.
- [`runtime`](./runtime/): the live session (the runtime transport). WS handshake,
  subscriptions, stream events, managed photo/stream, UDP audio coordination.
  Implements [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).
- [`core`](./core/): device-facing Cloud Core REST (miniapp bundles + catalog,
  user profile). Calls [`../001-cloud-core/`](../001-cloud-core/) services. Guardrail:
  device-facing only, no Dev Console / OEM Portal / store web UI.

## Consumers

- **On device:** `@mentra/island` via `configureRuntime` adapters.
- **Backend test harness:** the same library in Node/Bun, so tests exercise the
  real wire contract and auth flow (this answers the 003-audio "test client
  deployment" open question).

## Related

- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the wire
  contract `runtime` implements.
- [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md): the token
  design `auth` consumes.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md)
