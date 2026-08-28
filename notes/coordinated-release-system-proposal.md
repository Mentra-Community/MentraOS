# Coordinated Release System

> Status: implemented; coordinated channel documentation added
> Updated: 2026-08-27

## Goal

Release MentraOS, Mentra Engine, and the Bluetooth SDK as one traceable product
family. Every build in a family must identify the exact source, package graph,
mobile binaries, and Mentra Live OTA bundle that were tested together.

The system should require one family base-version decision per release train,
not separate product versions or manual package-version edits on every commit.

## Products

The coordinated system has three products:

1. **MentraOS**: the iOS and Android application.
2. **Mentra Engine**: the independently consumable `@mentra/engine` package.
3. **Bluetooth SDK**: npm, Maven, and SwiftPM distributions of the Mentra Live
   SDK.

MentraOS builds workspace source directly into its mobile artifacts. It does
not need registry releases of Engine, Bluetooth SDK, Crust, or other workspace
packages in order to build.

The independently published Engine does need its runtime dependency closure to
be available to external consumers. The release coordinator must therefore
publish the explicitly allowed first-party packages needed by Engine before it
publishes Engine itself.

Engine depends deeply on Bluetooth SDK. The supported public integration is the
identity-preserving `@mentra/engine/bluetooth-sdk` package export; the published
Engine has no `@mentra/engine/internal` subpath. Therefore
`@mentra/engine@3.1.0-beta.57` must expose and resolve
`@mentra/bluetooth-sdk@3.1.0-beta.57`. Allowing those versions to drift would
make Engine installation and native resolution ambiguous to consumers.

## Hard Decisions

1. The release family owns one plain future-production base version in source.
   MentraOS, Engine, Bluetooth SDK, and every coordinated public package use the
   same base. The current proposed train is `3.1.0`.
2. CI derives prerelease versions. Developers do not edit package versions for
   ordinary `dev` or `staging` commits.
3. One coordinated run allocates one release identity, such as
   `3.1.0-dev.184` or `3.1.0-beta.57`. Public package versions and diagnostics
   use it directly; native store fields use their platform-valid representation
   of the same release.
4. One release set references one immutable Mentra Live OTA manifest and one
   exact ASG, MTK, and BES artifact set. A release set may reuse an already
   validated ASG APK when its complete ASG build-input fingerprint is unchanged.
5. MentraOS consumes local workspaces. Engine's standalone distribution uses an
   explicit, exact, published dependency closure.
6. Engine owns its Engine-specific contract and re-exports exactly the same
   family version of Bluetooth SDK at `@mentra/engine/bluetooth-sdk`. It must not
   expose accidental Bluetooth SDK `/internal` imports as public API.
7. Automatic OTA is enabled by an explicit embedded immutable manifest pin, not
   by a package version, a generic CI flag, or the connected glasses version.
   Source-built Expo hosts keep the current explicit
   `EXPO_PUBLIC_ASG_OTA_VERSION_URL` opt-in; an unset source build has OTA
   disabled.
8. Production promotes a completed staging release set. It does not rebuild the
   ASG, OTA bundle, IPA, or Android store artifact.
9. `release-plan.json` records immutable release intent before publication.
   `release-manifest.json` records the finalized bill of materials, artifact
   hashes, registry coordinates, and provenance after publication. Neither is a
   hand-edited version file.
10. Each prerelease channel keeps one running publication plus its latest
    pending branch head. Running publication is never canceled, and `dev` and
    `staging` cannot replace one another's pending work.
11. Reusable ASG APK/provenance pairs live in the shared
    `mentra-coordinated-asg` release. Every coordinated prerelease owns its OTA
    manifest, ASG selection, and portable bundle.
12. Production validates the selected beta before protected approval. Stable
    packages and the external Engine consumer must succeed before either mobile
    store is changed.
13. Dev and beta documentation is a post-finalization release output. The docs
    show the exact coordinated release identity and are never published ahead
    of the completed release manifest.
14. Starter Kit examples are built and published by the Starter Kit repository,
    but their validated result is a required consumer gate before coordinated
    finalization. Documentation never guesses or constructs an example URL.

## Phase 0: Fix the Engine Boundary Now

This is an initial requirement, not future cleanup.

### Public API ownership and SDK boundary

Before publishing through the coordinated pipeline:

- Add `@mentra/engine/bluetooth-sdk` as a supported Engine package subpath.
- Implement it as a thin, identity-preserving re-export of the public
  `@mentra/bluetooth-sdk` root entrypoint: no wrapper, copied singleton, or
  alternate state.
