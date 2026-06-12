// ASG OTA manifest URLs.
// Production is the compiled default for release builds; staging is the
// manifest the staging-builds workflow deploys to the dedicated Cloudflare
// Pages project (also baked into staging builds via EXPO_PUBLIC_ASG_OTA_VERSION_URL).
export const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version.json"
export const OTA_VERSION_URL_STAGING = "https://mentra-live-ota-staging.pages.dev/staging_live_version.json"
