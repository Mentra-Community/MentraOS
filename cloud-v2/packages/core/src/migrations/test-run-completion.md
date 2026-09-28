# Completion-date projection

Normal Core startup creates `test_runs_completed_at`, backfills historical runs, and checks completion **before opening the HTTP listener**. Failure stops startup. The log `test-run completion projection ready` includes `migration: "test-run-completed-at"`, `matchedCount`, `modifiedCount`, and `complete: true`.

Only server-owned `completedAt` and `completionProjectionVersion` change. The original payload, its digest, upload receipts, outcomes and timestamps stay untouched. Valid stored finish strings become BSON dates; missing or malformed values become null and are not presented as finished runs. A second backfill changes zero already-projected rows.

During a rolling deployment, an older Core instance can still write an unprojected row. `/api/admin/test-runs/recent` then returns 503 instead of omitting it. After all older writers retire, restart a current Core instance (its normal startup performs the backfill), or run this narrow retry from the matching repository checkout using the deployment's existing `MONGO_URL` environment:

```sh
bun cloud-v2/packages/core/src/migrations/test-run-completion.migration.ts
```

The retry prints counts only. Verify `complete: true`, then confirm `/recent` returns 200 with the expected historical runs. Dashboard reads never perform migrations. The version-prefixed date/run-ID index serves both the latest-six query and the missing-projection check; known invalid null dates do not enlarge that check.