- Mirror the complete supported Bluetooth SDK surface through
  `@mentra/engine/bluetooth-sdk`, `@mentra/engine/bluetooth-sdk/react`,
  `@mentra/engine/bluetooth-sdk/types`,
  `@mentra/engine/bluetooth-sdk/photo-receiver`, and
  `@mentra/engine/bluetooth-sdk/debug`.
- Source all re-exported SDK functionality and SDK-owned types from public
  Bluetooth SDK entrypoints, never from `@mentra/bluetooth-sdk/internal`.
- Replace Engine-specific root exports currently sourced from
  `@mentra/bluetooth-sdk/internal` with Engine-owned models where they represent
  Engine concepts.
- Translate Bluetooth SDK events and values into Engine-owned models at the
  Engine boundary when Engine changes their semantics or lifecycle.
- Ensure public Engine method signatures, callbacks, stores, and generated
  declarations refer only to Engine public types, intentionally exposed
  Bluetooth SDK public types, or deliberately public third-party types.
- Treat every exported package subpath as public. Remove
  `@mentra/engine/internal` from the published Engine export map before the
  `3.1.0` family is released. Move MentraOS-only compatibility access into a
  private, non-published workspace package rather than relying on a publicly
  addressable subpath named `internal`.
- Add an API-surface test that fails when the public declaration output contains
  `@mentra/bluetooth-sdk/internal` or an undeclared workspace source path.

Engine implementation files may use the Bluetooth SDK's internal entrypoint
behind this boundary while the modules live in one repository. That is an
implementation dependency, not an implicit Engine consumer contract. It must be
pinned to the exact same Engine release version and must never leak through
declarations. The supported SDK contract is the explicit public facade.

The intended source entrypoint is equivalent to:

```ts
export {default} from "@mentra/bluetooth-sdk"
export * from "@mentra/bluetooth-sdk"
```

The Engine package export map provides matching `react-native`, `types`, and
default conditions for each `./bluetooth-sdk` subpath. The SDK `internal`
entrypoint is never re-exported publicly.

### Private MentraOS host bridge

The release cutover deliberately retains `@mentra/engine-host-internal` as a
private `0.0.0` workspace package. It is not published, is not part of the
public release family, and is forbidden in the external OEM fixture. It lets
MentraOS keep using existing raw stores, service singletons, composition hooks,
and devtools while the public Engine package exposes only typed commands, read
models, hooks, pure helpers, and supported subpaths.

This is accepted migration debt for the current release, not a second Engine
API. Its source-relative re-export of Engine internals may change without
compatibility guarantees. New MentraOS product logic should use or extend the
appropriate `engine.*` facade instead of expanding the bridge. Existing imports
are measured by the mobile runtime boundary check and should be burned down by
domain; a small private composition/devtools boundary may remain if it has a
durable host-only responsibility.

### Generated output

`build/` is generated package output, not architectural source:

- React Native resolves Engine's `react-native` exports to `src/*.ts`.
- TypeScript reads generated declarations from `build/*.d.ts`.
- Default non-React-Native consumers may load generated `build/*.js`.
- Engine source must never import from its own `build/` directory.
- `build/` is regenerated in a clean checkout before packing and is inspected
  as release output, not trusted from a developer checkout.

The directory could later be renamed `dist/`, but that name does not change the
dependency model and is not required for this release redesign.

## Release Family

The release family is an explicit allowlist with explicit dependency edges. It
must not be inferred from a `mobile/modules/*` or `cloud-v2/packages/*` glob.

Initial family:

- MentraOS for iOS and Android.
- `@mentra/engine`.
- `@mentra/bluetooth-sdk` for npm, Maven, and SwiftPM.
- `@mentra/crust`.
- `@mentra/jspolyfill`.
- `@mentra/cloud-client`.
- `@mentra/cloud-protocol`.
- `@mentra/miniapp`.

Miniapp owns the public hardware-requirement contract used by miniapp manifests.
The legacy cloud `@mentra/types` package and the cloud app SDK remain outside
this three-product release family.

The exact list must be validated against Engine's runtime imports during Phase 0. A new package joins only through a reviewed manifest entry that specifies
its base-version source, publication targets, and dependency edges. Private
cloud services and unrelated tools remain outside the family.

## Dependency Policy

For the first implementation, do not introduce a JavaScript bundling step for
Engine's first-party dependencies. Publish its allowlisted dependency closure.
This gives all packages one consistent model and avoids pretending native Expo
modules can be hidden inside an Engine JavaScript tarball.

- Bluetooth SDK and Crust remain separately published native packages.
- Pure TypeScript first-party packages also remain separately published in the
  initial system.
- Every first-party package imported or re-exported by Engine is an exact regular
  `dependency` at the shared coordinated version, not a peer dependency, `*`, or
  a broad prerelease range.
