# PR routine requests and private results

The initial pipeline selects current PR artifacts, authenticates an immutable
Actions request on a reviewed local Mac checkout, and publishes terminal results
to the admin dashboard. The generic intake does not dispatch an unregistered
day-one setup adapter. The [registered local worker](DAY1-LOCAL-WORKER.md) is the
explicit entry for an authorized lab qualification attempt; it requires a
reviewed definition and an independently enrolled fixture. A missing artifact or
unregistered adapter produces an explicit blocked record; it never passes a
device test.

## Request a PR build

Apply `routine:day1-ota` to a same-repository PR targeting `dev`. The **Request
device routine** workflow creates a request for the current head/base. Before the
workflow merges, this label is its bootstrap trigger. After merge, operators can
also dispatch it from `dev` with the PR number and `day1-ota` routine.

The resolver selects a successful Mac build/publication and pins its receipt,
archive and OTA manifest. Build and publication attempts are separate. An
in-progress or missing publication produces `no-artifact`. Rerun the request
workflow after the build becomes available; the new attempt is a new immutable
request, not an edit to the old one.

## Build posts in Slack

The existing **#pr-builds** post is published when its app/ASG producers finish,
at the same time as before. It does not wait for a request workflow or a hardware
test. When `routine:day1-ota` is present at publication, the post adds **Requested
tests: Day-one OTA · iOS on Mac**, a **Request pipeline** link, and **View results**
when the Mac archive has been verified. The label expresses requested coverage,
not a running or passed test.
The label creates a request artifact; it does not start the Mac worker or put a
job into an automatic hardware queue. An operator still invokes the local
worker explicitly.

**View results** opens the existing dev admin at
`https://admin.dev.mentraglass.com/`, scoped to the repository, PR, full head SHA,
exact Mac archive SHA256, routine and platform. The same scope survives sign-in
and opening/backing out of a result. Until a matching result is uploaded, it says
**No results for this build yet**. Older PR builds are not substituted. Publish
results to dev Core for this shared link; localhost-only records are not copied
by merging this PR. The dev admin/Core must include the build-filter support.

The pipeline link selects the latest matching PR-event request for this head.
If none can be located, **Request pipeline (workflow)** opens the workflow page;
it does not imply a request exists. This lookup never blocks a ready build post.
There is no Slack bot or post-editing service: later label changes, completed
tests or uploads do not publish/update a build post. Check **View results** for
uploaded outcomes; normal build/publication retries retain their existing
notification reconciliation behavior.

## Inspect and claim on the Mac

Use the reviewed local checkout. Keep the trust policy and worker state outside
Git. The policy must explicitly allow the current PR head, base, reviewed merge
checkout and workflow revision; a label alone cannot authorize the physical host.
For the PR-event bootstrap, GitHub authenticates the head, while the worker also
verifies the merge commit's two parents against the exact allowlisted revisions.

```bash
bun tools/mentra-e2e/ci-worker.ts list
bun tools/mentra-e2e/ci-worker.ts inspect \
  --run RUN_ID --attempt ATTEMPT --trust /private/path/trust.json
bun tools/mentra-e2e/ci-worker.ts consume \
  --run RUN_ID --attempt ATTEMPT --trust /private/path/trust.json \
  --state /private/path/worker-state
```

`--help` documents the trust JSON. Exit 2 means no artifact, 3 means an
unqualified adapter, and 4 means the request was already claimed. Claims are
durable and exclusive. An interrupted claim or lease requires reconciliation;
do not delete it to make an operation run again. Intake executes no incoming
scripts and currently performs no app installation or firmware changes.

## Publish a result independently

The Core endpoint must have a separate `TEST_RUN_INGEST_TOKEN` of at least
32 characters and private storage. Configure the worker's token through a secret
manager. Set `MENTRA_E2E_CORE_URL` and `MENTRA_E2E_ADMIN_URL` to the intended
deployment; localhost HTTP is supported for development. The worker token does
not grant admin browsing or other APIs.

Freeze one terminal result using the Core
[schema and API contract](../../cloud-v2/packages/core/TEST-RUNS.md). For a blocked
intake, `mapCiIntakeResult` in `runner/test-run-record.ts` maps the verified request,
original durable result and claim timestamps without claiming hardware ran.
Keep that metadata unchanged across upload retries.

Create an explicit asset map, with paths relative to the evidence root:

```json
{"schemaVersion":1,"assets":[{"assetId":"video-1","path":"routine-001.mp4"}]}
```

```bash
bun tools/mentra-e2e/publish-test-run.ts \
  --run /private/path/result.json \
  --assets /private/path/assets.json \
  --evidence-root /private/path/evidence \
  --journal /private/path/upload.jsonl
```

Each declared file must match its size/hash, be at most 128 MiB, and remain under
the explicit evidence root without symlinks. Segment long recordings before
freezing metadata. Do not include credentials, calibration backups or arbitrary
raw logs in the asset map. HTML is kept for offline review and is not uploaded
into the authenticated dashboard.

On interruption, rerun only the publisher with the same files/journal. It POSTs
the same metadata to reconcile acknowledged assets, then uploads missing files.
It never changes the test verdict or reclaims/reruns a device request. The server
validates the full schema and prevents an aggregate pass until required evidence
uploads have been verified. Source-incomplete evidence remains incomplete.

Open the printed admin URL and sign in normally. **Test runs** provides filters,
provenance, separate test/teardown/fixture/evidence outcomes, firmware comparisons,
screenshots and English video chapters. The media endpoint supports authenticated
Range requests for seeking. Local `index.html` review remains available through
`view.ts`; uploading a report does not deploy or enable a nightly schedule.

## Qualification still required

The shared lifecycle and firmware assertions have failure/recovery tests, and the
viewer has synthetic playback/seek checks. Complete January BES/MTK/ASG setup,
customer OTA, target verification and safe teardown still need a complete
registered device pass. Use the local entry above to exercise the current PR's
actual build, then verify its real recording in admin. Its admission packet is
authorization for that qualification attempt, not evidence that it passed.
Nightlies, automatic path
selection and PR verification comments remain separate follow-up work in the
[implementation plan](../../notes/superpowers/plans/2026-09-21-day1-ota-and-ci-routines.md).
