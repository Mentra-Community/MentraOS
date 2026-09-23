---
status: active
owner: philippe
---

# Coordinated dev/staging device requests

Keep the PR request schema and opt-in unchanged. Add a distinct schema version 2
for existing coordinated releases; a release is never represented as a PR.
The public request workflow runs from `dev`. Manual selection supplies `channel`
(`dev` or `staging`), `source_build_run_id`, `source_publication_attempt`, `routine`
and `request_origin: workflow-dispatch`. Both selectors are mandatory for releases.

The source is `{kind: coordinated-release, channel, buildRunId, publicationAttempt}`.
An exact completed successful `coordinated-release.yml` attempt must belong to the
same repository/channel, and its source must be an ancestor of the current channel.
Historical builds are allowed; advancing a branch does not silently choose a newer
artifact or require the selected source to equal the branch tip.

The producing run's single retained release-plan artifact supplies its immutable
release identity. The corresponding published plan must match source, channel and
container. Reuse `downloadNames` / `validateDownloads` to bind its Apple receipt,
Mac archive, native/JavaScript hashes and OTA manifest. Staging uses the existing
`beta` release identity and staging backend. Recheck source evidence after reads.

`selection` retains `platform`, `receipt`, `archive`, `otaManifest` and unmodified
`app`; it adds `releasePlan`. `selection.build` contains `sourceCommit`,
`releaseIdentity`, `artifactContainerTag`. The producer has `runId`,
`publicationAttempt`, `workflow`, `url`; there is no invented native build attempt.
Request IDs are `routine-{requestRun}-{requestAttempt}-{channel}-{routine}`.
The synthetic shared wire fixture is
`.github/scripts/fixtures/coordinated-routine-request.json`.

After a successful coordinated run, the existing trusted callback requests only
`no-glasses`, with authorization `successful-build`. It passes exact source
selectors to the dev issuer, then forwards only the authenticated request run/attempt
to the existing private queue. The private worker independently authenticates,
prepares, claims, records and publishes the result.

One coordinated source run retains one automatic generation per routine across
all its rerun attempts because the existing release plan/identity is reused.
The authenticated callback send-step history is the durable fence. Concurrency
serializes only callbacks for that source/routine. An entered send with an unknown
acknowledgement requires manual reconciliation; there is no SDK retry. Deleting
history never authorizes another automatic generation. Explicit manual requests
remain separate generations and require deliberate operator action.

The existing dev/staging Slack post includes pending request status, its callback
pipeline and results filtered by repository, exact source SHA, archive SHA256,
routine and platform. It does not wait for a worker or claim that a test ran/passed.
No production source is supported.

## Integration and qualification

Deploy the private schema2/cache/export adapter before enabling coordinated worker
execution. The actual coordinated Mac package uses the legacy `Mentra Release`
layout; the private importer must verify it and use its reviewed host installer,
never execute bundled application scripts. Preserve schema1 PR import behavior.

Core/admin progress must accept this discriminated schema2 source before enabling
`dev,staging` in `TEST_RUN_DISPATCH_CHANNELS`; its dispatch input names already match.
The first coordinated worker routine is `no-glasses`. Coordinated OTA/Call and a
nightly trigger require their own registered adapters and fixture qualifications;
they are not represented as implemented by this change. No staging or hardware
verification was performed for the public source adapter.
