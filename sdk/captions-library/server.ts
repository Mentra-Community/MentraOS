/**
 * server.ts
 *
 * Bun static-file host for the webview. Same shape as
 * sdk/example-miniapp/server.ts. Not a backend in the framework sense:
 * its only job is to serve index.html and the manifest. The miniapp
 * runtime is what bridges this webview to the phone.
 */

import homepage from "./index.html"
import manifest from "./miniapp.json"

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3000"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
  },
  development: {
    hmr: true,
    console: true,
  },
})
