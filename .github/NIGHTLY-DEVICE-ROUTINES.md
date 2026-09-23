# Nightly device routine runbook

The [nightly workflow](workflows/nightly-device-routines.yml) requests **day-one
OTA** and **Mentra Call** from the latest verified coordinated **dev** and
**staging** publications. This is separate from the no-glasses walkthrough
requested when each coordinated build finishes. No commits or new builds are
created on either channel by the scheduler.

## Schedule and selection

The workflow targets midnight in `America/Los_Angeles`. Two GitHub schedules,
07:00 and 08:00 UTC, cover daylight saving time. Only the trigger corresponding
to local midnight proceeds, including both DST transition dates. GitHub can
delay scheduled jobs: the intended scheduled time determines the date, with a
six-hour delivery window. A later delivery fails instead of moving a request
silently to a different night.

For each channel, the planner examines the latest 20 successful coordinated
runs, newest first. A green dry run is insufficient: the selected attempt must
have successfully executed **Publish immutable plan, package, and manifest
assets** in the finalize job. It must also have a retained, unambiguous Actions
plan artifact, belong to the channel's current ancestry, and expose matching
immutable release plan, Mac publication receipt, available Mac archive and OTA
manifest. Missing or invalid newer publications can be skipped in favor of an
older verified one within that bounded search. The summary names the exact
release, run and publication attempt selected.

An unavailable channel fails the separate **availability** job. Qualified
requests for the other channel still run. A green scheduler or accepted request
does not imply that a physical routine passed.

## Dispatch and duplicate protection

The scheduler calls the existing **Request device routine** workflow on `dev`
with `request_origin: workflow-dispatch`, a channel, routine, and exact source
run/attempt. That trusted producer revalidates the publication and publishes its
immutable request JSON. The normal callback dispatches the request to the
private worker, which independently validates its own enrollment, request,
fixture and artifacts. The scheduler never sends commands to the Mini.

The scheduler job name binds the local date, channel and routine. Its started
send step is the durable fence before dispatch. An earlier started send, an
ambiguous response, missing/partial history, or a workflow rerun cannot send
that generation again automatically. A job cancelled before its send step
does not consume the generation. History is checked across all attempts.

Do not delete scheduler history or rerun a failed scheduler to repeat a physical
test. Inspect the named job and any acknowledged request workflow first. A lost
response can mean the request was already created. Reconcile the existing
request and private claim before deliberately requesting a new generation
through the normal request workflow or admin UI. Upload recovery remains
separate from repeating device actions.

## Rollout and activation

The scheduler is disabled unless the repository Actions variable
`DEVICE_ROUTINE_NIGHTLY_ENABLED` is exactly `true`. This change does not set it.

Before enabling:

1. Merge the request/callback/nightly workflows into the repository's default
   branch (`dev`), together with public support for `mentra-call`. Merge the
   corresponding private request parser and Call adapter first; an unsupported
   or unenrolled routine must fail without substituting another routine.
2. Enroll the exact private worker revision and each routine's reviewed config.
   Confirm the required physical fixture, permissions, recordings, independent
   Call internet connection, setup/recovery and result publication work. The
   Call recording must include the browser peer. Worker registration alone is
   insufficient.
3. Verify the ordinary no-glasses PR/dev request path and its matching uploaded
   admin result. Staging supports the same path; do not make staging commits
   just to verify activation.
4. Confirm the trusted callback has its scoped `E2E_PRIVATE_DISPATCH_TOKEN` and
   the private worker has its separate source-read, claim and upload secrets.
   Confirm the default branch is `dev`. GitHub schedules only run from the
   default branch.
5. Enable the repository variable, then inspect the next applicable midnight
   run and the four resulting request links. This command is an operator step,
   not part of the workflow:

   ```bash
   gh variable set DEVICE_ROUTINE_NIGHTLY_ENABLED \
     --repo Mentra-Community/MentraOS --body true
   ```

To disable future scheduled requests:

```bash
gh variable set DEVICE_ROUTINE_NIGHTLY_ENABLED \
  --repo Mentra-Community/MentraOS --body false
```

Disabling does not cancel already dispatched requests or interrupt a running
firmware write. Let owned cleanup finish; use the existing worker reconciliation
process if a fixture is retained for recovery. The Mini's queue and leases
govern execution order and fixture ownership; there is no separate polling
daemon or second scheduler service.

## Results and validation

Public Actions stores request JSON and scheduler summaries. The private worker
stores raw recordings locally, uploads its immutable result/evidence to the
configured Core deployment, and exposes the same recorded result through the
admin viewer. The existing `#dev-builds` and `#staging-builds` posts remain build
notifications; their results links do not imply that nightly work has finished.
No credentials, firmware images, recordings or private harness code belong in
this public scheduler.

The offline checks run in **E2E Setup Checks**:

```bash
node --test .github/scripts/nightly-device-routines.test.mjs \
  .github/scripts/request-e2e-routine.test.mjs \
  .github/scripts/coordinated-routine-request.test.mjs \
  .github/scripts/dispatch-device-routine.test.mjs \
  .github/scripts/notify-pr-builds.test.mjs
```

These tests use synthetic GitHub and publication metadata. They do not dispatch
hardware, authenticate to Slack, alter variables, or qualify a physical routine.
