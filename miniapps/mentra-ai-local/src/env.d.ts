/** Ambient declarations for the UI bundle. */

// CSS side-effect imports (handled by the Tailwind plugin at build time).
declare module "*.css"

// SVG imports resolve to a URL string (Bun bundler).
declare module "*.svg" {
  const src: string
  export default src
}

// JSON imports (e.g. Lottie animation data) resolve to the parsed object.
declare module "*.json" {
  const value: unknown
  export default value
}
