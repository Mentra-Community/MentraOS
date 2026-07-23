# @mentra/jspolyfill

The MentraJS polyfill bundle. MentraOS runs each miniapp in its own bare JS
context (JavaScriptCore on iOS, QuickJS on Android); this package provides the
browser-like standard library those contexts lack — `console`, timers,
`fetch`, `WebSocket`, `localStorage`, `crypto.getRandomValues`, and
`crypto.randomUUID` — implemented over a single `__dispatch` native bridge,
plus the `__deliver` / `signalReady` plumbing the host runtime relies on.
`crypto.subtle` is not implemented.

You don't import this package from app code: it's a **peer of the runtime
stack**. [`@mentra/crust`](https://www.npmjs.com/package/@mentra/crust)'s
Android build reads the bundle from this package's `assets/` at build time,
and the engine injects it into each miniapp context at spawn.

## Install

Installed automatically alongside
[`@mentra/engine`](https://www.npmjs.com/package/@mentra/engine) /
`@mentra/crust`. For direct use:

```sh
npm install @mentra/jspolyfill@dev
```

> Currently published on the `dev` dist-tag (prerelease channel).

## Part of MentraOS

Source lives in the [MentraOS monorepo](https://github.com/Mentra-Community/MentraOS)
under `mobile/modules/jspolyfill`. Issues and contributions welcome there.
