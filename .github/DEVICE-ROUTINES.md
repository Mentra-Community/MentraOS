# Device routine requests

Routine identities, names, supported platforms, resource requirements and execution policies come from Core's enrolled definitions. GitHub workflows maintain no routine registry.

Explicit requests use **Request device routine** on `dev`. Enter an enrolled routine ID and platform, the source channel, exact published build run ID and original publication attempt. PR sources also require the PR number. Core resolves the immutable app archive, freezes the definition and lane inputs, and queues the host request. Repeating the same source/routine/platform or rerunning that request workflow reconciles the same request. GitHub's native **Re-run** on **Routine tests** is a separate linked-verification action.

Add the relevant `routine:<id>` labels to your PR. Each ID selects its declared supported platforms. The App-owned **Routine tests** check is queued against the PR's exact head while app builds or compatible lanes are pending. It freezes one routine revision for the coverage and each platform's exact PR artifact; build callbacks reconcile the same work rather than starting another original.

The GitHub check shows live phase, current test step, observed completed/total test steps and elapsed time. Open **Details** for each routine's lane, current activity, latest result link and authenticated Admin controls. A pending build, unavailable lane or stale observation is not a pass. **No routine tests requested** discloses that no coverage was selected; it does not mean a device test ran.

After a check finishes, GitHub's native **Re-run** verifies the latest unsuccessful selected members, or all members after a complete pass, preserving previous results and exact app/routine selections. To stop active work, open **Details** and use **Cancel routine tests**. Cancellation requests ordinary cleanup and cannot turn the check green; custody must settle before a rerun. A timeout remains visible even while containment continues.

## Check an active request

1. Open the **Routine tests** check on the PR's current head. Confirm the selected routines and follow their phase, current step and completed/total test steps. **No routine tests requested** means there are no selected routines.
2. Open **Details** to inspect each member and its latest observation. A waiting or stale row needs its stated prerequisite; it does not establish that a routine is currently running.
3. To stop active work, use authenticated Admin **Cancel routine tests** once. Follow the original attempt through cancellation and ordinary cleanup; an accepted cancellation is not a completed release.
4. After the original attempt finishes and custody settles, use GitHub's native **Re-run** on that check. Follow the linked attempt and retain the original results. Rerunning an Actions job or submitting another manual request does not perform this check action.

Select coverage and wait for its pending check before enabling auto-merge. Disable auto-merge before changing routine labels on an already-green head; label changes cannot atomically invalidate GitHub's existing commit check. [PR routine check configuration](../cloud-v2/packages/core/docs/pr-routine-checks.md) describes App setup and required-check activation. Require the App-owned **Routine tests** context only after installed-App event and UI verification.

Coordinated publication displays generic available-test and exact-build result links. Publication callbacks reconcile selected PR coverage; publication alone starts no routine. Explicit requests and the independently enabled dev nightly select coverage.

The internal catalog, dispatch and result endpoints require `TEST_RUN_INGEST_TOKEN_DEV`. Execution additionally requires Core's configured host/lane binding and a compatible enrolled definition. A queue acknowledgement is not a passing result.

**Publish routine results** reads Core's frozen framework report. It can run automatically after request/dispatch workflows or manually with the accepted request ID. PR comments bind to the original candidate head and retain one comment per request. Release Slack updates require a retained bot-owned post whose platform archive hash matches the tested build; full desired state is retained before `chat.update`. Missing results, incomplete uploads and evidence failures remain explicit.
