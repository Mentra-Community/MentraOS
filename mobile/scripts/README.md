# mobile/scripts

Build, release, dev, runner-bootstrap, and log-tooling scripts for the MentraOS mobile app.

Most are invoked via `bun` (see `mobile/package.json` `scripts:` section) and are NOT meant to be run directly — but they're also self-contained enough to run with `zx ./scripts/foo.mjs` if you know what you're doing.

## Quick reference

### Dev / day-to-day

| Script | Purpose |
|---|---|
| `start.mjs` | Wrapper around `expo start`. Sets `EXPO_PUBLIC_BUILD_*` env vars from git first. Invoked via `bun start`. |
| `android.mjs` | Build + install + launch the app on a USB-connected Android device. `bun android`. |
| `ios.mjs` | Same for iOS Simulator. `bun ios`. |
| `android-wireless.mjs` | Switch a USB-connected Android device to wireless adb. |
| `android-dbg.sh` | Set up adb reverse proxies for local-network dev. |
| `android-flash-prebuilt.mjs` | Flash a prebuilt APK to a device without rebuilding. |
| `android-internal.mjs` | Build for the Play Store "internal" track without uploading. |
| `set-build-env.mjs` | Helper: reads `git config user.name`, current branch, etc., and exports them as `EXPO_PUBLIC_BUILD_*` env vars so the in-app debug overlay can show "built by X on Y commit". Required by every release script. |

### Release pipeline

These get wired into the staging-builds CI workflow (`.github/workflows/staging-builds.yml`) and can also be invoked manually from your laptop.

| Script | Purpose |
|---|---|
| `release-all.mjs` | Convenience wrapper: runs `release-android.mjs` then `release-ios.mjs`. `bun run release:all`. |
| `release-android.mjs` | Build signed APK + AAB → upload APK to GitHub release as `Mentra_<X>p<Y>_Beta_N.apk` → upload AAB to Google Play internal track via fastlane. `bun run release:android`. |
| `release-ios.mjs` | Build signed IPA → upload to GitHub release as `Mentra_iOS_<X>p<Y>_Beta_N.ipa` → upload to TestFlight via `xcrun altool`. `bun run release:ios`. |
| `release-utils.mjs` | Shared helpers: `withRetry` (network ops), `isSentryTransientError` (Sentry retry predicate), `writeSummary` (per-platform release summary files). |
| `build-number.mjs` | Single source of truth for `CFBundleVersion` / `versionCode`. Derives from `Date.now()` so it's strictly monotonic across CI + local without needing a committed counter. |
| `build-google-play.mjs` | Standalone AAB build (no upload). Rarely used directly. |
| `ios-release.mjs` | Older iOS release path (pre-fastlane-match). Kept for now; prefer `release-ios.mjs`. |
| `build-number.d.mts` | TypeScript declarations for `build-number.mjs` so `app.config.ts` can import it cleanly. |

### Self-hosted runner setup + maintenance

