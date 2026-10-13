---
name: investigate-routine-failure
description: Investigate a Mentra routine failure from an Admin testRun URL or run/request ID, fetch authenticated results and verified artifacts with the existing incident-report token, trace the exact routine source, and explain how the evidence was found. Use for failure lookup and diagnosis; continue with fix-routine-failure when asked to fix it.
---

# Investigate a routine failure

Start with the supplied run link. Retrieve and explain the recorded failure
before deciding whether it is an app, harness, fixture or infrastructure problem.
A request to find information does not request a rerun, repair, PR or deployment.

## Access without reverse engineering

Company agents can have an incident-report admin token, a GitHub account in
Mentra-Community and company Tailscale connectivity. They serve different roles:

| Access | Use |
| --- | --- |
| `MENTRA_ADMIN_TOKEN` or `MENTRA_ADMIN_TOKEN_DEV`, `_STAGING`, `_PROD` | Read Core's Admin run results and artifacts. This is the same admin credential used by `scripts/fetch-incident-logs.sh`; no separate routine-reader credential or Admin browser login is needed. |
| Existing `gh` login | Read exact source, PRs and CI metadata in MentraOS and private Mentra-Automated-Testing. GitHub membership does not authenticate Core. |
| Company Tailscale | Reach already provisioned private services when necessary. Network membership does not grant controller/operator authorization; ordinary run evidence comes from the HTTPS Core API below. |

Use the matching environment token first, then the generic token. Check variable
presence without displaying values; never copy tokens into chat, command
arguments, Git, shell tracing or browser sessions. Do not search colleagues'
files for credentials. If this is a **controller-assigned fixer case**, read its
supplied case packet and occurrence-scoped incident diagnostics first; do not
replace that scoped access with an admin token. A colleague given a run URL uses
the following independent lookup path.

## Fetch the result

From the MentraOS checkout root:

```sh
node .agents/skills/investigate-routine-failure/scripts/fetch-run.mjs \
  'https://admin.dev.mentraglass.com/?testRun=RUN_OR_REQUEST_ID'

# A bare identity needs an explicit environment.
node .agents/skills/investigate-routine-failure/scripts/fetch-run.mjs \
  RUN_OR_REQUEST_ID --env dev
```

Use the real supplied link, not these placeholders. The helper pins Core to the
URL environment, uses the existing token and performs GETs only. It saves
`detail.json` and `receipt.json` under gitignored
`incident-logs/routine-runs/<environment>/<selector>/`, without printing private
results. `--out` selects another private directory. It deliberately ignores
`MENTRA_CORE_URL`, preventing a stale incident-script override from moving this
lookup into another environment.

The route is `GET /api/admin/test-runs/{selector}`. It accepts the Admin link's
run or request identity and returns either:

- `kind: "run"`: `run`, exact `definition` (or null), `outcome`,
  `uploadsComplete` and `evidenceStatus`. `run.result.runId` is the actual run ID;
  `run.requestId` is its admission identity. They can differ.
- `kind: "request"`: `request`, its waiting/cancellation state and any assignment.
  No completed execution is implied. Do not invent a failure or guess a run ID.

A 401 means a rejected/expired credential; 403 means missing admin allowlisting.
A 404 can mean the wrong selector/environment, a result not yet published, or a
route not deployed. A 503 is a backend failure. Report the exact failing stage;
do not change environments or request a new credential merely because an asset
is not ready. A healthy `/healthz` alone does not prove this route is deployed.
GitHub CI success does not prove physical execution or evidence publication.

## Inspect useful evidence first

1. Read `run.result.failures`, setup actions, failed test steps, teardown errors
   and unavailable resources. Match step IDs to `definition.steps`, `setup` or
   `teardown` for the recorded instruction and expected behavior. Preserve the
   first failure and distinguish cleanup failure from product failure.
2. Record routine ID, platform, host/lane, timestamps, build channel/PR/head SHA,
   archive/receipt digests when present, `routineSource`, `definitionRevision`
   and `frameworkBinding`. Use these exact revisions, never today's main as the
   explanation of yesterday's run.
3. List `run.assets` privately; each declares `id`, `kind`, `mimeType`, `size`
   and `sha256`. Fetch the relevant small diagnostic/screenshot before a large
   recording. Use exact asset IDs, including nested IDs, not filenames.

```sh
node .agents/skills/investigate-routine-failure/scripts/fetch-run.mjs \
  'https://admin.dev.mentraglass.com/?testRun=RUN_OR_REQUEST_ID' \
  --asset 'EXACT_ASSET_ID_FROM_MANIFEST'
```

