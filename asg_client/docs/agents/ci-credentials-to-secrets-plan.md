# Plan: Move signing/upload credentials from runner disk → GitHub secrets

**Goal:** Stop hand-copying `~/.mentra/credentials/` to every CI runner. Put all *live* signing/upload credentials in GitHub Actions secrets, so any runner (mac or Ubuntu) can release-sign, and PR builds sign with the real release key. **Never modify `~/.mentra/credentials/`** — it stays as the local-dev source of truth.

## Design decisions (settled)
- **Materialize into the repo-local fallback path**, not `~/.mentra`. Both gradle files already check `~/.mentra/credentials/<file>` first, then fall back to a repo-local `credentials/` dir. In CI we write the decoded keystore to the repo-local path (gitignored, only exists in the ephemeral checkout). **Zero `build.gradle` changes.** Never touches `~/.mentra`.
  - ASG: `asg_client/credentials/asg-keystore.jks` (gradle fallback at `app/build.gradle:85` → `../credentials/`)
  - Mobile: `mobile/credentials/upload-keystore.jks` (gradle fallback at `android/app/build.gradle` → `../../credentials/`)
- **Passwords via `ORG_GRADLE_PROJECT_*` env vars** (Gradle's native env→property bridge). `project.hasProperty("ASG_STORE_PASSWORD")` is satisfied by env `ORG_GRADLE_PROJECT_ASG_STORE_PASSWORD`. No gradle.properties file, no build.gradle change.
- **Incremental rollout:** wire one workflow, prove it signs, then the rest.
- **Separate branch** from PR #3254 (disk-guard/ubuntu/ci-gate).

## Live vs stale credentials (confirmed by code refs)
**MIGRATE (live):**
| File on disk | Referenced by |
|---|---|
| `asg-keystore.jks` | asg_client/app/build.gradle:84 |
| `upload-keystore.jks` | mobile/android/app/build.gradle:97 |
| `ota-keystore.jks` | asg_client/ota_updater/app/build.gradle (OTA) |
| `google-play-key.json` | mobile/scripts/release-android.mjs:188 (`GOOGLE_PLAY_JSON_KEY`) |
| `AuthKey_VKL3ALRUBR.p8` | via appstore-connect.env `ASC_API_KEY_PATH` |
| `appstore-connect.env` contents | mobile/scripts/release-ios.mjs:30 |

**DROP (stale — no code references; old `com.augmentos` app, we're `com.mentra.mentra` only):**
- `augmentos-6dd52885cf88.json`, `service-account.json` — neither is referenced anywhere. Do NOT migrate.
- Any old `AuthKey_*.p8` for the augmentos app — only `AuthKey_VKL3ALRUBR.p8` is present/referenced now.

**Already secrets (no change):** `MATCH_PASSWORD`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MAPBOX_*`, `SENTRY_AUTH_TOKEN`, `APPLE_TEAM_ID`.

## GitHub secrets to create (you create these; I never read key contents)
Binary files → base64 (`base64 -i file | pbcopy` on mac):
- `ASG_KEYSTORE_B64`        ← `base64 -i ~/.mentra/credentials/asg-keystore.jks`
- `UPLOAD_KEYSTORE_B64`     ← `base64 -i ~/.mentra/credentials/upload-keystore.jks`
- `OTA_KEYSTORE_B64`        ← `base64 -i ~/.mentra/credentials/ota-keystore.jks`
- `ASC_API_KEY_P8_B64`      ← `base64 -i ~/.mentra/credentials/AuthKey_VKL3ALRUBR.p8`

Plain string secrets:
- `ASG_STORE_PASSWORD`, `ASG_KEY_PASSWORD`, `ASG_KEY_ALIAS` (= `asg`)
- `MENTRAOS_UPLOAD_STORE_PASSWORD`, `MENTRAOS_UPLOAD_KEY_PASSWORD`, `MENTRAOS_UPLOAD_KEY_ALIAS` (= `upload`)
- `OTA_STORE_PASSWORD`, `OTA_KEY_PASSWORD`, `OTA_KEY_ALIAS` (= `ota`)
- `GOOGLE_PLAY_KEY_JSON` (paste the JSON file contents directly)
- `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` (from appstore-connect.env)

## Implementation steps (incremental)

### Step 0 — shared composite action `.github/actions/inject-signing`
Inputs flag which creds to materialize (android-asg / android-mobile / ota / play / ios). It:
- base64-decodes each requested keystore secret to the repo-local `credentials/` path
- writes `google-play-key.json` to `$RUNNER_TEMP/creds/` and exports `GOOGLE_PLAY_JSON_KEY`
- writes the p8 + a generated `appstore-connect.env` to `$RUNNER_TEMP/creds/` and exports an override var (see iOS step)
- exports the `ORG_GRADLE_PROJECT_*` password vars to `$GITHUB_ENV`
- guards: if a required secret is empty, fail with a clear message (so we never silently fall back to debug signing again)

### Step 1 — PR ASG build (prove it) — `mentra-asg-client-build.yml`
Add inject-signing(android-asg) before the gradle build. Verify the build log prints "Using PRODUCTION signing key" and the APK is signed with the real key (verify via `apksigner verify --print-certs`). This is the canary.

### Step 2 — PR Android build — `mentra-app-android-build.yml` (now Ubuntu)
Add inject-signing(android-mobile). Now PR Android APKs are release-signed on Ubuntu — satisfies "no builds without my release key."

### Step 3 — staging Android job — `staging-builds.yml`
Add inject-signing(android-mobile, play). Lets staging sign + Play-upload from secrets. Keeps mac for now (no need to move staging), but removes its dependency on the on-disk folder.

### Step 4 — iOS staging — `staging-builds.yml` iOS job + `release-ios.mjs`
Small `release-ios.mjs` edit: `loadASCConfig()` honors `MENTRA_ASC_CONFIG_PATH` env override before falling back to `~/.mentra/...`. inject-signing(ios) writes the env file + p8 to temp and sets that var. Match certs already come from secrets — unchanged.

### Step 5 — OTA
Wire `OTA_*` secrets wherever the OTA build runs (ota_updater). Lowest priority — currently defaults to "android" placeholder; confirm whether OTA release signing is even active in CI before investing.

## Validation per step
- Android: `apksigner verify --print-certs <apk>` shows the real cert (not the debug `CN=Android Debug`).
- Play: dry-run the upload lane or check it reaches Play internal.
- iOS: TestFlight upload succeeds with the API key.
- Each step is its own commit; a regression is isolated to one credential path.

## Risk notes
- Blast radius is *signing/upload*, not compile — a wrong move breaks release distribution, so validate cert output before merging each step.
- The repo-local `credentials/` dirs MUST stay gitignored (verify `.gitignore` covers `asg_client/credentials/` and `mobile/credentials/`) so a decoded keystore can never be committed.
- Secrets are masked in logs; never `cat` a decoded keystore/p8/json in a step.
