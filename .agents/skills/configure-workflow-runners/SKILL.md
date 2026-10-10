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
- macOS: use `runs-on: [self-hosted, macOS, ARM64]`, as in
  [the Mentra App iOS build](../../../.github/workflows/mentra-app-ios-build.yml).
  Preserve its concurrency pattern so newer commits can cancel superseded builds
  without cancelling another branch's work. Check the runner's repository access
  and required Xcode/toolchain before relying on it in another repo.

Do not introduce `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, or another
GitHub-hosted Linux label unless the user explicitly requests an exception.
Do not fall back to GitHub-hosted macOS when the office runner is unavailable;
report the missing runner access or toolchain and continue independent work.

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
