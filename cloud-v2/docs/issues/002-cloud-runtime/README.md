# 002 Cloud Runtime Services

Umbrella issue for **Mentra Runtime Services** (`@mentra/cloud-runtime`): the
self-hostable, per-user runtime product that backs the on-device Mentra OEM
Mentra Engine. An OEM can run their own or proxy to Mentra's. Audio is one
subset of it.

The product is made of **services**, each in its own subfolder. They share one
transport (the runtime protocol) and each define their own messages, endpoints,
and payloads on top of it.

## Index

- [`architecture.md`](./architecture.md): the big picture in plain language, how the
  runtime scales, how a session lives across pods, and one end-to-end trace.
  **Start here.**
- [`design.md`](./design.md): the `@mentra/cloud-runtime` package build map, the
  files, what each owns, and the signatures.
- [`protocol.md`](./protocol.md): the service-agnostic transport: envelope,
  handshake, auth, control, error model, and REST conventions shared by all
  services.
- [`audio/`](./audio/): the live transcription and translation path.
  - [`spec.md`](./audio/spec.md): the architecture, fault model, the canonical
    subscription and result data models, and the rejected alternatives.
  - [`design.md`](./audio/design.md): Redis keys, the worker protocol, the failure
    walkthroughs.
  - [`wire.md`](./audio/wire.md): the audio wire surface (subscription REST endpoint,
    transcript/translation push events, UDP audio frames).
- [`camera/`](./camera/): managed photo request and managed stream.

## Related

- [`007-runtime-auth-independence`](../007-runtime-auth-independence/README.md):
  the `cloud-runtime` token and issuer/JWKS model this product verifies.
- [`../001-cloud-core/auth/oem-auth.md`](../001-cloud-core/auth/oem-auth.md): the
  OEM subject-token exchange Core/Auth can use to broker hosted Runtime tokens.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md): the product
  and service taxonomy this issue sits within.
