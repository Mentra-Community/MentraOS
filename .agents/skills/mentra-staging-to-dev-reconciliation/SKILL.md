---
name: mentra-staging-to-dev-reconciliation
description: Reconcile staging into dev in MentraOS or the Mentra Bluetooth SDK Starter Kit, preserving staging behavior and advancing obsolete dev prereleases to matching published packages. Use for staging-to-dev reconciliation, not dev-to-staging promotion.
---

# Staging-to-dev reconciliation

Bring staging changes into dev while retaining staging feature behavior and
existing dev-only work. Reconciliation is not an opportunity to redesign the
product or add compatibility layers around an obsolete dev dependency.

## Establish the merge and package inputs

- Resolve the repository and source/destination refs from the request. Use
  `origin/staging` as the source and `origin/dev` as the destination when the user
  has not named alternatives. Clarify a conflicting merge direction before merging.
- Inspect the working directory, branch, status, remotes, and current branch heads.
  Fetch the relevant refs. Create an isolated worktree from the destination when
  the primary checkout is dirty or in use.
- Inspect dependency pins and lockfiles alongside the staging changes. Identify
  APIs that staging requires but the current dev prerelease does not provide.
  Verify the matching dev version in the public package registry; a source change
  or successful build alone does not establish publication.

## Reconcile and validate

1. Merge the source staging ref into the dev worktree. Preserve staging behavior
   and dev-only work while resolving actual conflicts. Use the conflict list and
   package changes to focus investigation.
2. Where staging requires a newer dependency API, advance dev to the matching
   published dev prerelease and regenerate the relevant lockfiles or native
   dependency coordinates. Do not introduce wrappers, optional fields, or
   fallbacks solely to keep an obsolete dev version compiling.
3. If that package is still publishing, wait for registry availability before
   installing it or validating consumers. Continue independent reconciliation
   work while waiting; do not substitute unpublished workspace packages for the
   public dependency validation.
4. Run focused checks required by the changed consumers and repository guidance,
   plus `git diff --check`. Inspect the final diff for unintended product changes
   and verify that the merged result retains the intended behavior of both branches.
5. Follow repository PR and CI requirements within the user's authorized scope.
   This skill does not itself authorize merging a PR or publishing a release.

## Completion evidence

Report the source and destination revisions, dependency version changes and
publication evidence, validation results, and remaining failures or pending work.
Distinguish a prepared reconciliation, a merged PR, and a published release.
Do not call a reconciliation complete while a required consumer check or package
publication is still pending.
