# Coordinated Documentation and Example App Releases

> Status: proposed; ready for review
> Updated: 2026-08-27
> Parent design: [Coordinated Release System](./coordinated-release-system-proposal.md)

## Purpose

This document defines how Mentra Live documentation and the Bluetooth SDK
Starter Kit join the coordinated release pipeline.

The parent design coordinates MentraOS, Mentra Engine, Bluetooth SDK packages,
and the Mentra Live OTA bundle under one release identity such as
`3.1.0-dev.42`, `3.1.0-beta.57`, or `3.1.0`. This companion design carries that
same identity through the customer-facing documentation and example apps.

The release is not complete merely because packages and mobile binaries were
published. Customers must be able to:

- read documentation that names the exact completed release;
- clone a Starter Kit branch whose dependencies match its release channel;
- download example binaries built from that exact dependency set; and
- trace every link back to immutable source and artifact hashes.

## Current State

### Coordinated MentraOS releases

The MentraOS coordinator currently:

1. allocates a coordinated release identity;
2. publishes the OTA bundle, packages, native SDKs, and MentraOS builds;
3. runs the external Engine consumer gate;
4. writes the finalized release manifest;
5. renders and publishes release-matched dev or beta documentation; and
6. posts the result to the channel's Slack build channel.

The docs renderer updates `release-version` and `release-artifacts-url` in a
temporary copy of `mintlify-docs/`. It deliberately does not edit the source
checkout.

### Documentation channels

| Release channel | Source branch | Published site | Publisher |
| --- | --- | --- | --- |
| Development | `dev` | `https://docs-dev.mentraglass.com` | Coordinated CI to Cloudflare Pages |
| Beta | `staging` | `https://docs-beta.mentraglass.com` | Coordinated CI to Cloudflare Pages |
| Production | `main` | `https://docs.mentraglass.com` | Mintlify Git integration |

Dev and beta sites are release outputs and carry `X-Robots-Tag: noindex`.
Production uses the checked-in stable family base because Mintlify's Git
integration does not run Mentra's release-time template renderer.

### Starter Kit

The Starter Kit currently has one `Example App Builds` workflow. A pull request
or push to `main` builds four artifacts:

- native Android APK;
- native iOS unsigned IPA;
- React Native Android APK; and
- React Native ElevenLabs audio Android APK.

On `main`, that workflow reads each example's dependency version and uploads
the resulting file to a `sdk-<version>` GitHub release. It can currently update
different releases when examples have drifted to different SDK versions. It
also uses asset clobbering and force-moves release tags. Those behaviors do not
provide immutable coordinated-release provenance.

The checked-in examples are presently allowed to carry different SDK versions.
The coordinated model instead requires every maintained example to consume the
same exact release identity.

### Known customer-facing gap

The coordinated docs renderer currently leaves `example-app-version` and
`example-app-url` at checked-in static values. The docs can therefore describe
one coordinated release while linking to an older, independently published
example app. Constructing a Starter Kit URL from the MentraOS release identity
without first building the example would instead create a not-found link.

## Goals

1. Make the Starter Kit a verified consumer of each coordinated release.
2. Keep Starter Kit source, validation builds, tags, and GitHub releases owned
   by the Starter Kit repository while MentraOS owns signed TestFlight upload.
3. Make MentraOS own release identity, ordering, finalization, docs, and the
   channel Slack notification.
4. Publish docs only after the matching example artifacts are publicly
   readable.
5. Put the exact example version and direct artifact links in docs, Slack, and
   the finalized Mentra release manifest.
6. Keep normal Starter Kit feature development possible without duplicating
   release build implementations.
7. Make retries idempotent and make published tags and bytes immutable.
8. Publish the React Native iOS example to the correct TestFlight group from
   the same coordinated Starter Kit release.

## Non-Goals

- MentraOS will not vendor the Starter Kit as a Git submodule.
- MentraOS will not build or host Starter Kit downloadable artifacts; it builds
  only the signed React Native IPA sent to App Store Connect.
- The Starter Kit will not allocate Mentra release identities.
- Pull requests will not publish packages, releases, docs, or TestFlight builds.
- This design does not yet submit the example app to the public App Store.
- The native iOS example remains an unsigned downloadable IPA; TestFlight
  publication applies to the React Native example app.

