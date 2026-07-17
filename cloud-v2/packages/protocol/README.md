# @mentra/cloud-protocol

The MentraOS phone ↔ cloud wire protocol: message schemas, envelopes, and
error types shared by everything that speaks to the MentraOS cloud. Pure
TypeScript + [zod](https://github.com/colinhacks/zod) — no server or native
dependencies.

This is a **leaf package**: [`@mentra/cloud-client`](https://www.npmjs.com/package/@mentra/cloud-client)
and [`@mentra/engine`](https://www.npmjs.com/package/@mentra/engine) depend on
it, and the MentraOS cloud runtime consumes the same schemas server-side, so
both ends of the wire validate against one definition.

## Install

You normally get this package automatically as a dependency of
`@mentra/cloud-client` or a peer of `@mentra/engine`. For direct use:

```sh
npm install @mentra/cloud-protocol@dev
```

> Currently published on the `dev` dist-tag (prerelease channel).

## Usage

```ts
import {envelopeSchema, PROTOCOL_MAJOR, type Envelope} from "@mentra/cloud-protocol";

const message: Envelope = envelopeSchema.parse(JSON.parse(raw));

// or per-module subpaths:
import {normalizePhotoSizeTier} from "@mentra/cloud-protocol/camera";
```

Modules: `envelope`, `messages`, `handshake`, `control`, `camera`, `audio`,
`maps`, `errors` — each importable as `@mentra/cloud-protocol/<module>`.

The package ships TypeScript source (`main: ./src/index.ts`) and targets
consumers that compile TS themselves (Metro / bundlers / tsc); it is not
precompiled for plain Node `require`.

## Part of MentraOS

Source lives in the [MentraOS monorepo](https://github.com/Mentra-Community/MentraOS)
under `cloud-v2/packages/protocol`. Issues and contributions welcome there.