- If Engine is `3.1.0-beta.57`, its Bluetooth SDK dependency is exactly
  `3.1.0-beta.57`. CI fails if another SDK version is resolved anywhere in the
  external fixture application's JavaScript or native dependency graphs.
- React, React Native, Expo, and host-owned singleton/framework packages remain
  peer dependencies with documented supported ranges.
- CI inspects npm, Metro, Expo Autolinking, Gradle, and CocoaPods/SwiftPM
  resolution and fails if more than one Bluetooth SDK or Crust native module is
  present.
- A clean external fixture app installs only the documented Engine integration
  dependencies and verifies native autolinking, iOS resolution, Android
  resolution, Metro resolution, and TypeScript declarations.

This is more packages to publish, but CI owns the work. It avoids a second
packaging architecture while the public boundary is still being stabilized.

## Version Model

The release family uses fixed, lockstep versioning. Each product or public
package stores the same plain stable base version in its own `package.json`:

```text
mentraos                 3.1.0
@mentra/engine           3.1.0
@mentra/bluetooth-sdk    3.1.0
@mentra/crust            3.1.0
@mentra/jspolyfill       3.1.0
@mentra/cloud-client     3.1.0
@mentra/cloud-protocol   3.1.0
@mentra/miniapp          3.1.0
```

The repository-root `package.json#version` is the canonical family base. The
root package is private and represents the release family rather than one of the
three products. Every coordinated package's own `package.json#version` is a
required, validated mirror of that value, not an independent version authority.
MentraOS should migrate its version authority from duplicated environment
configuration to this family version. Build scripts may inject a derived runtime
value, but they must derive it from the root `package.json`.

This intentionally makes SemVer describe the compatibility and release state of
the Mentra product family, not the independent amount of change in each package.
An unchanged package receives the new family version when the family is
released. If a package later needs an independent cadence, removing it from the
fixed family is a deliberate release-model change rather than a one-off version
exception.

At release-train creation, the family base must still be unused for every
product and package target. If `3.1.0` has shipped for any coordinated package,
the entire next train moves to a new shared base. There are no package-specific
base exceptions inside a train.

The coordinator allocates one monotonically increasing sequence and derives:

```text
dev:      3.1.0-dev.<sequence>
staging:  3.1.0-beta.<sequence>
main:     3.1.0
```

Example coordinated staging set:

```text
MentraOS                 3.1.0-beta.57
@mentra/engine           3.1.0-beta.57
@mentra/bluetooth-sdk    3.1.0-beta.57
@mentra/crust            3.1.0-beta.57
```

The family base and release identity are shared. Their encoding is
ecosystem-specific:

| Surface                                 | `3.1.0-beta.57` release set            |
| --------------------------------------- | -------------------------------------- |
| npm, Maven, SwiftPM packages            | `3.1.0-beta.57`                        |
| MentraOS iOS marketing version          | `3.1.0`                                |
| MentraOS iOS build number               | Monotonically increasing numeric value |
| MentraOS Android `versionName`          | `3.1.0`                                |
| MentraOS Android `versionCode`          | Monotonically increasing integer       |
| In-app diagnostics and release metadata | `3.1.0-beta.57`                        |

A release set may not combine different family bases or release identities.

Use the coordinator workflow's `github.run_number` initially. Pass it unchanged
to all reusable workflows. A rerun keeps the sequence; `run_attempt` never
enters a version. Replacing or renaming the coordinator in a way that resets the
sequence requires an explicit migration and registry collision checks.

## Release Records

The coordinator generates two records with different lifecycles.

### Release plan

`release-plan.json` is created before publication and is immutable. Its minimum
content is:

```json
{
  "releaseSetId": "mentra-3.1.0-beta.57",
  "familyBaseVersion": "3.1.0",
  "releaseIdentity": "3.1.0-beta.57",
  "channel": "beta",
  "sequence": 57,
  "sourceCommit": "<full git sha>",
  "products": {
    "mentraos": "3.1.0-beta.57",
    "@mentra/engine": "3.1.0-beta.57",
    "@mentra/bluetooth-sdk": "3.1.0-beta.57",
    "@mentra/crust": "3.1.0-beta.57"
  },
  "dependencies": {},
  "otaInputs": {}
}
```

It declares intended versions, dependency edges, source, OTA inputs, native
build numbers, publication targets, and artifact names. A retry consumes the
same plan and never edits or reallocates it.

### Release manifest

`release-manifest.json` is created only after every required target has been
built, validated, and published. It contains the release-plan digest plus every
final package coordinate, artifact URL, content hash, attestation, native build
number, source commit, workflow run, OTA manifest identity, and publication
result.

