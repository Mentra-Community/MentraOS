/** Shared compile-time consumer baseline; packaged metadata never selects a live override. */
function backendTarget(value) {
  return value?.trim() || "https://core.dev.us-west-2.mentraglass.com"
}
module.exports = {backendTarget}