## Ownership Boundary

### MentraOS coordinator owns

- family base, channel, sequence, and exact release identity;
- package, Maven, and SwiftPM publication;
- immutable OTA manifest and glasses artifact selection;
- the release plan and finalized release manifest;
- dispatching and waiting for the exact Starter Kit build;
- release-matched docs rendering and publication; and
- final Slack status and links.

### Starter Kit owns

- example source and lockfiles;
- PR validation for example changes;
- synchronized `dev`, `staging`, and `main` branches;
- exact dependency updates requested by the coordinator;
- all example builds and build validation;
- merging the exact validated synchronization pull request;
- immutable Starter Kit tags, releases, and artifact checksums;
- the machine-readable result returned to MentraOS.

MentraOS owns the signed React Native iOS archive and TestFlight upload after
accepting that exact Starter Kit result.

This boundary avoids both a Git submodule and copied build logic. MentraOS
consumes a validated result from the repository that owns the source.

## Branch and Channel Model

The Starter Kit mirrors the coordinated product channels:

| Starter Kit branch | Coordinated channel | Expected dependency identity |
| --- | --- | --- |
| `dev` | Development | Latest completed `X.Y.Z-dev.N` synchronized to that branch |
| `staging` | Beta | Latest completed `X.Y.Z-beta.N` synchronized to that branch |
| `main` | Production | Latest completed stable `X.Y.Z` |

Human Starter Kit features land on `dev`. Stabilization fixes may land on
`staging` first and must be merged back into `dev`. Production changes move
through `staging`; automation must not treat `main` as an independent feature
branch.

A bot dependency-sync commit is release output, not a new release request. It
must carry explicit machine-readable metadata so it cannot trigger a dispatch
loop.

If a human Starter Kit change reaches `dev` or `staging` without a concurrent
MentraOS source change, it remains validated source until the next coordinated
Mentra release consumes that branch head. When an example-only change must be
published immediately, an operator manually dispatches the MentraOS coordinated
workflow on the corresponding branch. The Starter Kit does not own release
identity allocation and does not need a reverse cross-repository credential or
callback loop.

## Starter Kit Workflow Design

The Starter Kit uses one reusable build implementation with two entrypoints.

### Pull request validation

`example-validation.yml` runs for pull requests targeting `dev`, `staging`, or
`main`. It calls the reusable build workflow and publishes only ephemeral
GitHub Actions artifacts.

It verifies all maintained examples against their checked-in dependencies. It
does not change versions, commit source, create tags, create releases, or upload
to TestFlight.

### Coordinated example release

`coordinated-example-release.yml` is invoked by an authenticated dispatch from
MentraOS. The coordinator uses GitHub's cross-repository `repository_dispatch`
endpoint, which is covered by the GitHub App's existing Contents write grant;
manual `workflow_dispatch` remains available for operators. Required inputs are:

- `releaseSetId`;
- `releaseIdentity`;
- `familyBaseVersion`;
- `channel`;
- exact package coordinates and expected registry hashes;
- MentraOS source commit and coordinator run URL;
- immutable OTA manifest URL and SHA-256;
- expected Starter Kit channel-branch head SHA; and
- a unique callback correlation identifier.

The workflow:

1. validates the caller, channel, identity, and expected branch head;
2. waits for required npm and SwiftPM packages to be publicly readable without
   waiting for the automatically submitted Sonatype deployment;
3. creates an isolated candidate commit from the expected Starter Kit head;
4. updates every example and lockfile to the exact coordinated versions;
5. embeds the exact release identity and OTA pin where the example runtime
   needs observable release metadata;
6. opens or reuses a version-synchronization pull request against the channel
   branch with the repository-local workflow token;
7. lets the repository's normal pull-request workflow validate the exact
   candidate SHA;
8. merges the pull request itself only after the protected required checks for
   that same head SHA pass;
9. computes the filename, size, media type, and SHA-256 of every artifact;
10. publishes an immutable Starter Kit source tag and uploads the artifacts to
    the base version's release container;