The release begins as a draft. After OTA selection, its immutable OTA manifest,
ASG selection, and portable bundle are attached and the release becomes a public
prerelease explicitly marked as publication in progress. Finalization adds the
human-named package artifacts and completed release manifest, then replaces the
in-progress description. A partial release may expose usable OTA assets and
recoverable registry state, but it never claims to have a completed release
manifest.

Sources of truth are intentionally narrow:

- Repository-root `package.json#version`: the one future stable family base.
- Coordinated package manifests: validated mirrors of that shared family base.
- Coordinator inputs: branch/channel and allocated sequence.
- `firmware_live.json`: promoted MTK and BES inputs when the set is assembled.
- Generated `release-plan.json`: immutable intended release.
- Generated `release-manifest.json`: exact completed result.

## OTA Bundle

One reusable workflow builds or selects the ASG artifact and creates one
immutable OTA manifest for the release set. The manifest pins exact ASG, MTK,
and BES identities and hashes.

The workflow preserves the current ASG reuse behavior:

1. Compute a fingerprint over all effective ASG build inputs, including source,
   build configuration, dependency and submodule revisions, toolchain inputs,
   and injected build metadata.
2. If a previously published ASG artifact has the same fingerprint, valid
   provenance, expected signing identity, and matching recorded hash, reuse that
   exact immutable APK.
3. If the fingerprint changed or prior validation cannot be reproduced, build,
   validate, attest, and publish a new ASG artifact exactly once.
4. Record the selected artifact, its fingerprint, hash, provenance, and any
   originating release set in the new release manifest.

Reuse never means renaming, repackaging, or overwriting an ASG artifact. MTK or
BES promotion and unrelated MentraOS, Engine, documentation, or package changes
can therefore produce a new OTA manifest and release set while continuing to
reference the same ASG APK.

Release-specific asset ownership is bounded by identity. A shared
`mentra-coordinated-asg` release contains only reusable ASG APK/provenance
pairs. Every coordinated `mentra-vX.Y.Z-<channel>.N` release owns its OTA
manifest, ASG selection, and portable bundle. Release-specific OTA assets never
accumulate in one global GitHub release.

The resulting URL is passed as an explicit output to all product builds:

- MentraOS embeds it directly in the iOS and Android JavaScript bundles.
- Bluetooth SDK npm, Maven, and SwiftPM artifacts embed the same URL through
  their platform-specific generated release metadata.
- Engine embeds the same literal pin in generated release metadata inside its
  npm tarball and depends on the exact Bluetooth SDK from the set. It does not
  independently derive a URL from its package version.

### Engine release pin

Current `dev` Engine packages are not independently pinned: Engine first reads
the consuming app's `EXPO_PUBLIC_ASG_OTA_VERSION_URL`, then asks Bluetooth SDK
to derive a pin from the SDK version, and can fall through to glasses-reported
or mutable production URLs. The coordinated release removes that ambiguity.

The Engine package job must:

1. Receive the immutable OTA manifest URL and SHA-256 directly from the
   coordinator output.
2. Generate an Engine source module in the isolated release checkout containing
   at least the family version, release-set identity, source commit, manifest
   URL, and manifest hash.
3. Build and pack both the React Native source condition and generated default
   JavaScript/declarations from that same metadata.
4. Inspect the completed npm tarball and fail unless its literal URL and hash
   exactly match the coordinator output and contain no unresolved placeholder.
5. Compare the Engine pin with the pin embedded in the exact coordinated
   Bluetooth SDK package and fail publication on any mismatch.

The metadata must be a generated literal included in the tarball, not a
`process.env` lookup deferred until the customer's Metro build. Source checkouts
carry an unpinned development default; only release packaging writes the release
pin into an isolated checkout.

Engine OTA resolution for modern glasses is:

```text
active developer override
  -> explicit host-app release pin
  -> embedded Engine release pin
  -> OTA disabled as an unpinned build
```

Engine does not silently use the SDK pin as a fallback. It verifies that the SDK
pin matches its own embedded pin. Calls made directly through
`@mentra/engine/bluetooth-sdk` use the SDK's matching embedded pin.

Runtime policy for modern glasses is:

```text
explicit developer override, when developer mode is active
  -> embedded host release pin
  -> embedded product release pin (Engine or standalone SDK)
  -> OTA disabled as an unpinned build
```

There is no mutable production fallback and no SDK-version-to-URL construction
after the migration. Pre-39 glasses retain their explicit legacy protocol path
because they cannot honor a phone-provided modern manifest URL.

The selected URL is latched for an OTA session so check, start, reconnect,
resume, retry, and completion all use the same manifest.

### Source-built developer hosts

Source-built hosts do not receive an automatic release-channel manifest:

- Expo and React Native hosts enable OTA explicitly with the existing
  `EXPO_PUBLIC_ASG_OTA_VERSION_URL` build variable.
