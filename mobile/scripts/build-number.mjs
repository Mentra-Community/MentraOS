// Single source of truth for build numbers across iOS and Android.
//
// Strategy: derive from second-resolution wall clock since EPOCH_OFFSET_MS,
// plus a BASELINE that exceeds the highest versionCode ever submitted to
// either store. This guarantees:
//   - Strictly monotonic across CI + local + any machine (Date.now() always advances).
//   - Safe under both platform caps (iOS 18-char limit, Android 2.1B int32 cap).
//     Android headroom at second-resolution: ~67 years.
//   - No committed counter to bump, so no merge conflicts on parallel PRs.
//
// Same number is used for both iOS CFBundleVersion and Android versionCode.
//
// Pinning: release scripts set MENTRAOS_PINNED_BUILD_NUMBER before invoking
// `bun expo prebuild`, so the value baked into the native projects matches
// what the script logs in its summary. Without pinning, app.config.ts is
// evaluated multiple times during a single release (script summary, then
// prebuild, then any other config reads) and each evaluation gets a fresh
// timestamp — meaning the summary number drifts from the actual built number.

// Jan 1 2025 UTC. Picked once and never changed — moving it would break monotonicity.
const EPOCH_OFFSET_MS = Date.UTC(2025, 0, 1);

// Floor that must be exceeded by every derived build number. Set well above
// the highest versionCode ever uploaded to a store (latest was 275 as of
// the migration). Never lower this.
const BASELINE = 100_000;

export function getBuildNumber() {
  const pinned = process.env.MENTRAOS_PINNED_BUILD_NUMBER;
  if (pinned) {
    const n = parseInt(pinned, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const secondsSinceOffset = Math.floor((Date.now() - EPOCH_OFFSET_MS) / 1_000);
  return BASELINE + secondsSinceOffset;
}
