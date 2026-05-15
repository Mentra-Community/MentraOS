import homepage from "./index.html";
import manifest from "./miniapp.json";

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
});
