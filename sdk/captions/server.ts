/**
 * Bun static-file host. Serves index.html (which references
 * webview/main.tsx, which imports client/index.ts for side effects)
 * plus the manifest used by `mentra-miniapp dev`. Bunfig.toml registers
 * bun-plugin-tailwind for Tailwind v4 compilation.
 */

import {file} from "bun"
import {join} from "path"

import homepage from "./index.html"
import manifest from "./miniapp.json"

const publicDir = join(import.meta.dir, "public")

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3003"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
    "/fonts/:name": (req) => {
      const name = (req.params as {name: string}).name
      if (name.includes("/") || name.includes("..")) return new Response("Not found", {status: 404})
      return new Response(file(join(publicDir, "fonts", name)))
    },
  },
  development: {
    hmr: true,
    console: true,
  },
})
