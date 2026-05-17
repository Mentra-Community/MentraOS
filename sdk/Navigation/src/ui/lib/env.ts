/**
 * Compile-time / runtime "are we in dev?" check for the UI WebView. Vite
 * injects `import.meta.env.DEV`. When the bundler tree-shakes this, dev-only
 * overlays compile out of the prod bundle.
 */
export const isDev: boolean =
  typeof import.meta !== "undefined" && (import.meta as unknown as {env?: {DEV?: boolean}}).env?.DEV === true
