# Auth

The home for the whole MentraOS auth system: how every actor proves identity to
Mentra, and how Mentra hands identity to the parties that need it.

**New to auth?** Read [`concepts.md`](./concepts.md) first: a from-zero primer on
the ideas the rest of this folder assumes (JWTs, asymmetric signing, JWKS,
audiences, token exchange, refresh), built from intuition and mapped onto our
system. No crypto background needed.

**Reading order:** [`spec.md`](./spec.md) (the endpoint and token contract, the
"what"), then [`design.md`](./design.md) (the end-to-end implementation, the "how":
the identity model, the v1 to v2 migration bridge, and the miniapp auto-auth +
on-device injection flow). Those two give the full v2 picture.
[`oem-auth.md`](./oem-auth.md) is the one built subsystem, kept separate.

## The docs

- [`concepts.md`](./concepts.md): the from-zero primer. Teach.
- [`spec.md`](./spec.md): the v2 endpoint + token contract (exchange, refresh,
  miniapp-token, JWKS). The contract the cloud-client implements against.
- [`design.md`](./design.md): the end-to-end implementation design across
  cloud-core, cloud-client, on-device, and the dev SDK. Includes the **identity
  model** (Mentra's own users as "OEM zero", the `mentraUserId` model, the
  core-token migration bridge) and **miniapp auto-auth** (the dev-backend flow and
  on-device token injection).
- [`oem-auth.md`](./oem-auth.md): the OEM-exchange subsystem (RFC 8693), the one
  piece already **Implemented**. Carries the Q1/Q2 decisions and the full
  implementation (endpoints, data model, token formats, lifecycles, security, the
  miniapp identity handoff + trust policy, and the TEST OEM fixture).

## How the pieces relate

All paths converge on one token: the **Ed25519 Mentra access token**
(`sub = mentraUserId`, `oemId`, ...), verified by services with Mentra's public
key. OEM users get it via the oem-auth exchange; Mentra-direct users get it via the
same exchange with reserved `oemId = "mentra"`. The runtime transport
([`../../002-cloud-runtime/protocol.md`](../../002-cloud-runtime/protocol.md))
verifies it. Miniapp auto-auth derives a short-lived miniapp-scoped token from it.

## Status

- `concepts.md`: written.
- `spec.md` + `design.md`: Specced (contract + e2e implementation design).
- `oem-auth.md`: Implemented (the OEM-JWT exchange mechanics; docs under review).
- Identity model + migration bridge, and miniapp auto-auth + injection: decided
  (in `design.md`). Open: the API-key role.

## Related

- [`../../../mentra-overhaul-plan.md`](../../../mentra-overhaul-plan.md)
