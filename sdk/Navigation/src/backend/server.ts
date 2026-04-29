/**
 * Dev server.
 *
 * The miniapp ships as a static bundle in production, but during `bun run
 * dev` the WebView loads from this Bun.serve so we get HMR + can serve a
 * runtime `/api/config` endpoint (the prod build inlines the same value
 * via `define` in build.ts).
 */

import homepage from "../../index.html"
import manifest from "../../miniapp.json"

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3000"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
    "/api/config": () =>
      Response.json({
        googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY ?? "",
      }),
  },
  development: {
    hmr: true,
    console: true,
  },
})