- Native Android and iOS hosts use the existing debug `setOtaVersionUrl`
  configuration surface.
- Missing, blank, malformed, or unreachable developer pins fail closed and do
  not fall back to a package-derived or mutable production URL.
- The active developer pin is visible in diagnostics so a locally built app can
  always explain which OTA bundle it is using.

Release CI supplies and verifies its own immutable release pin. Developer
configuration is an explicit local opt-in and never becomes a default embedded
in source-built SDK artifacts.

## Branches and Triggers

All three products use `dev` -> `staging` -> `main` as source lines.

- Pull requests run validation and package dry-runs only. They never publish.
- A selected `dev` head creates a coordinated `dev.N` release set.
- A selected `staging` head creates a coordinated `beta.N` release set.
- Production is a protected manual workflow selecting a completed staging set
  whose source is contained in `main`.
- Do not use separate product tags as release decisions. npm, Maven, and SwiftPM
  package tags are generated outputs of the coordinated production release.

Bug fixes may land on `staging` first and must be merged back into `dev`.
Features land on `dev` and move to `staging` only when selected for the release
candidate. Do not merge all of `dev` into `staging` merely to produce a build.

The coordinator has no path filters: every selected branch release gets an
auditable identity. Every public product and package in that set is published
under the shared version, even when its source is unchanged. Jobs may reuse
verified intermediate build outputs, but they may not substitute a package from
a different family version.

Each prerelease channel keeps at most one running publication plus the latest
pending branch head. A newer push on the same branch replaces only that branch's
older pending run; it never cancels a running publication. `dev` and `staging`
use distinct concurrency groups, so neither channel can replace the other's
pending release. This intentionally coalesces commit bursts instead of
publishing every intermediate commit. Mutable channel heads move only toward a
greater sequence.

The coordinator is the only automatic publisher for MentraOS, Mentra Engine,
Bluetooth SDK, and the Engine dependency closure. The superseded product,
staging-build, and SDK release workflows are removed at cutover. Independent
developer tools such as `@mentra/miniapp-cli`, `create-mentra-miniapp`,
`@mentra/auth`, and `@mentra/cli` keep their own release workflow and versions;
they are not silently pulled into the coordinated family. Their workflow is
manually dispatched only after the coordinated Miniapp package for that channel
is publicly readable, so scaffolder publication cannot race its template pin.

## Publication Order

After the OTA bundle and version map exist:

1. One npm lane publishes the complete public package closure in the explicit
   release-family dependency order, ending with Engine.
2. Native Bluetooth SDK publication and MentraOS mobile builds run in parallel
   with that npm lane; they do not depend on registry packages to build.
3. A clean external OEM fixture starts as soon as npm publication completes. It
   installs only the exact public Engine package plus host-owned dependencies.
   It verifies the registry graph, TypeScript, Metro, Expo autolinking, Android,
   and iOS.
4. The Starter Kit workflow is dispatched after the OTA release exists and
   checks npm and SwiftPM readiness itself while those publication lanes are
   still running. It synchronizes every maintained example only after the exact
   dependencies are readable. Native Android is built when Maven Central
   already exposes that identity; otherwise that optional artifact is skipped
   without holding up the release.
5. Finalization writes the completed release manifest only after every product
   lane, the external consumer gate, and the Starter Kit gate succeed.
6. Dev and beta documentation publishes after finalization from the exact
   source commit, release plan, and validated Starter Kit result.

Independent jobs may run in parallel when the dependency graph permits it. A
consumer package cannot publish until its referenced versions are publicly
readable and their hashes/metadata match the release set.

Production deliberately narrows the graph before changing either store:

1. Validate the selected completed beta, its source ancestry, and every recorded
   artifact.
2. Request protected approval for that verified candidate.
3. Publish stable npm, Maven, and SwiftPM packages.
4. Build the clean external Engine consumer from those public packages.
5. Promote the exact beta mobile binaries to production.
6. Finalize public package pointers and the stable release manifest.

Google Play production promotion and App Store submission therefore cannot run
while package publication or the external consumer proof is still unresolved.

Retries reconcile the same release set. They publish missing targets or verify
existing identical targets. They never allocate a new suffix and never replace
different bytes at an existing version.

## MentraOS Distribution

MentraOS builds local workspace sources, so its release does not wait for npm or
Maven to compile. It still records the exact workspace package versions and
source hashes in its BOM.

For iOS:

- `dev` builds go to the existing `Mentra Dev` TestFlight group.
- `staging` builds go to the existing `Mentra Staging` TestFlight group.
- Production promotes the exact tested staging binary through App Store
  Connect.

For Android, use equivalent internal/dev and beta tracks before production
promotion.

Release channel and backend environment are separate concepts:

