// ASG OTA manifest URLs.
// Production remains the MentraOS compiled fallback because current production
// glasses either advertise that URL or, on older builds, ignore the ota_start
// manifest override and install from their compiled default.
// Staging is the manifest the staging-builds workflow deploys to the dedicated
// Cloudflare Pages project and is available as an opt-in preset.
export const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version.json"
export const OTA_VERSION_URL_STAGING = "https://staging.ota.mentraglass.com/staging_live_version.json"
