import {createRequire} from "module"

import manifest from "./miniapp.json"

const require = createRequire(import.meta.url)
const appNodeModules = process.cwd()
const sharedReactPackages = /^(react|react-dom|scheduler)(\/.*)?$/

Bun.plugin({
  name: "app-react-singleton",
  setup(build) {
    build.onResolve({filter: sharedReactPackages}, (args) => ({
      path: require.resolve(args.path, {paths: [appNodeModules]}),
    }))
  },
})

const homepage = (await import("./index.html")).default

Bun.serve({
  hostname: "0.0.0.0",
  port: parseInt(process.env.PORT ?? "3000"),
  routes: {
    "/": homepage,
    "/miniapp.json": () => Response.json(manifest),
    "/icon.png": () =>
      new Response(Bun.file("./icon.png"), {
        headers: {"content-type": "image/png"},
      }),
  },
  development: {
    hmr: true,
    console: true,
  },
})