- `dev` artifacts use development services and are not production candidates.
- `beta` artifacts built from `staging` use production services. They are the
  exact signed candidates evaluated in TestFlight and the Play beta track.
- Production promotes those same IPA and AAB bytes. It does not rewrite cloud
  configuration, rebuild, or re-sign them.

This matches the immutable promotion model of App Store Connect and Google
Play. A build that targets staging services is useful for diagnostics, but it
must be a separately identified, non-promotable artifact. CI rejects a beta
release whose mobile backend is not `prod`.

Native store marketing versions remain the plain family base, such as `3.1.0`,
so the exact staging binary can be promoted without rebuilding and
without retaining `-beta` in the production app version. TestFlight notes,
diagnostics, GitHub artifacts, and release metadata expose the full coordinated
identity such as `3.1.0-beta.57`.

### App Store Connect promotion

Adding an iOS build to a TestFlight group is not a separate binary publication
and does not itself promote the build to the App Store. App Store Connect keeps
one uploaded build, identified by bundle ID, plain marketing version, and
numeric build number. TestFlight groups only control who may test that build.
Production later attaches the same build to the corresponding App Store
version.

For example, coordinated beta `3.1.0-beta.57` is observable under that full
identity in Mentra release records, but its native App Store coordinates are
version `3.1.0` and the release plan's numeric build number. The staging
workflow:

1. uploads that exact signed IPA to App Store Connect;
2. waits for Apple to finish processing the build; and
3. assigns it to the existing `Mentra Staging` TestFlight group.

After testing, an operator starts the protected production workflow with the
completed beta identity. The workflow first verifies the selected beta and its
artifacts, then requests approval through the
`coordinated-production-release` GitHub environment. That GitHub approval is
Mentra's production go/no-go decision. Only after stable package publication
and the external Engine consumer gate succeed does mobile promotion:

1. locate the exact existing App Store Connect build by bundle ID and build
   number;
2. require the App Store version to use that build, failing rather than
   replacing a different attached build;
3. submit the existing build to App Review without uploading, rebuilding, or
   re-signing another IPA; and
4. verify that App Store Connect retained the exact build and moved the version
   into the review or release flow.

The current policy submits with `automatic_release: true`. Apple review remains
an external approval, but after Apple approves the version it is released
automatically. There is no additional manual App Store Connect release button
in this policy. Preserving a final human release gate in App Store Connect would
require changing this setting to `false`; that is a release-policy change and
must not happen implicitly.

App Store Connect remains the operational surface for TestFlight membership,
required app metadata, compliance information, review status, rejection
handling, and exceptional intervention. The automation is retry-safe around
manual intervention: if the exact build is already in the review or release
flow, promotion verifies and reuses that state; if the same App Store version
is attached to a different build, promotion fails closed.

## Artifact Names

Primary downloadable artifacts use:

```text
<product>-<derived-version>[-<platform>].<extension>
```

Examples:

```text
mentraos-3.1.0-dev.184-android.apk
mentraos-3.1.0-beta.57-ios.ipa
mentra-live-ota-3.1.0-beta.57.json
mentra-live-asg-selection-3.1.0-beta.57.json
mentra-release-3.1.0-beta.57.json
bluetooth-sdk-3.1.0-beta.57.aar
bluetooth-sdk-3.1.0-beta.57.xcframework.zip
mentra-engine-3.1.0-beta.57.tgz
```

Do not put dates, unexplained counters, `_Beta_N`, ASG version codes, or workflow
run IDs in primary names. Native store build numbers and source SHAs remain in
the release manifest and diagnostics.

Primary artifact filenames remain human-readable and version-based. Content
hashes are recorded in `release-manifest.json` and attestations. The semantic
prerelease sequence in `3.1.0-beta.57` is intentional, not a random artifact
identifier. When production promotes the exact tested candidate, it may
continue to reference that immutable candidate URL rather than renaming or
copying the artifact for cosmetic reasons.

The reusable ASG build object is the one technical exception. It uses
`mentra-live-asg-<version-code>-<build-fingerprint>.apk` plus a matching
provenance JSON asset because the same verified APK can be selected by more than
one release set. The fingerprint is the immutable reuse lookup key, not a
release name. Each release exposes the semantic
`mentra-live-asg-selection-<derived-version>.json` record that resolves its ASG
object and records the object's hash, version, signature, and provenance.

## Documentation Channels

Documentation has the same release-channel identity as the products it
describes:

| Source channel | Published docs                      | Cloudflare Pages project | Injected version              |
| -------------- | ----------------------------------- | ------------------------ | ----------------------------- |
| `dev`          | `https://docs-dev.mentraglass.com`  | `mentraos-docs-dev`      | Exact `X.Y.Z-dev.N` identity  |
| `staging`      | `https://docs-beta.mentraglass.com` | `mentraos-docs-beta`     | Exact `X.Y.Z-beta.N` identity |
| `main`         | `https://docs.mentraglass.com`      | Mintlify Git deployment  | Stable `X.Y.Z` family base    |

