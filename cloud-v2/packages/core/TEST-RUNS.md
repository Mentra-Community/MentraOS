# Private test-run results

This is an immutable result index and media service, not an execution queue. The
Mac worker owns request deduplication, sequential fixture access and recovery.
No schedules, credentials, remote storage or deployments are enabled by this code.

The exact version-one payload is `src/types/test-run.types.ts`. It retains separate
test, teardown, fixture and evidence outcomes, selected-build provenance, firmware
assertions, English chapters and private asset metadata. A missing CI artifact or
unqualified routine uses `outcome: "blocked"`, test/teardown `"not-run"`, fixture
`"unknown"` and a concrete explanation in `notes`; empty chapters, assets and
firmware assertions are valid. Do not fabricate device identities or versions.

## Worker API

Set a separate, random `TEST_RUN_INGEST_TOKEN` of at least 32 characters. The
worker uses `Authorization: Bearer ...`. Comparison uses constant-time digests;
an absent/short server secret disables ingestion. This credential cannot read
admin records or operate any other API.

1. `POST /api/internal/test-runs/` with the complete JSON result, at most 1 MiB.
   The response is `{runId, reportPath, created, payloadSha256, missingAssetIds}`.
   First insertion returns 201. Exact semantic replay returns 200; reuse of the
   same `runId` with changed metadata returns 409. `reportPath` is an authenticated
   admin-relative link such as `/?testRun=run-123`.
2. For each missing asset, `PUT /api/internal/test-runs/:runId/assets/:assetId`
   with raw bytes and the exact declared `Content-Type`. `Content-Length`, when
   present, must match the declared byte count. The service independently checks
   actual streamed length, SHA256 and basic image/video format signatures. The
   response is `{assetId, uploaded:true, created}` with 201 or idempotent 200.
3. Repeat the same metadata POST to reconcile acknowledged/missing assets after
   a network interruption. Retry uploads independently of hardware execution.
   Metadata never changes after ingestion. There is no mutable finalize endpoint.

Every declared asset is required. The server reports evidence `complete` only
when the source declared it complete and all asset records have been committed
after verified upload. Test, teardown and fixture outcomes are never replaced by
upload status. An explicitly incomplete source result stays incomplete even when
all available files are uploaded. Keep local evidence until acknowledgement.

A source `passed` result must also declare passed teardown, complete evidence and
passed status for every included firmware assertion and chapter. Contradictory
source results are rejected. While required uploads are missing, a source-passed
run is presented as `blocked`; its test verdict can still be `passed`. A monotonic
server-owned upload/outcome projection makes list filters follow that displayed
aggregate. Repeating POST or PUT reconciles the projection after interruption;
the immutable source payload and its hash do not change.

Assets are limited to **128 MiB each**, matching the current Core HTTP server's
default request limit. Segment long recordings and point each chapter at the
appropriate video asset; uploading a different representation requires its own
correct metadata before the initial POST. This service does not raise the global
HTTP request limit or change proxy limits. Supported media are MP4, WebM, PNG,
JPEG and WebP, plus JSON/plain-text logs. Uploaded HTML and SVG are rejected.

## Admin API

Existing `adminAuth` protects all three routes using the admin console session:

- `GET /api/admin/test-runs/` returns `{runs, nextCursor}`. Filters: `pr`,
  `channel`, `outcome`, `routineId`, `platform`, `fixtureAlias`, `startedAfter`,
  `startedBefore`; ISO dates; `limit` defaults to 25 and is capped at 100.
  `cursor` is an opaque newest-first continuation. Summaries omit chapters,
  assets, firmware assertions and notes. `repository`, `headSha` (full 40-character
  SHA), and `archiveSha256` (64-character hash) are optional exact provenance
  filters. Build links combine all three with `pr`, `channel=pr`, `routineId`
  and `platform` so results from an older revision or another archive cannot
  appear as coverage for the linked build. Existing PR indexes bound this query.
- `GET /api/admin/test-runs/:runId` returns the complete record, computed
  evidence outcome and `assets[].uploaded`. It never exposes storage keys.
- `GET` or `HEAD /api/admin/test-runs/:runId/assets/:assetId` serves only an
  uploaded asset declared by that run. Single byte ranges, suffix ranges and
  If-Range are supported. Responses include ETag, Content-Length, Accept-Ranges,
  and Content-Range for 206/416. Invalid/multipart ranges return 416.

Media uses authenticated, run-scoped URLs rather than arbitrary storage paths or
public links. Responses use a deny-all sandbox CSP, `nosniff` and private no-store
caching. Filenames are escaped. Admin viewers must not render uploaded HTML in
their origin. The deployment's `/api` proxy must forward Range/If-Range and stream
206 responses unchanged; qualify that proxy with real recordings after deployment.

## Persistence and operational limits

Mongo `test_runs` stores bounded immutable metadata; `test_assets` stores immutable
private object pointers. Startup waits for unique run and run/asset indexes before
accepting requests. `requestId` is indexed, not unique: a single selected build may
produce several routine results or explicitly identified attempts.

Storage uses the existing `CLOUD_STORAGE_PROVIDER` and associated S3/R2/local
configuration. Configure that bucket/location as private. The service sets no
public ACL and publishes no direct storage URLs. Uploads are hashed into private
owned temporary files, then written to unique object keys; concurrent uploads
cannot overwrite a committed object. Known losing copies are deleted. An
ambiguous DB failure may leave an unreferenced private object for later
reconciliation; no automatic retention/deletion policy is enabled.

Media reads are bounded streams: local storage uses `createReadStream` byte
bounds, S3 uses its native ranged stream. HEAD does not read payload bytes.
Existing incident whole-object reads are unchanged. The implementation has been
tested with Hono routes, temporary local files, a loopback S3 protocol fixture and
a separate temporary Mongo 7 database (concurrent immutable run/asset insertion,
replay, conflict, filtering and ranged media). Remote storage deployment and
production proxy qualification remain separate.

Validation: `bun test packages/core/src/services/test-run.service.test.ts` from
`cloud-v2`, plus `tsc -b packages/shared packages/core` with workspace dependencies.
