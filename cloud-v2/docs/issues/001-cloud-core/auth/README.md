# Auth

The home for the whole MentraOS auth system: how every actor proves identity to
Mentra, and how Mentra hands identity to the parties that need it.

## Parts

- **OEM auth** ([`oem-auth/`](./oem-auth/)): how an OEM proves who its user is to
  Mentra (RFC 8693 exchange of an OEM-signed JWT for a Mentra access token), and
  how Mentra hands user identity to mini-app backends (the `mentraUserId` +
  `oemId` handoff and trust policy). Specced and implemented.
- **Mobile client to cloud identity** ([`spike.md`](./spike.md)): the Mentra
  access token that authenticates the mobile client to the cloud, for both
  Mentra-direct users (reserved `oemId = "mentra"`) and OEM users. Spike.
- **Mini-app auto-auth** ([`spike.md`](./spike.md)): injecting Mentra auth into a
  local mini app so it can call the developer's own backend with no login (the
  Phase 2 that oem-auth deferred). Spike.
- **Dev console / app store auth**: web sign-in for developers and users on the
  Mentra websites (Supabase today). Not yet specced; see
  [`../../005-websites/`](../../005-websites/).

## How the pieces relate

All paths converge on one token: the **Ed25519 Mentra access token**
(`sub = mentraUserId`, `oemId`, ...), verified by services with Mentra's public
key. OEM users get it via the oem-auth exchange; Mentra-direct users get it via
the same exchange with reserved `oemId = "mentra"`. The runtime transport
([`../../002-cloud-runtime/protocol.md`](../../002-cloud-runtime/protocol.md))
verifies it. Mini-app auto-auth derives a short-lived app-scoped token from it.

## Status

- `oem-auth/`: Implemented (docs under review).
- Identity + auto-auth (`spike.md`): Spiked; open questions to resolve, then spec.
- Console / store auth: not yet specced.

## Related

- [`../../../mentra-overhaul-plan.md`](../../../mentra-overhaul-plan.md)
