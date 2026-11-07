# Production release runbook

Production is the third channel of the monorepo's release
(`.github/workflows/release.yml` in Mentra-Community/Mentra), after dev and
staging. It promotes a beta that staging already released and that people
already tested: it never ships a source staging didn't release.

## Promote a beta

1. **Pick the beta.** Any of staging's last 10 completed releases
   (`mentra-v<X.Y.Z>-beta.<N>` on MentraOS). Its Slack message and release
   page list what it holds.
2. **Fill in App Store Connect.** Create the App Store version `X.Y.Z` if it
   doesn't exist, and write its What's New and review notes. App Review refuses
   a submission without them, and the release submits on its own.
3. **Open a pull request from that beta's commit to `main`** in the monorepo
   and merge it. Usually that's `staging` itself; if staging has moved on,
   branch from the beta's commit. The merged `main` must have exactly the
   beta's release inputs (`.github/ci/release-inputs.mjs`): anything else fails
   the release, and nothing is published.
4. **Approve the release.** The push to `main` starts `release.yml`. Its gate
   names the beta it promotes in the run summary, then the run waits for a
   reviewer of the `production-approval` environment. Nothing is built or
   published before that approval.
5. **The release runs** (about the time of a beta):
   - Cloud V2 prod is deployed from the same source, after its environment
     group is checked against `cloud-config-contract.json`.
   - The Mentra App is built with the production backend. Android goes to
     Google Play's production track as a draft. iOS is uploaded, attached to
     the App Store version `X.Y.Z` and submitted for App Review, with manual
     release and phased release.
   - npm publishes `X.Y.Z` under `latest`, Maven Central publishes `X.Y.Z`,
     and the Swift package gets the tag `X.Y.Z`.
   - The OTA manifest and bundle are byte-identical copies of the beta's, so
     production glasses get exactly the software the beta tested.
   - `finalize` writes `mentra-release-<X.Y.Z>.json` and tags `mentra-v<X.Y.Z>`
     on MentraOS `main`. The GitHub release `mentra-v<X.Y.Z>` is published as
     MentraOS's latest release, and Slack gets the result.
6. **Go live in the stores.** In Play Console, send the production draft for
   review and roll it out. In App Store Connect, release the approved version.
   These are the only manual steps after the merge.

A failed job is rerun in place: every upload is immutable and a rerun reuses
what it published. A beta that turns out wrong is fixed on staging and
promoted again as a new beta; a published `X.Y.Z` is never replaced.

## What runs on staging instead

Production used to repeat checks before each promotion. They run on the beta
now, so a beta that passed them is ready:

- The beta's own release builds and verifies the same source, the npm
  packages, the SDK and the Engine consumer.
- The lab's nightly routines test the beta's app and glasses software on
  hardware.
- The previous production app against the new Cloud: install the last beta
  of the previous family (its app uses the staging backend) and run the lab's
  suite against staging, where the new Cloud already runs.

## Rehearse

Run `release.yml` by hand with `channel: production` from a commit staging
released: it rehearses that beta's promotion as a dry run, reading the store
and package state and building, without reserving, tagging or publishing. From
staging, the Mentra App builds with staging's configuration, since the
production one is only readable on `main`: the rehearsal tests the run, not
production's values.

## Setup it relies on

- Environment `production` (branch `main`): `DOPPLER_TOKEN_CI_PRD` and
  `DOPPLER_TOKEN_MOBILE_PRD`, and access to the Copybara App's key.
- Environment `production-approval` (branch `main`): the required reviewers.
- npm trusts `coordinated-release.yml` on MentraOS for every package, and the
  Bluetooth Starter Kit export (`bluetooth-starter-kit-export.yml`) moves the
  kit's `main` once npm `latest` and the production record are served.
