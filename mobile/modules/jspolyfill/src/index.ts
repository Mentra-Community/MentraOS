/**
 * @mentra/jspolyfill — polyfill bundle for per-miniapp JS contexts.
 *
 * The actual runtime JS lives in `src/startup.ts` and is built into a
 * single IIFE at `dist/startup.js`. That bundled file is shipped INSIDE
 * the host binary (iOS Expo Module resources / Android assets) and is
 * read at JSContext spawn time. The host evaluates it as a single string
 * before invoking the miniapp's `background/index.js`.
 *
 * The TS source here is type-only at runtime — bundling strips the
 * `import type` lines and emits pure ES5 against `globalThis`.
 */

export * from "./types"
