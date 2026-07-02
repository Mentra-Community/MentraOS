// ASG OTA manifest URLs.
// Production uses the v2 manifest for ASG clients that can honor
// ota_start.ota_version_url. Older ASG clients must be checked against the
// legacy production manifest because their eventual ota_start will ignore the
// phone-supplied URL and use their compiled default.
// Staging is the manifest the staging-builds workflow deploys to the dedicated
// Cloudflare Pages project and is available as an opt-in preset.
export const OTA_VERSION_URL_LEGACY_PROD = "https://ota.mentraglass.com/prod_live_version.json"
export const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version_v2.json"
export const OTA_VERSION_URL_STAGING = "https://staging.ota.mentraglass.com/staging_live_version.json"