11. publishes `starter-kit-release-<identity>.json` alongside the binaries; and
12. exposes a correlated success or failure result that MentraOS can poll.

The synchronization pull request is the branch compare-and-swap boundary. A
human commit that arrives during the build is never overwritten: a compatible
base advance may merge normally, while a conflict or changed candidate head
fails clearly. The published artifacts always identify the validated candidate
commit, and the next coordinator run starts from the resulting channel head.

### Shared build workflow

Both entrypoints call the same reusable workflow. The coordinated path must not
reimplement the PR build commands in MentraOS or a second Starter Kit script.

The initial artifact set is:

```text
mentra-example-android-<identity>.apk  # optional until Maven Central exposes the identity
mentra-example-ios-<identity>-unsigned.ipa
mentra-example-react-native-<identity>.apk
mentra-example-rn-elevenlabs-audio-<identity>.apk
starter-kit-release-<identity>.json
```

Artifact names include the full semantic release identity. Dates, workflow run
IDs, and unexplained counters do not appear in primary filenames.

### Immutable publication

The current `--clobber` and force-tag behavior is removed for coordinated
releases.

- A tag always points to the exact tested candidate commit.
- An existing asset is accepted on retry only when its bytes and recorded hash
  are identical.
- A differing existing asset, source commit, release plan, or result record
  fails the run.
- A retry reconciles missing outputs under the same release identity; it does
  not allocate another identity.

## Cross-Repository Protocol

MentraOS dispatches with a GitHub App installation token scoped to the two
repositories. A personal access token is not part of the final release
architecture. The App receives only the permissions needed to dispatch the
workflow and read run state. The Starter Kit's own `GITHUB_TOKEN` creates the
candidate commit and synchronization pull request, observes its normal
pull-request validation, merges the exact validated head, and publishes the
tag, release, and assets.

MentraOS stores the numeric App ID in the
`STARTER_KIT_COORDINATOR_APP_ID` repository variable and its private key
in the `STARTER_KIT_COORDINATOR_APP_PRIVATE_KEY` repository secret. Release
jobs mint short-lived installation tokens with
`actions/create-github-app-token`; no generated token is persisted. MentraOS
uses one token for the bounded request phase, waits for the immutable public
result without credentials, and mints a fresh read-only token for final
provenance verification. The App is
installed only on `MentraOS` and `Mentra-Bluetooth-SDK-Starter-Kit` with
Actions read, Checks read, Contents read/write, and Pull requests read/write
permissions. Each job requests only the subset it uses when minting its token.

During bootstrap, the implementation may fall back to the existing scoped SDK
push credential while `STARTER_KIT_COORDINATOR_TOKEN` is being provisioned. The
fallback is explicit migration debt: it is not copied into another secret, and
it is removed after the GitHub App token has completed one dev and one beta
dispatch.

GitHub workflow dispatch does not return synchronous outputs. The protocol is:

1. MentraOS sends the exact release set and correlation identifier.
2. Starter Kit starts the coordinated release and records that correlation in
   its run and result JSON.
3. MentraOS polls for the exact correlated result, with a bounded timeout.
4. MentraOS validates repository, identity, source commits, package versions,
   artifact URLs, and hashes before accepting it.
5. A result from another release, branch, run, or Starter Kit head is rejected.

The result record has at least this shape:

```json
{
  "schemaVersion": 1,
  "releaseSetId": "mentra-3.1.0-beta.57",
  "releaseIdentity": "3.1.0-beta.57",
  "channel": "beta",
  "mentraos": {
    "sourceCommit": "<sha>",
    "coordinatorRunUrl": "<url>"
  },
  "starterKit": {
    "baseCommit": "<sha>",
    "releaseCommit": "<sha>",
    "sourceTag": "sdk-3.1.0-beta.57",
    "artifactContainerTag": "sdk-builds-v3.1.0",
    "releaseUrl": "<url>"
  },
  "packages": {
    "@mentra/bluetooth-sdk": "3.1.0-beta.57",
    "@mentra/engine": "3.1.0-beta.57"
  },
  "artifacts": [
    {
      "name": "mentra-example-react-native-3.1.0-beta.57.apk",
      "url": "<url>",
      "size": 123,
      "sha256": "<hex>",
      "contentType": "application/vnd.android.package-archive"
    }
  ],
  "testflight": null
}
```

