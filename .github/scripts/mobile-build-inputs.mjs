// Metro aliases only these Cloud V2 client/protocol sources into the Mentra App.
// Server packages and websites do not affect app compilation. Keep this source
// boundary shared by PR binary fingerprints and coordinated compiler caches.
export const MOBILE_SOURCE_PATHS = [
  "mobile",
  "android_core",
  "cloud-v2/packages/cloud-client/src",
  "cloud-v2/packages/cloud-client/react-native",
  "cloud-v2/packages/cloud-client/package.json",
  "cloud-v2/packages/protocol/src",
  "cloud-v2/packages/protocol/package.json",
  "cloud-v2/packages/runtime/src/protocol",
  // mobile/scripts/postinstall provisions aliased dependencies from this lock.
  "cloud-v2/bun.lock",
  "package.json",
  "bun.lock",
]

export const MOBILE_SOURCE_GLOBS = MOBILE_SOURCE_PATHS.map((entry) =>
  entry.endsWith(".json") || entry.endsWith(".lock") ? entry : `${entry}/**`,
)
