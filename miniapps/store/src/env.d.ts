declare module "*.css"

// Bun bundles imported SVGs as asset URLs.
declare module "*.svg" {
  const url: string
  export default url
}