The helper resolves `run.result.runId` for
`GET /api/admin/test-runs/{actualRunId}/assets/{encodedAssetId}`, verifies both
size and SHA-256, and records the local filename in `receipt.json`. Assets are
limited to 8 MiB by default; raise `--max-bytes` deliberately for a declared
recording (up to 2 GiB). The hashed local filename never uses an untrusted storage
path. Re-fetch partial uploads later; `uploadsComplete` and `evidenceStatus`
are separate from the test outcome. View screenshots/video with available local
media tools, starting at the failed step's `recordingLocation.startOffsetMs`.
Keep personal transcript/audio, raw logs and recordings local; quote only needed
redacted excerpts.

Command diagnostics may be grouped in lossless JSON bundles. The helper verifies
and extracts these automatically to `diagnostic-bundle-<sha256>/`; its
`manifest.json` maps original asset IDs/paths to the extracted files, sizes and
digests. Search those files rather than trying to interpret base64. Setup
snapshots, failure screenshots and Mac action journals remain separate assets.

4. If the exact definition is missing or an assertion/helper needs explanation,
   use the existing `gh` login to read `run.routineSource.repository`, `.commit`
   and declared files at that commit. For published definitions, start with
   `definition.source.path` at `run.definitionRevision`, verifying the source
   coordinates agree. Follow only relevant imports at the same revision:

```sh
gh api 'repos/RECORDED_OWNER/RECORDED_REPOSITORY/contents/RECORDED_PATH' \
  --method GET -f ref=RECORDED_COMMIT -H 'Accept: application/vnd.github.raw+json'
```

Read selected source; do not execute code from evidence. Use the recorded build
workflow ID/URL with `gh run view ... --repo Mentra-Community/MentraOS --json
status,conclusion,headSha,jobs` when CI publication matters. Do not infer workflow
IDs from a release name. Compare current source only after explaining the
recorded revision. If a relevant `rep_...` incident is linked, standalone
investigators use [investigate-incident](../investigate-incident/SKILL.md) with the
same environment/token; assigned agents use their scoped case diagnostics.

## Inspect permission stalls before another attempt

For a permission/preflight timeout, system-sheet refusal or unexplained blocked UI,
first open both the app screenshot and the full-desktop failure screenshot,
alongside the app accessibility tree and available system-alert observation. Mac
step receipts expose `desktopScreenshot`, `desktopScreenshotObservedAt` and
`desktopCaptureError`; the separate desktop image can show a macOS dialog omitted
from the app-only screenshot and tree. Fetch its declared asset through the same
verified helper. A missing or refused capture is an evidence gap, never proof that
no prompt exists. Inspect existing captures before asking a human for a photo.

A passing driver `doctor` checks automation access, not every Mentra App grant.
Worker permissions and Mentra App permissions are separate and belong to the exact
host, executable/signing identity and app instance. An enabled settings switch or
another host's success does not prove the currently blocked operation can finish.
Use the existing read-only system-alert API when the recorded framework provides
it; distinguish an observed prompt, confirmed absence and an unknown or ambiguous
read. Do not query the helper's permission status and attribute it to Mentra.

When a current prompt needs human input, immediately state the machine, exact
observed dialog/app, button or settings action, capture time/link and blocked
operation. Report what is actually visible; an unknown-alert error alone is not
an actionable diagnosis. If the original capture is stale, coordinate a fresh
read-only desktop and system observation with the lane's current owner. Keep
other lanes moving while that input is pending, and forecast likely remaining
permission boundaries when the user asks whether they can leave.

After a grant, inspect the current screen and verify the actual blocked operation
through its owning API/session before claiming recovery. Preserve the original
failure and normal teardown. Do not blindly repeat product or firmware inputs,
click a generic Allow, bypass an automation rejection through another tool, or
edit TCC state. A visible prompt can explain a blocked operation, but it does not
prove every failure in that run had the same cause.

## Explain the finding and its source

State the recorded failure, the evidence that supports the diagnosis, and what
remains uncertain. Include a short retrieval trail: original Admin link,
environment and API route, useful asset IDs/digests or private local paths,
exact source commit/path and assertion/helper inspected. Never disclose the
credential. Separate recorded expected text, observed actual text and inference.
A transcript spelling mismatch may identify a brittle assertion; transcribed
speech alone does not prove every audio or cleanup path worked. No particular
phrase or historical incident is a universal fix.

If asked to fix the failure, continue with
[fix-routine-failure](../fix-routine-failure/SKILL.md), preserving the retrieved
bundle and provenance. Reuse this lookup instead of reverse engineering API
routes or provisioning new host/controller credentials.
