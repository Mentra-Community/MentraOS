---
status: active
owner: Philippe
---

# PR testing builds and Slack delivery

## Outcome

Publish a ready-to-test post in Slack #pr-builds (C0C1V60KLA0) with the Android
APK, PR/revision, Dev backend, and exact ASG, BES and MTK OTA targets. Testers
install one APK; it already selects that revision's glasses update manifest.

## App code and configuration

Keep storing signed APKs on the existing pr-builds GitHub release. Search their
asset labels for a matching mobile build fingerprint. No unsigned cache, extra
binary copies, or new cleanup policy. A missing/expired match means a normal
build. PR uploads no longer duplicate the same APK in Actions artifacts.

The fingerprint covers tracked mobile inputs, shared cloud sources, native
inputs, lockfiles, CI build scripts, tool versions and build-time environment.
Exclude only per-run packaging inputs: the PR OTA URL and Android build number.
Record the fingerprint and original compiled source revision inside the APK,
and fingerprint plus final APK SHA-256 in its GitHub release asset label.
Verify downloaded candidates against their hash, embedded provenance and the
current upload signing certificate before reuse. Existing APKs without this
contract are not reusable.

Use Expo's existing assets/app.config JSON, read through expo-constants, for the
PR OTA URL. PR JavaScript compiles with no per-revision OTA URL. Official
release/local builds keep the existing environment-based configuration. The
host passes the packaged PR pin into the existing engine/deployment OTA policy;
Super Mode overrides and workspace policy keep their existing precedence.

For both fresh and reused PR APKs, rewrite only app.config and the numeric
AndroidManifest.xml versionCode, strip obsolete signatures, zipalign, sign with
the upload certificate, and verify. Allocate a fresh phone build number on each
packaging run so an older cached compilation remains installable. Native/JS
payload entries must remain byte-for-byte equal to the selected base. Retain
the original compilation revision separately from the target PR head.

This is Android PR distribution only. iOS PR CI produces no signed distributable
and is not advertised as installable. Reuse cannot span incompatible mobile
inputs or configuration. Signed APK reuse saves compile time, not APK storage.

## Workflow coordination

Run Android selection on mobile/shared-build-input and ASG/firmware changes;
ASG's trigger set must cover all Android triggers. Preserve ASG's existing
fingerprint selection and per-PR-head manifest publication.

After Android completes, a separate notification job waits for the matching
ASG workflow for this PR head, including the reuse path where its build job is
skipped. Verify downloadable Android/manifest/ASG assets and manifest identity
before announcing readiness. Superseded/closed PRs and cancelled runs stay quiet.
Report terminal failures with log links. Persist notification identity in one
bot PR comment to suppress duplicate ready posts for reruns and to allow a
failure to be followed by a successful build. Do not wait on unrelated CI.

Slack reads ASG versionName/versionCode from apps["com.mentra.asg_client"], BES
from bes_firmware.version and MTK from mtk_full_ota.end_firmware in the published
PR manifest. Firmware source is asg_client/ota_manifests/firmware_live.json at
the built revision; do not infer MTK from a patch list or from current dev.

Use SLACK_WEBHOOK_PR_BUILDS, an incoming webhook configured for C0C1V60KLA0.
Missing configuration is visible in CI and prevents a claim of Slack delivery.
No release/store/example/docs rows. Include download retention information from
the existing seven-day PR release cleanup policy.

## Validation

- Fingerprint stability across ASG/firmware-only changes and packaging inputs;
  invalidation for mobile/shared sources, dependencies and embedded env changes.
- APK repackaging with binary XML, unchanged code entries, versionCode/config
  agreement, zip alignment and signature/certificate verification.
- Runtime pin precedence: packaged PR config, existing official env, workspace
  selection and Super Mode; reject malformed PR config without stale fallback.
- Notification readiness/failure, stale revisions, ASG reuse, missing artifacts,
  exact firmware fields, escaping and duplicate suppression.
- Real PR CI cold build and reuse rerun, actual release downloads and first
  #pr-builds delivery. Device OTA qualification is separate from build readiness.
