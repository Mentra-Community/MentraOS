# PR routine check configuration

The `Routine tests` check is delivered by the existing `mentra-release-coordinator` GitHub App. Core owns the retained check generation and public delivery intent; ordinary routine jobs, linked reruns, suite records and controller custody own execution. No Actions job stays open while devices run.

Deploy the Core optional `lane.progress` schema before Mentra-Automated-Testing PR 876. The aggregate check and explicit producer mode can deploy independently after their reviews. No framework public API bump is needed for display-only progress.

## Configuration

Keep the existing `TEST_RUN_GITHUB_APP_ID`, `TEST_RUN_GITHUB_APP_PRIVATE_KEY` and `TEST_RUN_GITHUB_INSTALLATION_ID`. Add `TEST_RUN_GITHUB_WEBHOOK_SECRET` through the `cloud-v2/shared` Doppler parent, inherited by `dev_aws` and `staging`, with their native Doppler-to-Porter sync. Do not provision credentials to device workers. `ADMIN_URL` (or `CLOUD_ADMIN_CONSOLE_URL`) determines results links.

Grant the installed App Checks **write** on MentraOS. Keep the existing Actions **write**, Contents **read**, Pull requests **read** source-producer grant and existing reporting permissions. Subscribe to `pull_request` and `check_run`. Configure exactly one authoritative repository webhook consumer:

`https://core.dev.us-west-2.mentraglass.com/api/internal/pr-routine-checks/webhook`

The staging service mounts the same path, but subscribing both environments to the same repository would admit duplicate independent routine jobs. The endpoint authenticates the exact body with GitHub's SHA-256 signature, then verifies installation, repository, check identity and actor write permission.

The app/ASG workflows accept `routine_pr`, `routine_head_sha`, `routine_base`, and Core `routine_operation` correlation only on a trusted `dev` workflow dispatch. They re-read the open same-repository PR, validate the exact head and dev/staging base, check out its synthetic merge, and publish through existing signed artifact/provenance paths. Ordinary PR comments and manual exact-build requests remain available. Automatic PR originals are admitted by the check service; publication callbacks reconcile it rather than creating parallel requests.

## Required-check activation

Verify an installed-App PR check visibly appears on the current head, advances through setup/test/teardown/publication, links to the configured Admin environment, survives a Core restart, and gives correct terminal results. Verify GitHub's native Re-run sends `check_run.rerequested`; the check's Cancel action sends `requested_action` with `cancel`. A cancellation request does not release controller custody. Verify failed-member reruns retain passing members and exact artifacts; a wholly passing rerun executes all members with a new three-hour deadline.

Only after that verification should an operator require the App-owned `Routine tests` context on intended branches. No ruleset changes are part of this implementation. Labels changed after a green check cannot be atomically fenced against GitHub merging; disable auto-merge before changing coverage on an already green head.

## Delivery recovery

`GET /api/admin/test-runs/pr-checks/:gateId` exposes the safe check projection and retained pending/delivered/error status to Admin callers. Delivery errors do not create another routine request. An uncertain initial GitHub create reconciles the App-owned gate receipt on the same head. Each producer has a retained correlation in the native run title. After the 20-second call budget, two complete absence reads at least 30 seconds apart and at least two minutes after the call boundary permit bounded retry. A visible receipt is adopted without repeating the call. GitHub has no atomic create/dispatch idempotency key; a late duplicate is possible, so duplicate exact-identity histories block qualification and require operator reconciliation. Reporting retries remain independent of cancellation/deadline processing. Signed webhook intake persists state before acknowledgment; existing timer reconciliation validates controls and does external work.

A timeout completes the check as `timed_out` and continues ordinary cancellation/containment. Re-run remains blocked until previous custody has settled. Stale controller progress says `Progress unavailable` and freezes its elapsed observation; it does not imply a device stop or release.
