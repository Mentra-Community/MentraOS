// ASG OTA manifest URLs.
// Production is the compiled default; staging is the manifest the
// staging-builds workflow deploys to the dedicated Cloudflare Pages project.
// Staging is deliberately NOT baked into any distributed build (store
// binaries are promoted staging builds) — testers opt in via the
// developer-settings Custom OTA Manifest URL card, where these are presets.
export const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version.json"
export const OTA_VERSION_URL_STAGING = "https://staging.ota.mentraglass.com/staging_live_version.json"
