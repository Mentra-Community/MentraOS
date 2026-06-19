# CI Gate — single required check for `dev` PRs

## Problem this solves

Branch protection requires a **fixed list of check names**. Our area builders are
**path-filtered** (iOS/Android only run when `mobile/**` changes, cloud only when
`cloud/**` changes, etc.). A path-filtered workflow that doesn't match **never
reports a status**, so requiring it directly leaves the PR stuck forever in
*"Expected — waiting for status to be reported."* That is exactly what blocked
every `dev` PR (#3204, #3205, #3206, …): the required contexts
`Build Mobile App (iOS/Android)`, `Build ASG Client`, `Upload to staging-builds release`
come from `staging-builds.yml`, which only runs on **push to `staging`** — never
on a PR — so they could never report.

## How `ci-gate` works

`.github/workflows/ci-gate.yml` runs on every PR into `dev` and again each time a
builder workflow finishes. It reads the check-runs that **actually exist** for the
PR head commit and posts a single `ci-gate` commit status:

| Situation | `ci-gate` |
|---|---|
| Every builder that ran finished success / skipped / neutral | ✅ success |
| Any builder that ran finished failure / cancelled / timed_out | ❌ failure |
| A builder that ran is still in progress | ⏳ pending |
| A builder **did not run** (path filter didn't match this PR) | not gated — ignored |

So a **cloud-only PR** is gated on the cloud builds + cloud tests and is **not**
gated on iOS/Android/ASG (those never ran). A **mobile-only PR** is gated on
iOS/Android/jest and not on cloud. Each PR is gated **only on the areas it
touches** — which is the requirement.

### Builders aggregated

| Area | Workflow | Check name(s) | Runs when |
|---|---|---|---|
| iOS | Mobile App iOS Build | `build` | `mobile/**` |
| Android | Mobile App Android Build | `build` | `mobile/**` |
| ASG | MentraOS ASG Client Build | `build` | `asg_client/**` |
| Mobile jest | Mobile App Quality Checks | `test` | `mobile/**` |
| Cloud | 🧪 Test Cloud build | `Build cloud/packages/cloud` | all dev PRs (self-skips internally) |
| SDK | 🧪 Test SDK build | `Build cloud/packages/sdk` | all dev PRs (self-skips internally) |
| Console | 🧪 Test Console build | `Build cloud/websites/console` | all dev PRs (self-skips internally) |
| Store | 🧪 Test Store build | `Build cloud/websites/store` | all dev PRs (self-skips internally) |
| Cloud tests | Run Cloud Tests ☁️ | `Build & Test` | `cloud/**` (PR trigger added in this PR) |

## Rollout (manual step — do AFTER this PR merges to `dev`)

`workflow_run` triggers only fire for a workflow that exists **on the default/base
branch**. So `ci-gate` becomes active only once this PR is merged to `dev`. Then:

1. Open a throwaway PR to `dev` touching `mobile/**`; confirm `ci-gate` goes
   pending → success and that iOS/Android/jest are the builders it waited on.
2. Open one touching only `cloud/**`; confirm `ci-gate` waits on the cloud builds
   + `Build & Test` and **not** on mobile.
3. Set branch protection on `dev` to require the single context **`ci-gate`**
   (Settings → Branches → `dev`, or the API call below). Remove the old
   `Build Mobile App (*)`, `Build ASG Client`, `Upload to staging-builds release`,
   and the individual `Build cloud/*` contexts — `ci-gate` subsumes them.

```bash
gh api -X PATCH repos/Mentra-Community/MentraOS/branches/dev/protection/required_status_checks \
  -f strict=false \
  -f 'contexts[]=ci-gate'
```

> ⚠️ Never rename the `ci-gate` context. Branch protection pins to that exact
> string; renaming it re-introduces the "waiting forever" block.

## Note on `staging-builds.yml`

`Upload to staging-builds release` and the staging mobile/iOS/ASG builds are
**deliberately not** part of `ci-gate` — they publish OTA manifests and release
assets and must stay `staging`-push-only. They should not be required on `dev`.
