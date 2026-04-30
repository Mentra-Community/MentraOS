/**
 * server.ts
 *
 * Bun static-file host for the webview. Serves `index.html` (which
 * references `webview/main.tsx`, which imports `client/index.ts` for
 * side effects) plus the manifest used by `mentra-miniapp dev`.
 *
 * Bun's HTML imports handle bundling: the dev server transpiles tsx,
 * resolves workspace dependencies, and HMRs on edit.
 */

import homepage from "./index.html"
import manifest from "./miniapp.json"

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3001"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
  },
  development: {
    hmr: true,
    console: true,
  },
})
