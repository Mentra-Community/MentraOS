// ASG OTA manifest URLs.
// Production uses the v2 manifest for normal forward OTA checks. The previous
// production manifest stays available as the rescue manifest for old ASG clients
// that ignore ota_start.ota_version_url and must unstick themselves via their
// compiled default before continuing on v2.
// Staging is the manifest the staging-builds workflow deploys to the dedicated
// Cloudflare Pages project and is available as an opt-in preset.
export const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version_v2.json"
export const OTA_VERSION_URL_STAGING = "https://staging.ota.mentraglass.com/staging_live_version.json"
