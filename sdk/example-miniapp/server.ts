import {file} from "bun";
import {join} from "path";

import homepage from "./index.html";
import manifest from "./miniapp.json";

const publicDir = join(import.meta.dir, "public");

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3000"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
    "/icon.png": () => new Response(file(join(import.meta.dir, "icon.png"))),
    "/fonts/:name": (req) => {
      const name = (req.params as {name: string}).name;
      // Restrict to filenames without path separators.
      if (name.includes("/") || name.includes("..")) {
        return new Response("Not found", {status: 404});
      }
      return new Response(file(join(publicDir, "fonts", name)));
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});
