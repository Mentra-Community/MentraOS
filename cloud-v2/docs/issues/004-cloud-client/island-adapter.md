# Proposal: island runtime adapter for the Cloud Client

**Status:** Design proposal. How `@mentra/island` plugs into `@mentra/cloud-client`
for v2 cloud, replacing the Cloud-1 transport adapter.

## Why

island is already transport-agnostic: it reaches the cloud only through the
host-injected hooks in `island/src/runtime/config.ts` (`configureRuntime`). Today
those hooks are implemented by the app's Cloud-1 `SocketComms` / `RestComms` and
are shaped around the v1 wire (raw `sendMessage`, stringly subscriptions). For v2
we want island to talk to the cloud through the headless
[`cloud-client`](./spec.md), with a typed, v2-native adapter. island's code does
not change; only what the host injects does.

## Current seam (for reference)

```ts
// island/src/runtime/config.ts
interface SocketCommsAdapter {
  sendMessage: (message: object) => void
  updatePhoneSubscriptions: (subscriptions: string[]) => void
}
// plus requestMiniappSdkPhoto, settings (backend_url, core_token), etc.
```

Raw message passing and stringly subscriptions, wired by the host's `MantleManager`
to Cloud-1.

## Proposed v2 adapter

Replace the raw surface with typed methods backed by the cloud-client. The host
constructs the client and wires it in:

```ts
const cloud = new CloudClient({ endpoints, auth })

configureRuntime({
  cloud: {
    // subscriptions (typed, full-replace)
    setSubscriptions: (subs) => cloud.runtime.setSubscriptions(subs),

    // inbound stream events -> island routes to miniapps
    onTranscript: (cb) => cloud.runtime.onTranscript(cb),
    onTranslation: (cb) => cloud.runtime.onTranslation(cb),

    // managed photo / stream
    requestManagedPhoto: (opts) => cloud.runtime.requestManagedPhoto(opts),
    startManagedStream: (opts) => cloud.runtime.startManagedStream(opts),

    // auth: identity + the miniapp-scoped token island hands to a bundle
    getIdentity: () => cloud.auth.identity,                       // { mentraUserId, oemId }
    getMiniappToken: (packageName) => cloud.auth.getMiniappToken(packageName),

    // lifecycle
    onConnected: (cb) => cloud.runtime.onConnected(cb),
    onDisconnected: (cb) => cloud.runtime.onDisconnected(cb),
  },
  // device-facing core (bundles/catalog) island already needs for AppRegistry:
  miniapps: {
    list: () => cloud.core.miniapps.list(),
    getBundle: (pkg, v) => cloud.core.miniapps.getBundle(pkg, v),
  },
})
```

## What changes for island

- `AudioSubscription[]` instead of `string[]` for subscriptions (typed from
  `@mentra/cloud-runtime/protocol`), so the stringly `"transcription:en-US"` shape
  goes away.
- Inbound transcripts/translations arrive as typed events from the cloud-client,
  not parsed out of a generic `data_stream`.
- The settings `backend_url` / `core_token` reads for cloud calls are replaced by
  the cloud-client owning endpoints + auth. island no longer reads a raw token for
  transport; it calls `getMiniappToken(packageName)` when it needs the
  miniapp-scoped token to hand a bundle (see
  [`../001-cloud-core/auth/auto-auth/injection.md`](../001-cloud-core/auth/auto-auth/injection.md)).

## What does not change

- The `configureRuntime` injection seam, island stays decoupled from the
  transport. The host (mobile app or OEM host) still owns wiring.
- island's internal services (LocalMiniappRuntime, display, mic, etc.) are
  untouched; they call the same hook surface, now typed.

## Open points

This proposes the adapter contract that wires `@mentra/cloud-client` into island
through `configureRuntime`. The exact hook names and shapes are open to refine
during implementation.