The exact schema is versioned and validated in both repositories. Unknown major
schema versions fail closed.

## GitHub Release Containers

Coordinated prereleases do not create one visible GitHub release per commit.
MentraOS keeps its existing base-version container:

```text
mentra-builds-v3.1.0
```

The Starter Kit uses the corresponding base-version container:

```text
sdk-builds-v3.1.0
```

Each asset filename contains the full coordinated identity, so dev and beta
artifacts coexist without overwriting one another. Immutable source tags such
as `sdk-3.1.0-dev.42` and `sdk-3.1.0-beta.57` identify the exact Starter Kit
commit even though their downloadable assets share one visible release page.
The grouped container tag is fixed when the container is created and is never
used as source provenance or force-moved to the newest example commit.

Stable publication uses the stable containers `mentra-v3.1.0` and
`sdk-3.1.0`. It does not rename a prerelease artifact and pretend its embedded
version changed.

## Coordinated Release Ordering

The Starter Kit becomes a required consumer gate before finalization:

```text
release plan and OTA selection
  -> coordinated package and mobile publication
       |-> external Engine consumer verification ----\
       \-> Starter Kit build and publication --------+-> both required
  -> finalized Mentra release manifest
  -> release-matched documentation
  -> channel Slack notification
```

The Starter Kit gate runs after npm and SwiftPM exist, in parallel with the
external Engine consumer gate. Native Android is built when Maven Central
already exposes the exact SDK version; otherwise its APK is omitted from that
release while the other examples remain required. Finalization waits for both
independent gates and the example TestFlight publication.

If the Starter Kit fails, already published package artifacts remain recoverable
under the in-progress release. There is no completed release manifest, docs do
not advance, and Slack reports an incomplete release with links to both runs.
A retry uses the same release identity.

The finalized Mentra release manifest records the Starter Kit result URL,
Starter Kit source commit, exact example artifact URLs, and hashes. Matching npm
tags alone never prove that an example app belongs to the release.

## Documentation Rendering

### Variables

The checked-in Mintlify config retains these structured variables:

- `release-version`;
- `release-artifacts-url`;
- `example-app-version`; and
- `example-app-url`.

For dev and beta, the renderer receives both the immutable Mentra release plan
and the validated Starter Kit result. It sets:

- `release-version` to the exact coordinated identity;
- `release-artifacts-url` to the coordinated Mentra release container;
- `example-app-version` to that same exact identity; and
- `example-app-url` to the published React Native APK URL from the Starter Kit
  result, never to a constructed or guessed URL.

The renderer does not mutate the source checkout. Before deployment it verifies
that:

- all required variables are resolved;
- the example result matches the release set;
- every linked required artifact is publicly readable;
- the exported Mentra Live docs contain the exact release identity; and
- no stale template token or older example version remains.

The custom-domain verification checks the published software-update page and
its example APK link. A docs deployment failure leaves the previous site online
and makes the coordinated release incomplete in Slack, but does not rewrite an
immutable release manifest.

## Changelog Delivery

The canonical customer changelog remains in the MentraOS repository at:

```text
changelogs/<family-base-version>.md
```

It describes the complete release family, including MentraOS, Engine,
Bluetooth SDK, examples, and Mentra Live glasses software. It is not duplicated
or independently edited in the Starter Kit.

Coordinated Bluetooth SDK and Engine packages bundle the generated changelog
catalog. Engine exposes the changelogs crossed between the starting and target
coordinated versions, newest first, and retains them across multi-pass OTA
restarts through the final `complete` or `up_to_date` screen. Legacy numeric ASG
versions use the known target changelog when a valid coordinated starting
version is unavailable.

The React Native example consumes that public Engine OTA state and renders the
provided changelogs on update completion. Its coordinated build verifies the
exact Engine and Bluetooth SDK packages rather than copying markdown into the
example source. Native examples may use the Bluetooth SDK changelog API when
they add equivalent OTA completion presentation.

The finalized release manifest records the changelog base version and content
hash so docs, packages, OTA UI, and example artifacts can be audited as one
release set.