`mintlify-docs/docs.json` uses Mintlify's native global variables. The checked-in
`release-version` and production release-artifact URL use the stable family
base, so the `main` branch remains directly buildable by Mintlify. Current
release references throughout `mintlify-docs/mentra-live/` use those variables
instead of copied literals.

The coordinated `dev` and `staging` workflow does not edit the checkout. After
release finalization succeeds, it:

1. checks out the release plan's exact source commit;
2. copies `mintlify-docs/` into a temporary directory;
3. updates `release-version` and `release-artifacts-url` in that copy using a
   structured JSON renderer;
4. exports the copied tree with Mintlify;
5. adds `X-Robots-Tag: noindex`, deploys it to the channel's Pages project, and
   verifies the custom domain contains the exact release identity; and
6. reports the documentation URL and pass/fail state in the channel's Slack
   release notification.

The previous independent push-triggered dev-docs workflow is removed. It could
race a coordinated release and replace exact `dev.N` documentation with the
checked-in stable base version. A docs deployment failure leaves the previously
published site online, fails the docs job, and makes Slack report the otherwise
finalized release as incomplete. It does not rewrite or roll back an immutable
release manifest.

Starter Kit example applications keep separate `example-app-version` and
`example-app-url` variables until the Starter Kit joins the coordinated release
pipeline. Coordinated docs must not construct a nonexistent example download
from the MentraOS release identity. Production remains a Mintlify deployment
from `main`; changing that external branch setting from `staging` to `main` is
an operator action, not part of the dev/beta Pages workflow.

## Promotion

Production selects one completed staging release set. Before requesting
protected approval, the read-only validation job verifies:

- the selected source commit is present in `main`;
- the stable identity and package plan derive deterministically from the
  selected beta;
- the staging package graph and mobile artifacts passed required tests;
- every recorded artifact is still readable and hash-identical;
- the OTA manifest and every referenced artifact are immutable and valid.

After protected approval, it proceeds in this order:

1. Publish stable npm, Maven, and SwiftPM package versions from the selected
   source with the same dependency graph and OTA pin.
2. Install the stable public Engine package into a clean external fixture and
   prove its TypeScript, Metro, native Android, and native iOS integration.
3. Promote the exact tested IPA and Android store artifact only after the
   package and consumer gates succeed.
4. Write the stable release manifest linking back to the selected beta
   manifest and move npm `latest` and equivalent stable pointers only after all
   targets are complete.

Stable package metadata cannot literally reuse prerelease package bytes when
the embedded package version must change. It must be reproduced from the same
source commit and OTA pin. The existing package-specific release validators
inspect the stable npm, Maven, and SwiftPM outputs for the exact stable version,
dependency graph, source commit, and OTA metadata. A second generic archive
normalization system is deliberately out of scope. The ASG, MTK, BES, OTA
manifest, IPA, and Android store artifact are not rebuilt.

## Starter Kit and Documentation

The detailed ownership, cross-repository protocol, artifact contract,
documentation rendering, Slack integration, and deferred TestFlight design are
specified in
[Coordinated Documentation and Example App Releases](./coordinated-release-docs-and-example-apps-design.md).

Starter Kit examples are downstream release consumers, not sources of package
truth.

1. Dispatch the Starter Kit repository with the exact release identity and its
   expected channel-branch head as soon as the immutable OTA release exists.
2. In that workflow, wait until npm and SwiftPM expose the coordinated SDK
   version and Engine's full dependency closure is readable. Sonatype
   publication proceeds automatically without blocking the Starter Kit gate.
3. Update every maintained example and lockfile to the selected public versions
   in an isolated candidate commit.
4. Build and publish immutable example APK/IPA artifacts and a machine-readable
   result containing their source commit, URLs, and hashes.
5. Validate that result before coordinated finalization, then render the exact
   example version and URL into dev or beta documentation.

The Starter Kit publication fails closed if a referenced package is
unavailable. Documentation never claims that an example matches a coordinated
release unless its validated Starter Kit result is included in that release's
final manifest.

## Verification Gates

Each release set must prove:

- all derived versions share the expected channel and sequence;
- package manifests contain exact coordinated first-party dependency versions;
- Engine public declarations do not reference
  `@mentra/bluetooth-sdk/internal`;
- `@mentra/engine/bluetooth-sdk` resolves through the supported public SDK root
  entrypoint at exactly the Engine version and preserves singleton identity;
