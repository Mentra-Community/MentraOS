# Public release artifact storage

Public release downloads are stored in the Cloudflare R2 `artifactscdn` bucket
and served at `https://artifactscdn.mentraglass.com`. GitHub retains release
tags and notes, with a link to each release's download index.

Object paths are `<owner>/<repo>/releases/<tag>/<filename>`. Each release has an
`_assets.json` index containing filenames, sizes, SHA-256 digests and download
URLs. `index.html` renders that manifest as a download page. Conditional index
writes merge concurrent publishers without dropping another job's entries.

## CI configuration

- Repository variable `ARTIFACTS_R2_ACCOUNT_ID`.
- Repository secrets `ARTIFACTS_R2_ACCESS_KEY_ID` and
  `ARTIFACTS_R2_SECRET_ACCESS_KEY`.
- `ARTIFACTS_R2_BUCKET=artifactscdn` in publishing workflows.

These credentials are S3 credentials, not a Cloudflare API bearer token. Workflows
scope them to artifact discovery/publication steps. Public downloads and index
reads do not require credentials. With credentials, discovery also lists committed
R2 objects and repairs missing/stale index entries after verifying their public
bytes. This lets a restarted job reuse an upload that finished before its previous
job stopped, instead of rebuilding conflicting immutable bytes. Object metadata
retains the checksum and mobile build fingerprint needed for recovery. Writes go
directly to the authenticated R2 S3 endpoint; they do not pass through the CDN.

Authenticated tooling installs the lockfile-pinned AWS S3 client in this directory on
first use (`npm ci --ignore-scripts`). It does not install the monorepo or run
application build hooks. Runners need Node 20+ and npm, including after disk-cleanup
steps. Large files use 16 MiB multipart chunks, four concurrent
parts, and up to five SDK attempts per request. Failed multipart uploads are
aborted. Publication verifies the complete file through the public CDN before
adding it to the index.

## Commands

```sh
node .github/scripts/publish-immutable-release-asset.mjs \
  --repository Mentra-Community/MentraOS --release-id RELEASE_ID \
  --name artifact.apk --file /path/to/artifact.apk

node .github/scripts/release-assets.mjs list \
  --repository Mentra-Community/MentraOS --tag RELEASE_TAG

node .github/scripts/release-assets.mjs download \
  --repository Mentra-Community/MentraOS --tag RELEASE_TAG \
  --pattern artifact.apk --dir /tmp/artifacts
```

`release-assets.mjs` also provides `fetch --asset-id`, `remove --asset-id`, and
`url --tag --name --existing true`. Readers merge R2 records with legacy GitHub
attachments and can still download old releases. Existing historical URLs are
preserved when resolving a frozen record. This migration does not delete or
rewrite historical release assets or their signed/provenance records.

Normal release objects are immutable and use conditional creation. A repeated
publication must match the stored size and SHA-256. The `--replace true` option
is restricted to the rolling `pr-builds` and `oem-app-builds` releases, where a
rerun can regenerate the same commit's APK. Those replacements use conditional
atomic writes and revalidation caching instead of deleting a working download.
Rolling PR builds expire after seven days; OEM builds after fourteen days, via
the bucket rules in `lifecycle.json`. Workflow sweeps prune expired index entries
and legacy GitHub attachments. Object expiration uses R2's current modification
time, so a sweep cannot delete a concurrent replacement based on stale metadata.
These lifecycle rules are installed on `artifactscdn`; preserve the bucket's
default multipart-abort rule when applying them to another bucket.

Private production-promotion drafts retain their GitHub storage and access
restrictions. Final `mentra-vX.Y.Z` distribution records use the public CDN;
their publication step runs only after the existing rollout gates. Intermediate
GitHub Actions artifacts remain run-scoped workflow handoffs. Artifacts owned
by external repositories continue to be read from their recorded source URLs.

## Verification

`Release Artifact Storage Checks` uploads synthetic 110 MiB files from both
GitHub-hosted Ubuntu and Blacksmith, verifies the public download digest,
simulates a lost completion response, verifies an idempotent retry, and recovers
a committed file after removing its download index. It
deletes its unique diagnostic objects after the check. It runs on relevant
same-repository pull requests and supports manual dispatch. Unit coverage also
checks index conflicts, immutable-name conflicts, failed verification, private
draft handling and legacy lookup.
