/**
 * Compile-time / runtime "are we in dev?" check for the UI WebView.
 *
 * `build.ts` substitutes `process.env.NODE_ENV` via Bun's `define` map
 * (the SDK's release verb sets NODE_ENV=production before invoking the
 * build; dev builds default to "development"). So this expression
 * resolves to a literal `true` or `false` at bundle time and dev-only
 * overlays tree-shake out of the production bundle.
 */
export const isDev: boolean = process.env.NODE_ENV !== "production"

/**
 * App version, sourced from miniapp.json and inlined by `build.ts` via
 * Bun's `define` map (`process.env.APP_VERSION`). Empty string when the
 * dev server doesn't inject it, so callers should treat "" as "unknown".
 */
export const appVersion: string = process.env.APP_VERSION ?? ""