- Engine source does not import from its generated `build/` output;
- clean npm tarballs contain freshly generated output, not stale local files;
- Maven, SwiftPM, and npm artifacts embed the declared SDK version and OTA pin;
- the packed Engine React Native source, JavaScript, and declarations contain
  the declared immutable Engine OTA pin and release-set identity;
- Engine and its exact Bluetooth SDK dependency contain identical OTA manifest
  URLs and hashes;
- MentraOS IPA and Android artifacts embed the release-set identity and OTA pin;
- mobile artifacts use the expected local workspace source hashes;
- the OTA manifest's ASG, MTK, and BES URLs, hashes, and versions are valid;
- an external Engine fixture app resolves, type-checks, autolinks, and builds;
- Starter Kit npm and SwiftPM dependencies build only after real registry
  publication; native Android is built only when Maven Central already exposes
  the exact version and is otherwise an optional artifact.

Any missing, malformed, mutable, unreachable, or mismatched release input blocks
publication. There is no fallback to another channel.

## Implementation And Cutover

The migration is delivered as one consolidated change, not a stack of partially
active release systems. The combined tree is reviewed and validated as one
workflow graph. Legacy automatic publishers are disabled or removed in the same
cutover that enables the coordinator, so two systems cannot publish the shared
`3.1.0` coordinates.

1. **Engine boundary:** add the explicit `@mentra/engine/bluetooth-sdk` facade,
   introduce Engine-owned models for Engine concepts, remove SDK-internal paths
   from all public declarations, and add API-surface, singleton-identity, and
   resolved-version tests.
2. **Manifest inventory:** define the explicit release-family allowlist and
   dependency DAG; classify host peers versus exact first-party dependencies.
3. **Family version:** introduce one canonical future stable version, set the
   current train to `3.1.0`, validate every coordinated package manifest against
   it, and remove the duplicated MentraOS environment authority.
4. **Shared derivation:** implement one tested version/channel/sequence library
   used by every workflow.
5. **OTA workflow:** extract one reusable immutable OTA-bundle publisher with
   validated ASG build-input fingerprinting and artifact reuse. Keep reusable
   ASG pairs in their shared release and publish release-specific OTA assets to
   the owning coordinated prerelease.
6. **Coordinator:** generate the version map and immutable `release-plan.json`,
   invoke dependency and product workflows, then finalize
   `release-manifest.json` only after complete publication. Isolate `dev` and
   `staging` queues and coalesce same-channel bursts to the latest pending head.
7. **Dev and staging:** publish complete coordinated sets and distribute mobile
   builds to their existing TestFlight/Play groups.
8. **Artifact verification:** inspect every package and mobile artifact for
   version, dependency, source, and OTA-pin provenance, including literal Engine
   tarball metadata and Engine-to-SDK pin equality.
9. **Production promotion:** validate one completed beta, request protected
   approval, prove stable packages through the external Engine consumer, then
   promote mobile without rebuilding mobile or OTA artifacts.
10. **Remove old fallback logic:** delete SDK-version URL derivation and mutable
    modern OTA fallbacks once all supported release artifacts carry pins.
11. **Downstream releases:** automate Starter Kit updates and gate docs on live
    packages and example artifacts.

## Acceptance Criteria

- Every selected `dev` or `staging` head creates one family base and release
  identity shared by all three products and their public dependency closure,
  encoded in platform-valid version fields.
- No ordinary prerelease commit requires a checked-in version edit.
- MentraOS builds local workspaces and is not blocked on package registries.
- A standalone Engine consumer resolves an exact, installable package graph.
- Engine's public API and declarations contain no Bluetooth SDK internal types.
- `@mentra/engine/bluetooth-sdk` exposes the public SDK at exactly the Engine
  version on JavaScript, Android, and iOS and returns the same singleton as a
  direct import of that SDK version.
- All release artifacts select one immutable OTA bundle.
- A released Engine tarball contains its own immutable OTA manifest URL and hash;
  it does not depend on SDK-version URL derivation or a mutable fallback.
- An unchanged ASG build-input fingerprint reuses the exact previously validated
  APK; a changed fingerprint produces one new immutable APK.
- Dev and beta builds are immediately distinguishable in TestFlight metadata,
  artifact names, diagnostics, and the release manifest.
- Dev and beta docs show the exact finalized release identity on their own
  domains, remain non-indexable, and report their result in release Slack.
- A workflow retry reconciles the same identity without overwriting bytes.
- Each prerelease owns its OTA manifest, ASG selection, and portable bundle;
  the shared ASG release contains only reusable APK/provenance pairs.
- Production promotes the tested staging mobile and OTA artifacts.
- Production mobile promotion begins only after stable packages publish and the
  registry-backed Engine consumer succeeds.
- Public docs and examples update only after their dependencies are available.
