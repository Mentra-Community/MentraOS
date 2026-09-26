---
status: active
owner: Philippe
---

# PR UI requests and the next release-source adapter

The public request workflow accepts `day1-ota` and `no-glasses`. The private
worker selects its registered implementation; public inputs never select a
command, source module, host path or recovery procedure. This change prepares
the PR request path. It does not qualify a Mini, run a test or publish a result.

Explicit callers dispatch `.github/workflows/request-e2e-routine.yml` on `dev`
with `pr`, `routine`, and `request_origin: workflow-dispatch`. Optional
`source_build_run_id` and `source_publication_attempt` must appear together and
select that exact publication. Without them, the issuer resolves the latest
eligible publication. Both forms require the current open same-repository PR,
current dev base, matching merge parents and verified Mac receipt/manifest pins.

Automatic callbacks set `request_origin: pr-label` and the exact source selectors.
They require the current `routine:day1-ota` or `routine:no-glasses` label before
selection, after selection, and before private dispatch. Each label has its own
publication send history and concurrency key. A completed request dispatches
only once per callback, regardless of the number of registered routines.
Unknown sends retain the existing manual-reconciliation requirement. Old day-one
send history still fences that routine; deleting history never authorizes replay.

The PR request remains schema version 1 and keeps its original artifact selection.
New requests add `routine.authorization`, either `pr-label` or
`workflow-dispatch`. This field is trusted only inside the authenticated dev
workflow artifact. The private parser must accept `no-glasses`, preserve an
absent legacy field in canonical serialization, and require a label for legacy
queued requests. Explicit trusted dispatch does not require a label, including
when a dashboard chooses an exact source publication. Its request ID remains
`routine-RUN-ATTEMPT-PR-ROUTINE`. Deploy the matching private parser/issuer before
expecting these new public requests to execute.

The existing `#pr-builds` post links each labelled routine to the exact PR head
and Mac archive digest. Request completion does not alter its timing or dedup key.
A request, queued job or successful upload must not be presented as a test pass.

## Coordinated dev/staging follow-up

`coordinated-install-downloads.mjs` already publishes immutable
`mentraos-RELEASE-mac.zip` and an `-apple-downloads.json` receipt last. Reuse
`downloadNames` and `validateDownloads`. The receipt binds source commit, release
identity, native version/build, dev or staging backend, executable/JavaScript
hashes, packaged OTA URL and download hashes/sizes. Staging uses the `beta`
release channel. `reusable-coordinated-mobile.yml` publishes these registered
device downloads; coordinated finalization retains the release plan/manifest.

The next adapter should bind an exact coordinated run/attempt to its immutable
plan, source commit, channel and release identity, then validate the existing
Apple receipt and OTA manifest. Coordinated commits are not PR merge commits.
Add a discriminated release source to public/private contracts rather than
inventing a PR number or weakening PR checks. Only then add each-build hooks,
nightly selection and dashboard channel triggers. None is enabled by this change.
