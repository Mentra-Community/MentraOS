# @mentra/cloud-client

The MentraOS cloud client: connects a device (or a test harness) to the
MentraOS cloud over the wire protocol defined in
[`@mentra/cloud-protocol`](https://www.npmjs.com/package/@mentra/cloud-protocol),
handling the handshake, message envelopes, and per-module message flows
(camera, audio, maps, reports, …).

Its main consumer is [`@mentra/engine`](https://www.npmjs.com/package/@mentra/engine),
which lists it as a peer dependency — an app embedding the engine installs
this package alongside it.

## Install

```sh
npm install @mentra/cloud-client@dev
```

> Currently published on the `dev` dist-tag (prerelease channel).

## Entry points

| Import | Use |
| --- | --- |
| `@mentra/cloud-client` | platform-neutral core: `CloudClient` plus the public config, transport, and error types (wire-protocol types are deliberately *not* re-exported — import those from `@mentra/cloud-protocol`) |
| `@mentra/cloud-client/react-native` | React Native transport bindings (used by the engine) |
| `@mentra/cloud-client/node` | Node transport bindings — requires the optional [`ws`](https://www.npmjs.com/package/ws) peer (`npm i ws`) |

The package ships TypeScript source and targets consumers that compile TS
themselves (Metro / bundlers / tsc).

## Part of MentraOS

Source lives in the [MentraOS monorepo](https://github.com/Mentra-Community/MentraOS)
under `cloud-v2/packages/cloud-client`. Issues and contributions welcome there.