### Production docs

Production remains a Mintlify Git deployment from `main`. The checked-in
variables use the stable family base and stable URLs. The protected production
flow must publish and verify the stable Starter Kit result before production
documentation is declared complete. Moving Mintlify's configured source branch
from `staging` to `main` is an operator action.

The initial cross-repository implementation focuses on `dev` and `staging`,
where CI controls rendering and ordering. Stable Starter Kit synchronization
and the exact Mintlify publication check are added before the first production
release under this model. A temporary not-found production link is not an
accepted steady state.

## Slack Notifications

The existing channel mapping remains:

- `dev` posts to `dev-builds` through `SLACK_WEBHOOK_DEV_BUILDS`;
- `staging` posts to `staging-builds` through the existing staging webhook.

One final coordinated message reports the full release, including:

- release identity and source commit;
- success or failure of OTA, npm, native SDK, MentraOS, Engine consumer,
  Starter Kit, finalization, and docs;
- MentraOS Android artifact;
- React Native example APK direct download;
- Starter Kit release page;
- dev or beta docs URL;
- TestFlight destination and processing state when that phase is enabled; and
- links to the MentraOS and Starter Kit workflow runs on failure.

Slack never guesses an artifact URL. It uses the validated release plan,
MentraOS outputs, and Starter Kit result.

## Concurrency and Retries

MentraOS retains one running release plus the newest pending head per channel.
`dev` and `staging` have distinct concurrency groups and cannot cancel or
replace each other.

Starter Kit coordinated releases serialize by base-version family because dev
and beta share one grouped release container. They do not cancel an already
running publication. Because MentraOS dispatches only an active coordinated
run, superseded pending MentraOS heads do not create Starter Kit releases.

Every boundary uses exact identities and compare-and-swap behavior:

- expected Starter Kit branch head before candidate creation;
- exact package versions and integrity before builds;
- exact candidate source for every artifact;
- immutable tags and asset hashes on retry; and
- exact release-set correlation before MentraOS finalization.

## TestFlight Phase

TestFlight is added only after the cross-repository Android/unsigned-iOS
artifact flow has completed successfully through several coordinated `dev`
releases and at least one `staging` release.

### Approved signing and App Store Connect decisions

- Publish the React Native iOS example under App Store Connect app Apple ID
  `6792839366`.
- Reuse the Apple Distribution certificate and private key already installed on
  the self-hosted Mac Mini runners for MentraOS CI.
- Use the React Native example's own bundle identifier, App ID, entitlements,
  and provisioning profile. The MentraOS provisioning profile is not reused.
- Reuse the existing App Store Connect API key only after confirming it can
  upload builds and manage TestFlight groups for app `6792839366`.
- Send `dev` builds to the example app's `Mentra Dev` internal group.
- Send `staging` builds to the example app's `Mentra Staging` internal group.

The group IDs are resolved and pinned during implementation; automation does
not depend only on mutable display names.

### TestFlight job

MentraOS adds a dedicated reusable React Native example TestFlight workflow to
the coordinated release. It runs on the existing self-hosted Mac Mini after
MentraOS has accepted the Starter Kit result. This keeps signing assets and App
Store Connect credentials in the repository that already owns the Mac runner
setup while still building the exact validated Starter Kit release commit. It
is separate from the Starter Kit native iOS unsigned-IPA job.

The job:

1. generates the React Native iOS project from the tested candidate commit;
2. archives with the example app's provisioning profile and the shared
   distribution identity;
3. exports and validates the signed IPA;
4. uploads it to app `6792839366`;
5. waits for App Store Connect processing;
6. assigns the exact build to the channel's internal TestFlight group; and
7. writes App Store app ID, bundle ID, marketing version, build number, upload
   state, group ID, and processing result into a MentraOS publication record;
   and
8. enriches the Starter Kit evidence in the finalized Mentra release manifest
   with that exact TestFlight record.

Apple requires a numeric native version representation. The intended mapping
is:

- `CFBundleShortVersionString`: plain family base such as `3.1.0`;
- `CFBundleVersion`: one globally increasing numeric build number; and
- in-app diagnostics and TestFlight release notes: full coordinated identity
  such as `3.1.0-dev.42` or `3.1.0-beta.57`.

