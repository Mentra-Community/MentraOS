# island

Mentra Manager Island — the on-device miniapp library.

This module owns the pieces of miniapp logic and handling that aren't tied to
the rest of the manager app: the WebView message bus, the in-memory running
registry, and the JS globals that we inject into every miniapp WebView.

The goal is for all miniapp logic to live here over time. Today the move is
incremental — only the self-contained services have moved. Cross-cutting
services (LocalMiniappRuntime, MantleManager, Composer install pipeline) still
live under `mobile/src/` because they reach back into the manager's stores and
sockets.

## Public surface

```ts
import {webviewBridge, miniappRunningRegistry, miniappGlobals, devMiniappLaunch} from "island"
```

- `webviewBridge` — registers per-package WebView message handlers so any
  service can `postMessage` JSON into a specific miniapp.
- `miniappRunningRegistry` — session-scoped set of currently-mounted local
  miniapp packageNames (foreground + background).
- `miniappGlobals` — builds the `window.MentraOS` injection script (and
  CSS variables / console-tap shim) used by every miniapp WebView.
- `devMiniappLaunch` — pre-flight a dev URL's `miniapp.json` to decide
  whether to mount live or take the user to the offline screen.

## Imports

Inside `mobile/modules/island/src/`, use **relative paths** (`./services/...`,
`../utils/...`). The mobile app's `@/*` alias is not configured here — there
is no build-time path rewriter for this module.
