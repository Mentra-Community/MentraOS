# Testing detail cutover

This finite operator tool moves immutable testing detail to the existing private
storage provider. Runtime lists retain Mongo projections; detail APIs use the
verified object pointer. It does not delete recordings, screenshots or logs.

Run with the existing Core environment injected, never a URI on the command line:

```
bun packages/core/src/migrations/testing-storage/cli.ts plan /private/path/operation
bun packages/core/src/migrations/testing-storage/cli.ts export /private/path/operation
bun packages/core/src/migrations/testing-storage/cli.ts verify /private/path/operation
bun packages/core/src/migrations/testing-storage/cli.ts apply /private/path/operation --approved-scope-sha256=<digest> --frozen
bun packages/core/src/migrations/testing-storage/cli.ts verify-applied /private/path/operation
```

Before `plan`, take a full protected database backup and prove it restores locally.
Preparation only reads Mongo; `export` writes immutable objects and protected
per-record receipts. `apply` requires the exact verified removal scope digest and
a caller-confirmed write freeze. No automatic startup migration or old completed
runtime reader exists. Keep admission closed until the post-drain coverage check
and every migrated reader pass. A changed record is a separately verified and
approved delta, not a reason to ignore it and reopen.

Use a dedicated operation directory outside Git with mode 0700. Its scope and
source BSON records are sensitive. An interrupted operation resumes from verified
receipts. Preserve the full backup, source records and objects until rollback is
no longer needed. Restore only affected records before reopening admission;
never restore the entire live database over unrelated application changes.
