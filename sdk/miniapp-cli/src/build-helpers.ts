import {createRequire} from "module"
import {dirname, join} from "path"

type ResolveArgs = {path: string}
type ResolveResult = {path: string}
type BunBuild = {
  onResolve(args: {filter: RegExp}, callback: (args: ResolveArgs) => ResolveResult): void
}

/**
 * Force React and ReactDOM imports in a miniapp UI bundle to resolve to one
 * package instance. This prevents invalid-hook-call crashes when a workspace
 * has multiple React versions available and Bun resolves `react/jsx-runtime`
 * from a dependency tree different from `react-dom/client`.
 */
export function reactSingletonPlugin(importMetaUrl: string) {
  const require = createRequire(importMetaUrl)
  const reactRoot = dirname(require.resolve("react/package.json"))
  const reactDomRoot = dirname(require.resolve("react-dom/package.json"))

  const aliases = new Map([
    ["react", join(reactRoot, "index.js")],
    ["react/jsx-runtime", join(reactRoot, "jsx-runtime.js")],
    ["react/jsx-dev-runtime", join(reactRoot, "jsx-dev-runtime.js")],
    ["react-dom", join(reactDomRoot, "index.js")],
    ["react-dom/client", join(reactDomRoot, "client.js")],
  ])

  return {
    name: "mentra-react-singleton",
    setup(build: BunBuild) {
      build.onResolve({filter: /^react(?:\/jsx-runtime|\/jsx-dev-runtime)?$/}, ({path}) => {
        return {path: aliases.get(path)!}
      })
      build.onResolve({filter: /^react-dom(?:\/client)?$/}, ({path}) => {
        return {path: aliases.get(path)!}
      })
    },
  }
}