The numeric build number must remain unique across both dev and staging uploads
for this App Store app. Channel-local counters are not sufficient.

The TestFlight publication is an additional required coordinated-release gate
for dev and staging. Public App Store submission and stable example-app
promotion require a separate explicit decision.

## Security

- Cross-repository automation uses a least-privilege GitHub App installation,
  not a developer PAT.
- Apple private keys, App Store Connect credentials, and provisioning material
  remain only on the authorized Mac runners or in protected GitHub secrets.
- No signing material is uploaded as a workflow artifact.
- The shared Apple Distribution certificate does not imply shared bundle IDs or
  provisioning profiles.
- Release result JSON contains public identifiers and hashes, never credentials.

## Implementation Plan

### Phase 1: Starter Kit workflow cleanup

1. Add `dev` and `staging` branches using the agreed branch protections.
2. Extract the current build jobs into one reusable workflow.
3. Add PR validation for all three target branches.
4. Add the coordinated dispatch entrypoint and exact input validation.
5. Replace force-moving tags and clobbered assets with immutable publication.
6. Add candidate-commit dependency synchronization for every example and
   lockfile.
7. Publish and validate the versioned Starter Kit result JSON.

### Phase 2: MentraOS integration

1. Install GitHub App authentication for cross-repository dispatch.
2. Add the Starter Kit gate after package and external Engine validation.
3. Poll and validate the exact correlated Starter Kit result.
4. Include that result in finalization and `release-manifest.json`.
5. Render example variables from the result.
6. Verify the public APK link before docs deployment.
7. Add Starter Kit status and links to dev and staging Slack messages.
8. Exercise fixes through follow-up PRs to `dev` until multiple coordinated
   releases complete without manual repair.

### Phase 3: Beta and production cutover

1. Verify one complete `staging` release, including `docs-beta` and the
   `staging-builds` Slack message.
2. Add stable Starter Kit synchronization to the protected production flow.
3. Verify stable example assets before considering Mintlify production docs
   complete.
4. Remove obsolete independent Starter Kit publication behavior after all
   channels use the coordinated path.

### Phase 4: React Native example TestFlight

1. Verify the shared distribution identity on each eligible Mac Mini runner.
2. Create or install the example app's provisioning profile with all required
   entitlements.
3. Verify App Store Connect API access to app `6792839366` and pin both internal
   group IDs.
4. Add archive, upload, processing wait, and group assignment.
5. Add TestFlight results to the Mentra final manifest and Slack message.
6. Prove one dev upload and one staging upload on the required gate.

## Acceptance Criteria

- Every completed dev or beta Mentra release has a matching immutable Starter
  Kit result.
- All maintained examples consume the exact coordinated package identity.
- Starter Kit channel branches point to the latest successfully tested sync,
  without overwriting human changes.
- Pull requests validate examples but never publish.
- Coordinated retries never force-move a tag or replace different bytes.
- `release-manifest.json` records the Starter Kit source and artifact hashes.
- Dev and beta software-update docs display the exact coordinated identity and
  link to a publicly readable matching React Native APK.
- Slack reports the same identity, docs URL, and example artifact URL.
- A Starter Kit failure prevents finalization and docs advancement.
- Dev and staging releases cannot cancel or replace one another.
- After Phase 4, React Native iOS builds reach the correct example-app
  TestFlight group using the shared distribution certificate and the example
  app's own provisioning profile.

## Remaining Implementation Checks

The following values are intentionally verified during implementation rather
than assumed in this design:

- the GitHub App installation and exact repository permissions;
- Starter Kit `dev` and `staging` branch protection rules;
- the Maven and SwiftPM public-readiness probes used before example builds;
- the example app's registered bundle ID matching
  `com.mentra.bluetoothsdk.example.reactnative`;
- the provisioning profile and entitlements available on the Mac runners;
- App Store Connect API-key access to app `6792839366`;
- the immutable IDs for the example app's `Mentra Dev` and `Mentra Staging`
  groups; and
- the globally monotonic TestFlight build-number source.