| Script | Purpose |
|---|---|
| `setup-runner.sh` | Bootstrap a Mac mini into a working GitHub Actions self-hosted runner. **See [New runner setup guide](#new-runner-setup-guide) below.** |
| `runner-cleanup.sh` | Cross-platform cache cleanup. Scheduled by setup-runner.sh to run weekly. Also invokable manually for deep clean. See [Cleanup script](#runner-cleanup-script) below. |
| `runner-cleanup.plist.template` | macOS launchd unit installed by setup-runner.sh. |
| `runner-cleanup.service.template` | Linux systemd unit (not yet installed automatically; for when Linux runner support lands). |
| `runner-cleanup.timer.template` | Linux systemd timer that triggers the cleanup service. |
| `setup-ios.sh` | One-time `pod install` + Xcode setup for a fresh laptop checkout. Independent of CI. |
| `setup-sherpa-onnx-optional.sh` | Downloads the Sherpa ONNX model bundle. Optional; only needed if you're working on the on-device speech feature. |

### Log / debug tooling

| Script | Purpose |
|---|---|
| `log-viewer.sh` | Pretty-print + color the firehose from `bun start`. `bun dev:logs`. |
| `log-dashboard.sh` | Real-time stats + counters from the firehose. `bun dev:logs-dashboard`. |
| `log-filter.sh` | Grep-style filter by subsystem (BLE, audio, etc.). |
| `sherpa-download.js` | Re-fetches the Sherpa ONNX models if they got nuked or corrupted. |
| `preinstall.mjs` / `postinstall.mjs` | Hooks bun runs around `bun install`. Currently mostly no-ops with logging. |
| `model-download-config.json` | Config for `sherpa-download.js` listing which models to fetch + checksums. |

### Subdirectories

- **`old/`** — abandoned scripts kept for reference. Includes pre-Expo-migration build scripts. Do not edit.
- **`stress-test/`** — Maestro-driven stress testing runs. Per-run output dirs (`runs/<timestamp>-<scenario>/`) accumulate; periodically prune them.

---

## New runner setup guide

A short, opinionated walk-through for onboarding a new Mac mini into the build fleet. Assumes the reader knows what a GitHub Actions self-hosted runner is.

### Prerequisites

1. **Hardware**: Apple Silicon Mac mini. (Intel works but isn't tested.)
2. **macOS user account**: a dedicated user, not your personal one. Convention: name it for the machine (e.g. `bigbob`).
3. **Xcode**: installed from the App Store, launched once, license accepted. Sign into the Mentra Apple Developer account in Xcode → Settings → Accounts so the runner can do signed iOS archives.
4. **Network**: machine should be reachable on Tailscale (`tag:ci`) for remote debugging.
5. **A short-lived runner registration token**: visit https://github.com/Mentra-Community/MentraOS/settings/actions/runners/new and copy the `ghs_xxx` token from the displayed `./config.sh` command. Token expires in ~1 hour.

### Optional but recommended before running the script

- Disable "Prevent automatic login" in System Settings so the machine can reboot unattended.
- Disable screen lock / FileVault password prompts.

### Run the script

From this directory on the runner (clone the repo first):

```bash
git clone https://github.com/Mentra-Community/MentraOS.git
cd MentraOS/mobile/scripts
GH_RUNNER_TOKEN=ghs_xxx ./setup-runner.sh
```

The script is idempotent — re-running is safe and gets you the latest config (Ruby version, cleanup schedule, etc.).

To also install Tailscale and join the tailnet:

```bash
ENABLE_TAILSCALE=1 TAILSCALE_AUTHKEY=tskey-auth-xxx \
GH_RUNNER_TOKEN=ghs_xxx ./setup-runner.sh
```

Get a Tailscale auth key from https://login.tailscale.com/admin/settings/keys (single-use, tagged `tag:ci`, ephemeral).

### After the script finishes

Three manual steps the script can't automate:

1. **Copy credentials.** From an existing runner or your laptop:

   ```bash
   scp ~/.mentra/credentials/{appstore-connect.env,AuthKey_*.p8,google-play-key.json} \
       <user>@<new-runner>:~/.mentra/credentials/
   ```

   Also copy `~/.gradle/gradle.properties` if it has the `MENTRAOS_UPLOAD_*` keys (needed for Android release signing):

   ```bash
   scp ~/.gradle/gradle.properties <user>@<new-runner>:~/.gradle/gradle.properties
   ```

2. **Enable auto-login** in System Settings > Users & Groups so the machine recovers from power cuts without human intervention.

3. **Verify the runner shows up** at https://github.com/Mentra-Community/MentraOS/settings/actions/runners with the labels `self-hosted, macOS, ARM64`. If you used custom labels, also confirm those.

### Verify it actually works

Trigger a manual workflow run:

```bash
gh workflow run staging-builds.yml --ref staging
```

Watch the run and confirm a job picks the new runner.

---

## Runner cleanup script

`runner-cleanup.sh` is scheduled by `setup-runner.sh` to run weekly (Sundays 03:00 local). It defers automatically if a build process (gradle, xcodebuild, Xcode, bun, node, java, cmake) is detected.

### Tiers

- **Tier 1** (cheap caches): bun install cache, gradle build-cache + transforms, Android emulator system images, stale `_work` dirs older than 7 days. Next build is *not* noticeably slower.
- **Tier 2** (expensive caches): everything in Tier 1, plus the whole `~/.gradle/caches`, the user cache dir (`~/Library/Caches` on macOS, `~/.cache` on Linux), `~/.android/avd`, and `~/Library/Developer/Xcode/DerivedData/Mentra-*`. First build after Tier 2 is *significantly* slower (5-15 min cold gradle, ~10 min cold iOS archive).

Both tiers are run by the weekly scheduler.

### Manual invocations

```bash
# Default: --tier all, with build-process guard
~/mentra/runner-cleanup.sh

# Just Tier 1
~/mentra/runner-cleanup.sh --tier 1

# Force run even if a build is in progress (DANGEROUS — only if you're sure)
~/mentra/runner-cleanup.sh --force

# Dry-run: see what would be deleted without changing anything
~/mentra/runner-cleanup.sh --dry-run
```

### Logs

`~/mentra/runner-cleanup.log` — appended to on every run, trimmed to the last 500 lines automatically.

---

## Linux runner support

**Status: best-effort, untested.** `setup-runner.sh` has been extended with `case "$(uname -s)"` branches for Ubuntu/Debian (apt-get instead of brew, Linux Android SDK install, systemd timer instead of launchd plist for the cleanup scheduler, Linux-x64/arm64 GitHub Actions runner tarball, etc.) but nothing has been exercised on a real Linux box yet. Expect to fix bugs the first time you actually onboard a Linux runner.

A Linux runner only supports the Android + ASG client jobs, not iOS (Xcode-only). The `staging-builds.yml` Android job has `runs-on: [self-hosted, macOS, ARM64]` which currently excludes Linux — change to bare `self-hosted` once you have a working Linux runner and want it to pick up Android load.

Onboarding a Linux runner (after merge):

```bash
# On the Linux box:
git clone https://github.com/Mentra-Community/MentraOS.git
cd MentraOS/mobile/scripts
GH_RUNNER_TOKEN=ghs_xxx ./setup-runner.sh

# Then on your laptop:
scp ~/.mentra/credentials/google-play-key.json <user>@<linux-runner>:~/.mentra/credentials/
scp ~/.gradle/gradle.properties <user>@<linux-runner>:~/.gradle/gradle.properties
```

(No `appstore-connect.env` or `AuthKey_*.p8` needed since Linux doesn't do iOS.)
