---
name: mentra-update-live-firmware
description: Update MentraOS firmware_live.json from the published BES and MTK feeds and prepare a PR, preserving production MTK upgrade paths. Use for firmware manifest bumps and production-to-latest incremental patch maintenance, not firmware source builds or device installation.
---

# Update Mentra Live firmware

Update `asg_client/ota_manifests/firmware_live.json` in `Mentra-Community/MentraOS`.
Default new PRs to `dev`; honor an explicitly requested branch or existing PR.
The occasional name `live_firmware.json` refers to this same manifest—do not
create a second file.

## Inputs and scope

- BES: <https://firmwarecdn.mentraglass.com/latest.json>
- MTK: <https://mtkfirmware.mentraglass.com/latest.json>
- Production: the manifest from the latest actually released production version.

Read repository and ASG guidance. Preserve dirty primary checkouts by using an
isolated worktree from a freshly fetched base. Search for an applicable open PR
before creating a duplicate. A manifest update request authorizes preparing and
pushing that PR; honor any user review/merge boundary. It does not by itself
request firmware builds, installations, release publication, or CDN changes.
If only BES or only MTK is requested, change only that component.

## Establish the production MTK baseline each time

Do not use the development `latest.json` target as the production baseline.
Start by inspecting `origin/main`'s firmware manifest and correlate it with the
latest successful production release's pinned OTA manifest/release record.
If main contains unreleased changes, use the released manifest instead. Resolve
any disagreement before selecting an incremental patch.

The production target is its `mtk_full_ota.end_firmware`, when present, consistent
with the end of its patch graph. Older manifests may have no full OTA: find the
unique terminal version reached by all production patch paths. An ambiguous or
disconnected graph needs investigation, not a guessed version.

Preserve the released production patch entries. For a production target `P` and
latest MTK target `L`:

- Select the published incremental with **exact** `start_firmware == P` and
  `end_firmware == L`.
- If dev already has a non-production entry starting at `P`, replace it. Do not
  append a second entry with that start version: clients select by source.
- Otherwise add the `P → L` entry, keeping the production entries intact.
- After a production release promotes `L`, it becomes the new production base.
  The previously released `P → L` entry is now preserved history. The next
  development update adds or updates `L → next`, using that newly published
  incremental. Never freeze the baseline to a date from an earlier run.
- If latest equals production, no production-to-latest bridge is needed.
- If the required incremental is missing or multiple candidates match, report
  the exact missing/ambiguous source and target. Do not manufacture a URL, relabel
  a full OTA as a patch, import a downgrade, or launch an unrequested build.

Only import `mtk_full_ota` and the selected upgrade patch from the MTK feed.
Do not copy `mtk_downgrade_patches`, publication metadata, or replace the entire
patch array with the feed's shorter list. Update BES version, URL, and SHA-256.
Include size only if it is already part of the destination BES entry.

## Fetch, verify, prepare

Use `curl --fail --silent --show-error --location` for the feeds and artifacts.
Python's default urllib user agent has received 403 from this CDN when curl
succeeded; that is not evidence of missing firmware. Save feed snapshots and
validation output outside the checkout.

Before pinning the selected artifacts:

1. Correlate the feed source commit/tag with the intended merged upstream BES or
   MTK revision. Avoid selecting an unrelated PR build from a newer timestamp.
2. Download and hash each changed artifact; require the declared SHA-256 and
   byte count. For combined updates this is BES, MTK full OTA, and MTK patch.
3. Inspect MTK ZIP `META-INF/com/android/metadata` and `payload_properties.txt`:
   require A/B OTA for Mentra Live, incremental source constraints on the patch,
   no source constraint on the full OTA, no wipe/downgrade request, matching
   post-build metadata, and the payload's declared size and FILE_HASH.
   The Android metadata may use generic `MentraLive`/`mp1k61v164bspP6` values;
   it does **not** independently prove the dated firmware version. Use release
   provenance for that mapping; never invent a version-field assertion.
4. For BES, preserve a direct firmware BIN URL from its feed. Do not substitute
   the raw factory image for the compressed OTA payload. If comparing against
   a GitHub release ZIP, compare with its `update_ota.bin`.

Use the local helper after verifying inputs. It only transforms local JSON;
it does not establish release provenance, fetch artifacts, commit, or publish:

```sh
python3 <skill-dir>/scripts/prepare_manifest.py \
  --current <worktree>/asg_client/ota_manifests/firmware_live.json \
  --production <evidence>/production-firmware.json \
  --mtk-latest <evidence>/mtk-latest.json \
  --bes-latest <evidence>/bes-latest.json \
  --output <evidence>/candidate-firmware.json
```

Omit `--bes-latest` for MTK-only updates. For BES-only updates omit
`--production` and `--mtk-latest`. Review the candidate, then copy it over the
manifest in the isolated worktree. A helper rejection should be investigated;
do not weaken its checks simply to produce a diff.

## Validate and deliver

- Confirm only the requested fields changed, historical production entries are
  unchanged, source versions are unique, all upgrade paths reach the target,
  and the full OTA target agrees with the development bridge.
- Run `git diff --check` and the repository's
  `.github/scripts/collect-ota-release-inputs.mjs` on the candidate manifest.
  The `validate-asg-ota-manifest.sh` script validates an assembled manifest with
  an `apps` section; do not apply it directly to this firmware-only file.
- Run the relevant existing coordinated OTA/release-family tests. They read
  `.github/release-family.json`, its package manifests, and the current family
  changelog; include those files if using a sparse checkout.
- Re-fetch the latest feeds before publishing. If a selected release changed,
  reselect and verify its artifacts before updating the PR. Avoid empty PRs
  when the pins already match.
- Commit only `asg_client/ota_manifests/firmware_live.json`. The PR should state
  BES/MTK targets, production baseline, patch replacement/addition, preserved
  historical paths, and validation. Report CI status separately from local
  checks and do not imply that manifest validation proves device behavior.
- Return the PR URL. Leave it open when user approval was requested; continue
  merge/release work only within the user's authorization.

Approved example: [MentraOS PR #4071](https://github.com/Mentra-Community/MentraOS/pull/4071).
Use it for diff shape, never as authority for current version numbers.

Helper regression checks: `python3 -m unittest discover -s <skill-dir>/scripts -p 'test_*.py'`.
