# CI Gate — single required check for `dev` PRs

## Problem this solves

Branch protection requires a **fixed list of check names**. Our area builders are
**path-filtered** (iOS/Android only run when `mobile/**` changes, cloud only when
`cloud/**` changes, etc.). A path-filtered workflow that doesn't match **never
reports a status**, so requiring it directly leaves the PR stuck forever in
_"Expected — waiting for status to be reported."_ That is exactly what blocked
every `dev` PR (#3204, #3205, #3206, …): the required contexts
`Build Mobile App (iOS/Android)`, `Build ASG Client`, and the former staging
publisher never belonged to the PR validation surface, so they could never all
report on a PR.

## How `ci-gate-dev` works

`.github/workflows/ci-gate.yml` runs on every PR into `dev` and again each time a
gated builder workflow starts/finishes. It gates on the **workflow runs** for the
PR head commit — matched by **workflow name** against an explicit allowlist — and
posts a single `ci-gate-dev` commit status:

| Situation                                                                | `ci-gate-dev`       |
| ------------------------------------------------------------------------ | ------------------- |
| Every gated workflow that ran finished success / skipped / neutral       | ✅ success          |
| Any gated workflow that ran finished failure / cancelled / timed_out / … | ❌ failure          |
| A gated workflow that ran is still in progress / queued                  | ⏳ pending          |
| A gated workflow **did not run** (path filter didn't match this PR)      | not gated — ignored |

Two kinds of gated workflow, with different "runs when" behavior:

- **Path-filtered builders** — iOS/Android/ASG/jest, `Bun Lockfile Checks`, and
  `Run Cloud Tests ☁️` only run when their area changes (`mobile/**`,
  `asg_client/**`, lockfile/workspace package manifests, `cloud/**`). On a PR
  that doesn't touch their area they **don't run at all**, so the gate never
  waits on them. This is the heavy work (Mac builds, device tests) plus the
  targeted dependency-integrity work we want scoped — a cloud-only PR never runs
  iOS/Android, and vice-versa.
- **Always-on cloud builds** — the four `🧪 Test * build` workflows have an
  **unfiltered** `pull_request` trigger, so they run on **every** `dev` PR. They
  self-skip internally (via `dorny/paths-filter`) when their package didn't
  change, reporting `success` quickly. So the gate technically always includes
  them, but on an unrelated PR they finish near-instantly and don't meaningfully
  block.

Net effect: each PR is gated on the **heavy** builders only for the areas it
touches (the requirement — your cloud engineer never runs iOS/Android), plus the
four lightweight cloud build checks that run-and-pass on everything. Nothing that
doesn't run is ever waited on.

### Why match by workflow name, not job/check-run name

Several workflows name their job `build` (iOS, Android, ASG — **and the unrelated
`Recovery Worker Build`**), so matching gated checks by the job name `build` is
ambiguous and would pull in workflows we never meant to gate on. The gate instead
reads `GET /actions/runs?head_sha=…`, which exposes each run's **unique workflow
name** plus its overall status/conclusion, and matches against the allowlist
below. `Recovery Worker Build` is deliberately excluded.

### Workflows aggregated (the allowlist)

| Area        | Workflow name               | Runs when                                                 |
| ----------- | --------------------------- | --------------------------------------------------------- |
| iOS         | `Mobile App iOS Build`      | `mobile/**`                                               |
| Android     | `Mobile App Android Build`  | `mobile/**`                                               |
| ASG         | `MentraOS ASG Client Build` | `asg_client/**`                                           |
| Mobile jest | `Mobile App Quality Checks` | `mobile/**`                                               |
| Release     | `Coordinated Release Family Checks` | coordinated release definitions and workflows      |
| Lockfiles   | `Bun Lockfile Checks`       | root/mobile/sdk lockfiles and workspace package manifests |
| Cloud       | `🧪 Test Cloud build`       | all dev PRs (self-skips internally)                       |
| SDK         | `🧪 Test SDK build`         | all dev PRs (self-skips internally)                       |
| Console     | `🧪 Test Console build`     | all dev PRs (self-skips internally)                       |
| Store       | `🧪 Test Store build`       | all dev PRs (self-skips internally)                       |
| Cloud tests | `Run Cloud Tests ☁️`        | `cloud/**` (PR trigger added in this PR)                  |

If you add or remove a builder, update the `GATED` set **and** the `workflow_run`
`workflows:` list in `ci-gate.yml` — both must list the same workflow names.

## Naming: `ci-gate-dev`

The status context is `ci-gate-dev` (not just `ci-gate`) so a future
`ci-gate-staging` can mirror this file for the `staging` branch without a name
clash. Each branch gets its own gate context.

## Rollout (manual step — do AFTER this PR merges to `dev`)

`workflow_run` triggers only fire for a workflow that exists **on the default/base
branch**. So `ci-gate-dev` becomes active only once this PR is merged to `dev`.
Then:

1. Open a throwaway PR to `dev` touching `mobile/**`; confirm `ci-gate-dev` goes
   pending → success and that iOS/Android/jest are the builders it waited on.
2. Open one touching only `cloud/**`; confirm `ci-gate-dev` waits on the cloud
   builds + `Run Cloud Tests ☁️` and **not** on mobile.
3. Set branch protection on `dev` to require the single context **`ci-gate-dev`**
   (Settings → Branches → `dev`, or the API call below). Remove the old
   `Build Mobile App (*)`, `Build ASG Client`, `Upload to staging-builds release`,
   and the individual `Build cloud/*` contexts — `ci-gate-dev` subsumes them.

```bash
gh api -X PATCH repos/Mentra-Community/MentraOS/branches/dev/protection/required_status_checks \
  -f strict=false \
  -f 'contexts[]=ci-gate-dev'
```

> ⚠️ Never rename the `ci-gate-dev` context. Branch protection pins to that exact
> string; renaming it re-introduces the "waiting forever" block.

## Note on coordinated releases

`Coordinated Mentra Release` is deliberately not part of `ci-gate-dev`: it
publishes packages, OTA manifests, and mobile builds after a commit lands on
`dev` or `staging`. Pull requests run the component validation workflows only.
