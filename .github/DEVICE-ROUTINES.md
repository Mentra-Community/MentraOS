# Device routine integration

The private [Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing)
owns English routines, deterministic replay, device drivers, recording,
fixture setup/recovery and the device worker queue. Its
[initial PR](https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/1)
preserves the imported source and license. MentraOS contains no executable copy
of that harness; `tools/mentra-e2e/README.md` is a migration pointer.

MentraOS retains:

- App compilation, signing and published artifacts, including the company Mac installer.
- The public build receipt and Core result/claim contracts.
- Request generation, the callback to the private queue, and build links in Slack.
- Authenticated Core result/claim APIs, private evidence storage and the admin viewer.

## Request and dispatch

1. Add `routine:no-glasses`, `routine:day1-ota` or `routine:mentra-call` to a
   same-repository PR targeting `dev`. Multiple labels request separate routines.
2. The [request workflow](workflows/request-e2e-routine.yml) records the current
   PR revisions, exact successful iOS build/publication attempt, receipt, Mac
   archive and OTA manifest in an immutable `request.json` artifact. If these
   are unavailable it records `no-artifact`; no device test has run.
3. Once app publication succeeds, the trusted default-branch
   [dispatch callback](workflows/dispatch-device-routine.yml) validates the
   current PR/label and asks the request workflow on `dev` to select that exact
   source build and publication attempt. The callback for a completed ready
   request revalidates its identity and dispatches its request run/attempt to
   the private workflow on `main`. Bootstrap PR-event requests are excluded
   from automatic dispatch.
4. The private worker independently validates that request, its enrollment,
   selected artifacts and fixture, then reserves execution through the Core
   shared claim API before entering the routine. Duplicate/ambiguous ownership
   does not start another hardware execution.

The callback passes repository, immutable run/attempt identifiers and the
authenticated routine ID. It does
not send shell commands, executable paths or fixture overrides from public PRs.
`E2E_PRIVATE_DISPATCH_TOKEN` is a scoped Actions-write capability for the private
repository, read only by the trusted callback without checking out PR code.
The private worker has separate source-read, claim and evidence-upload capabilities.

The callbacks must reach the repository's default branch and have their scoped
credentials configured before they run. Private workflow activation, host/app
permissions, artifact preparation and fixture qualification are separate gates.
A registered runner or an accepted dispatch is not a completed test. Successful
coordinated dev/staging builds request the no-glasses walkthrough automatically.
The optional [nightly scheduler](workflows/nightly-device-routines.yml) requests
day-one OTA and Mentra Call; see its [activation runbook](NIGHTLY-DEVICE-ROUTINES.md).

## Results and Slack

The existing `#pr-builds` post is published when app/ASG producers finish; it
does not wait for a hardware test. Each requested routine adds requested
coverage, a request-pipeline link and, for a verified Mac archive, **View results**.
If no matching request can be found, the pipeline link opens the workflow page
without claiming a request exists. A label expresses requested coverage, not a pass.

The results link opens dev admin filtered to repository, PR number, full head
SHA, exact Mac archive SHA256, routine and platform. It shows **No results for
this build yet** until a matching export is uploaded. It never substitutes an
older candidate. Later test completion does not edit or republish the Slack post;
the results page is the current source of uploaded outcomes.

The private worker uploads an immutable export with the original result and
recovery verdicts. Upload retries do not repeat device actions. See the public
[claim API](../cloud-v2/packages/core/TEST-RUN-CLAIMS.md) and
[results API](../cloud-v2/packages/core/TEST-RUNS.md). Core stores result metadata
in its configured database and evidence in its configured private artifact
storage; the admin viewer reads that same selected Core deployment. Localhost
records do not move to dev when code is merged.

## Source removal and existing runs

The private import includes the former public harness and its operational
specs/plans. Removing their public working-tree copies does not alter older Git
history, local recordings, firmware, or the frozen checkout used by an active
attempt. Existing attempts and recovery retain their original claims, journals,
source pins and ownership. A new private execution needs a separately qualified
configuration; a repository move does not clear a claim or mark a fixture ready.

The public [setup checks](workflows/e2e-setup-checks.yml) exercise the request,
dispatch, Slack links and shared installer. Harness, native recorder and firmware
adapter tests run in the private repository's hosted offline verification workflow.
