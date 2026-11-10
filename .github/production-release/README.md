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
   the release, and nothing is published. The PR's "Verify and deploy" checks
   this before the merge (its `promotion` job), and names the beta. That job
   then waits for the lab's `lab / promotion` check, about an hour: the
   current production app against staging's Cloud and miniapps, and its update
   of the glasses to the beta's software (see "What the lab checks first").
4. **The merge is the approval.** The push to `main` starts `release.yml`,
   whose gate names the beta it promotes in the run summary, and the release
   runs without waiting for anyone. Review the PR as the release decision.
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
   - The production docs go live last: MentraOS `production-docs` moves to
     the released commit, and Mintlify deploys it to `docs.mentraglass.com`.
     The merge alone changes nothing there.
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

## What the lab checks first

People keep the production app for days after the merge, iOS users through App
Review, while Cloud V2, the miniapps and the glasses' OTA manifest go live at
the merge. So the `promotion` job asks the lab, with a `promotion request`
check run on the PR's head naming the beta, and waits for its answer,
`lab / promotion`, which links each routine's run. The lab's main machine looks
every 5 minutes (`testing/agent/promotion.ts`, installed with
`testing/agent/install-promotion.sh`) and runs two suites at once. On the
current production app, as the stores deliver it, signed in to the lane's test
account:

- `account-email-android`: sign-out and sign-in.
- `open-close-miniapps-android`: Home with the glasses, and a miniapp.
- `mentra-ai-android`: a Cloud miniapp, asked by voice through the glasses.
- `glasses-version-android`: the glasses connected, with their version.

And on the beta's own app, `ota-promotion-android`: glasses on production's
software, updated by it through its normal offer and hotspot. That's how
people get the new glasses software: a production app only offers its own
release's.

The production app talks to production's Cloud as it is before the merge, so
this doesn't cover the Cloud the merge deploys against old apps. A failed check
is retried by
rerunning the `promotion` job, which asks again. To run it yourself, from
`testing/`: `bun agent/promotion.ts --beta <X.Y.Z-beta.N>`.

## Rehearse

Run `release.yml` by hand with `channel: production` from a commit staging
released: it rehearses that beta's promotion as a dry run, reading the store
and package state and building, without reserving, tagging or publishing. From
staging, the Mentra App builds with staging's configuration, since the
production one is only readable on `main`: the rehearsal tests the run, not
production's values.

## Setup it relies on

- Environment `prod` (branch `main`): `DOPPLER_TOKEN_CI_PRD` and
  `DOPPLER_TOKEN_MOBILE_PRD`, and access to the Copybara App's key. Its
  miniapp, Call, Store and website deploys use the same environment.
- Mintlify's production deployment (`docs.mentraglass.com`) follows MentraOS
  `production-docs`, not `main`.
- npm trusts `coordinated-release.yml` on MentraOS for every package, and the
  Bluetooth Starter Kit export (`bluetooth-starter-kit-export.yml`) moves the
  kit's `main` once npm `latest` and the production record are served.
