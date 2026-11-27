---
name: configure-workflow-runners
description: Choose Mentra GitHub Actions runners when adding or editing workflows, reusable workflows, or runner matrices. Use Blacksmith for Linux and the office Mac mini for macOS.
---

# Configure workflow runners

Mentra uses Blacksmith for Linux compute and an office Mac mini for macOS.
GitHub-hosted Linux jobs in private repos consume the organization's shared
Actions allowance. A Blacksmith app installation does not redirect jobs:
each job's `runs-on` must select a Blacksmith runner.

## Select the runner

- Linux: use an existing Blacksmith x64 Ubuntu label. Start with
  `blacksmith-2vcpu-ubuntu-2404` for lightweight jobs and the equivalent of a
  standard private-repo Ubuntu runner. Use `blacksmith-4vcpu-ubuntu-2404` for
  heavier builds/tests; follow existing 8-vCPU Android build examples when needed.
  Preserve an intentionally pinned Ubuntu 22.04 environment with the corresponding
  `ubuntu-2204` Blacksmith label. Choose ARM only when the job supports it.
- macOS: use `runs-on: [self-hosted, macOS, ARM64, shared]`. A signed PR
  build asks for `[pr-signing]` instead, as in
  [the Mentra App iOS build](../../../.github/workflows/mentra-app-ios-build.yml):
  big-bob-2, big-bob-3, pro-1-build and pro-1-build-2, so either Mac can sign.
  The three Mac runners (big-bob, big-bob-2, big-bob-3) share one Mac mini;
  `shared` is on big-bob-2 and big-bob-3 only, so big-bob stays free for
  published staging releases, which get their labels from release.yml's
  `channel` job (`mac_runner`). Never leave `shared` off a PR or dev job.
  Preserve the iOS build's concurrency pattern so newer commits can cancel superseded builds
  without cancelling another branch's work. Check the runner's repository access
  and required Xcode/toolchain before relying on it in another repo.
- In the monorepo's pr.yml, pick by job size and signing:
  - a short Mac job (a few minutes: Swift tests, SwiftPM exports) asks for
    plan's `mac_light` (`runs-on: ${{ fromJSON(needs.plan.outputs.mac_light) }}`),
    or `[light, mac-mini]` when it needs a logged-in macOS user (a
    simulator) or secrets. The light runners (labels `light`, plus `mac-mini`
    on the Mac mini's big-bob-light) have no `self-hosted`, `macOS` or
    `shared` label, so no build lands on them; never put a build there.
  - an unsigned build asks for plan's `mac_build`: `unsigned` (big-bob-2,
    big-bob-3, and lab Mac CI runners without signing secrets) for
    same-repository code, the `shared` runners for imported MentraOS PRs and
    forks.
  - a signing job keeps `[self-hosted, macOS, ARM64, shared]`.
- In the monorepo's release.yml, Mac jobs take their labels from the
  `channel` job: `mac_runner` for signed builds (`release-mac-dev`: big-bob-2,
  big-bob-3 and the lab MacBook's pro-1-build and pro-1-build-2; `release-mac`
  adds big-bob for published staging and production), `mac_light` for short
  jobs (`release-light`: big-bob-light and pro-1-light). The MacBook's runners
  never carry `shared`, so imported MentraOS PRs and forks stay off it.

Hardware/device-test jobs must stay on the configured self-hosted runner that
owns their attached devices. In the monorepo that's `runs-on: [lab]`:
pro-1-lab, the lab's main machine as its own user, which runs suites across the
lab from its clone (`testing/agent`), one job at a time. Give it no secrets and
no checkout; it never builds. Use Blacksmith for general Linux CI compute.

Do not introduce `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, or another
GitHub-hosted Linux label unless the user explicitly requests an exception.
Do not fall back to GitHub-hosted macOS when the office runner is unavailable;
report the missing runner access or toolchain and continue independent work.

## Select Xcode in every self-hosted Mac job that builds

In the monorepo, `.xcode-version` at the root names the Xcode CI builds with.
Every job on a self-hosted Mac that checks out code and builds or tests with
Xcode, CocoaPods or Swift (signed or unsigned builds, light jobs, release jobs)
runs `.github/ci/select-xcode.sh` right after its checkout, before anything
touches them. A Mac job with no checkout that never builds, such as
`promotion_lab`, doesn't:

```yaml
      - name: Select the Xcode .xcode-version names
        run: '"$GITHUB_WORKSPACE/.github/ci/select-xcode.sh"'
```

A sparse checkout must include `.github/ci` (root files such as
`.xcode-version` come with any cone-mode checkout). The script sets
`DEVELOPER_DIR` for the job and prints `xcodebuild -version`; don't hardcode
`DEVELOPER_DIR`, an Xcode path or version in a workflow, and never install
Xcode or run `xcode-select` from CI. GitHub-hosted macOS jobs in this public
repository's own workflows keep their image's `DEVELOPER_DIR`. In the
monorepo, the `maintain-mac-ci-runners` skill covers the Macs themselves:
installing or upgrading Xcode, its license, and failures of this step.

## Check the complete workflow

Inspect every job, runner matrix, input/default that supplies `runs-on`, and
called reusable workflow. A caller's runner choice cannot override the jobs
inside a reusable workflow. Apply the policy to each relevant deployment branch;
changing `main` does not update `dev` or existing feature branches.

Keep triggers, permissions, secrets, deployment targets, and build commands
unchanged when only migrating runners. Confirm the Blacksmith GitHub app includes
the target repository. Run `actionlint` when available (configure its self-hosted
runner allowlist for Blacksmith), inspect the diff, and verify a resulting job's
runner labels/name after publication. Static validation is not a passing CI run.
