# Auth

The home for the whole MentraOS auth system: how every actor proves identity to
Mentra, and how Mentra hands identity to the parties that need it.

Two docs give the full v2 picture without reading the spikes:
[`spec.md`](./spec.md) is the endpoint and token contract (the "what"), and
[`design.md`](./design.md) is the end-to-end implementation design across
cloud-core, cloud-client, on-device, and the dev SDK (the "how", every code
change). The docs below are the mechanisms behind them.

## Parts

- **OEM auth** ([`oem-auth/`](./oem-auth/)): how an OEM proves who its user is to
  Mentra (RFC 8693 exchange of an OEM-signed JWT for a Mentra access token), and
  how Mentra hands user identity to miniapp backends (the `mentraUserId` +
  `oemId` handoff and trust policy). Specced and implemented.
- **User identity** ([`identity/`](./identity/)): the identity for "Mentra's own
  users," which today spans the consumer app, the Dev Console website, and the
  App/MiniApp Store website, all via the **same** Supabase sign-in plus core-token
  exchange (not three separate systems). v2 unifies them on the Mentra access
  token, with Mentra as "OEM zero" (reserved `oemId = "mentra"`). OEM users reach
  the same token via oem-auth. Spike.
- **Miniapp auto-auth** ([`auto-auth/`](./auto-auth/)): injecting Mentra auth
  into a local miniapp so it can call the developer's own backend with no login
  (the Phase 2 that oem-auth deferred). Spike.

## How the pieces relate

All paths converge on one token: the **Ed25519 Mentra access token**
(`sub = mentraUserId`, `oemId`, ...), verified by services with Mentra's public
key. OEM users get it via the oem-auth exchange; Mentra-direct users get it via
the same exchange with reserved `oemId = "mentra"`. The runtime transport
([`../../002-cloud-runtime/protocol.md`](../../002-cloud-runtime/protocol.md))
verifies it. Miniapp auto-auth derives a short-lived miniapp-scoped token from it.

## Status

- `spec.md`: the v2 endpoint + token contract (exchange, refresh, miniapp-token,
  JWKS). Specced; this is what the cloud-client implements against.
- `design.md`: the end-to-end implementation design (the code changes across
  cloud-core, cloud-client, on-device, and the dev SDK).
- `oem-auth/`: Implemented (the OEM-JWT exchange mechanics; docs under review).
- `identity/`: Spiked (Mentra-direct identity + the migration bridge).
- `auto-auth/`: Spiked (the end-to-end miniapp dev-backend mechanism).

## Related

- [`../../../mentra-overhaul-plan.md`](../../../mentra-overhaul-plan.md)
