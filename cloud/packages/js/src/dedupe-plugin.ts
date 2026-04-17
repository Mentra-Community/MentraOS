/**
 * @mentra/js dedupe plugin
 *
 * Forces `react`, `react-dom`, and their subpaths to resolve to a single
 * copy — the one installed at `PROJECT_ROOT/node_modules/<pkg>`.
 *
 * Why this exists
 * ───────────────
 * In `mentra dev`, the Bun fullstack bundler runs against the project's
 * `webview/` entrypoint. The webview imports React directly *and* imports
 * `@mentra/js/react` (our hook package). `@mentra/js` is typically linked
 * from the MentraOS-2 monorepo, so when Bun resolves `react` from inside
 * `@mentra/js/src/runtime/react.ts`, it walks up to the monorepo's
 * `node_modules/react` — a different physical copy than the one the
 * webview resolves from `PROJECT_ROOT/node_modules/react`.
 *
 * Two copies of React in one bundle = "Invalid hook call" at runtime.
 *
 * This plugin intercepts every import of `react`, `react-dom`, or any of
 * their subpaths (e.g. `react/jsx-runtime`, `react-dom/client`) and
 * rewrites the resolved path to the project-root copy. That's the single
 * source of truth for React.
 *
 * How it's loaded
 * ───────────────
 * Bun's fullstack dev server loads bundler plugins via bunfig.toml's
 * `[serve.static] plugins` array (see
 * https://bun.sh/docs/bundler/fullstack#custom-plugins). `mentra dev`
 * writes a `bunfig.toml` in the project root that references this file,
 * and Bun imports it and uses the default export.
 */

import { createRequire } from "module";
import type { BunPlugin } from "bun";

const DEDUPED_PACKAGES = ["react", "react-dom", "scheduler"];

function isDedupedImport(path: string): boolean {
  return DEDUPED_PACKAGES.some((pkg) => path === pkg || path.startsWith(pkg + "/"));
}

/**
 * Build a dedupe plugin anchored at a specific project root.
 *
 * Every time Bun resolves one of the deduped packages, we run it through
 * a `require.resolve` that's been pinned to the project root — so all
 * copies (including ones imported from inside linked packages like
 * `@mentra/js` itself) converge on `PROJECT_ROOT/node_modules/<pkg>`.
 */
export function dedupeReactPlugin(projectRoot: string): BunPlugin {
  const projectRequire = createRequire(projectRoot + "/package.json");

  return {
    name: "@mentra/js dedupe react",
    setup(build) {
      // Match "react", "react-dom", "scheduler" and any subpath like
      // "react/jsx-runtime" or "react-dom/client". The broad filter is
      // fast enough; we refine in the callback.
      const filter = /^(react|react-dom|scheduler)(\/.*)?$/;

      build.onResolve({ filter }, (args) => {
        if (!isDedupedImport(args.path)) return undefined;

        try {
          const resolved = projectRequire.resolve(args.path);
          return { path: resolved };
        } catch {
          // Fall through to Bun's default resolution for optional subpaths
          // (e.g. `react-dom/server.node`) the project doesn't have.
          return undefined;
        }
      });
    },
  };
}

/**
 * Default plugin instance, anchored at `process.cwd()`.
 *
 * This is what bunfig.toml's plugin loader sees when it imports this
 * module. When `mentra dev` launches, `process.cwd()` is the project
 * root (the folder with `mentra.config.ts` and `node_modules/`).
 */
const plugin = dedupeReactPlugin(process.cwd());

export default plugin;
