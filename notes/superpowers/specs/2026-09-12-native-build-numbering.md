---
status: active
owner: aisraelov
---

# Native release build numbers

The release family's root `package.json` is the source of the marketing version.
Coordinated Android and iOS builds continue to share one pinned integer:
`MAJOR * 100000000 + MINOR * 10000000 + PATCH * 1000000 + BUILD`.
For example, family 3.2.0, native build 222 is `320000222` on Android
(`versionCode`) and iOS (`CFBundleVersion`); the visible version is 3.2.0.

The phone scheme supports major 1–20, minor/patch 0–9, and build 1–999999.
Overflow fails explicitly; it must not wrap into another family's range.
This is separate from the glasses ASG allocator and its encoding.

## Reservations and retries

Dev, staging and production reserve numbers through the same GitHub Git ledger
on `mentra-native-build-ledger`. Its root `native-builds.json` contains immutable
reservations keyed by coordinated workflow run ID or production release/attempt.
A non-force ref update atomically commits each reservation. Concurrent writers
that lose the update reread and allocate above the winner. A retry with the same
key returns the original allocation; changing its family, source or count fails.
Never delete, reset, or force-push this branch. Failed builds consume their numbers.

The workflow run number is a minimum native sequence, not a separate allocator.
A production reservation can advance the native sequence ahead of the dev/beta
prerelease suffix. The frozen release plan records the actual native number.
Production reserves a pair when it needs a non-promotable compatibility lab,
otherwise one number. Compatibility lab builds intentionally keep the previous
marketing version while consuming a reservation in the promoted family's range.
They remain confined to TestFlight/internal app sharing.

Dry runs calculate a preview without modifying the ledger or publishing.
Store uploads require the frozen number; Android checks before building and
again before upload. An existing Play number is only a retry when this release's
immutable Android artifacts were already present at the start of the job.

## Store ordering

The checked-in `.github/native-build-policy.json` selects the Mentra App tracks:
`dev`, `beta`, `production-candidates`, and `production`. The former `internal`
track remains in audit inventories but receives no new coordinated builds.
The Bluetooth SDK example app retains its own existing tracks.

Production takes a floor from its candidate and production tracks, selected beta,
and iOS inventories scoped to the target marketing version (plus the previous
marketing version if building a compatibility lab). A newer dev train must not
force an older production train into the wrong numeric family. Unexpected high
codes on a required destination cause an error; they are never silently adopted.
The full Apple maximum and Play inventory remain available for audit.

iOS does not use Google Play tracks. It retains the current TestFlight groups
and shared pinned number. Its per-marketing-version inventory prevents an
unrelated iOS train or the retired Android internal release from raising the
production allocation. Existing frozen records without a Play track retain
their original internal-track interpretation; they are not rewritten.

## Rollout prerequisites

1. In Play Console create closed testing tracks with API identifiers `dev` and
   `production-candidates`, and configure their testers/countries. A first closed
   release may require review. Pause the existing internal track; do not delete
   published bundles. The two affected testers must opt out of internal testing,
   uninstall their `900000002` copy, and opt into/install the intended new track.
2. Merge to dev for new dev builds. Reconcile the release tooling into staging
   and main before using the new production preparation flow: those workflows
   explicitly execute tooling from main. Start fresh release/promotion attempts;
   rerunning old immutable plans does not renumber them.
3. The workflow token must be able to create/update the ledger branch. The
   branch contains allocation data only. Exclude it from cleanup automation and
   disallow force updates/deletion in the repository's operational policy.
4. Verify one dev upload, one same-run retry, then a production preparation.
   Inspect the generated APK/IPA version checks, ledger reservation, frozen plan,
   Play destination and TestFlight build. No store/ledger mutations are performed
   by the PR's unit tests.

## Verification

Unit coverage exercises concurrent Git ref races, response loss after commit,
retry identity, duplicate reservations, family boundaries, store downgrade and
collision checks, scoped Apple inventory pagination, and production allocation
with the retired `900000002` build present. Release workflow contract tests and
CLI plan/environment generation cover how the reserved integer reaches both
native configurations. Real store publication remains a rollout check.
