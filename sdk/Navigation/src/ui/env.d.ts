/**
 * Ambient module declarations for non-TS assets imported by the UI
 * bundle. Bun's bundler handles these at build time; tsc just needs to
 * know the imports are valid side-effects.
 */
declare module "*.css"
