# Production release runbook

This is the employee procedure for promoting one completed coordinated beta to
production. It covers Cloud V2, the Mentra App on iOS and Android, and the
Bluetooth SDK Starter Kit example on iOS and Android.

The process is resumable. It records immutable state in a draft GitHub release
named `mentra-production-promotion-vX.Y.Z-attempt-N`. Store review may take days;
no GitHub runner waits for it.

## Safety rules

- Start only from a completed coordinated beta whose source is in `main`.
- Never patch or re-sign a beta binary. Production mobile candidates are rebuilt
  from the frozen source with production configuration.
- Never edit or replace an existing promotion asset. Retry the same phase or
  start a new attempt.
- Never paste tokens, secrets, private keys, customer data, or raw production
  configuration into evidence.
- Cloud deployment, candidate upload, store submission, and public release use
  separate protected GitHub environments. A distinct approver is required for
  production Cloud and public release.
- A green readiness endpoint is not mobile acceptance. Both iOS and Android
  device evidence are required.
- Stop on any coordinate mismatch. Do not choose a build in a store by date or
  appearance.

## Release order and compatibility contract

The required order is:

1. Current Mobile N source, configured as a non-promotable lab build, works with
   staging Cloud N+1.
2. Deploy Cloud N+1 to production.
3. The actual Mobile N currently installed from both public stores works with
   production Cloud N+1.
4. Build Mobile N+1 from source with production configuration.
5. The exact TestFlight and Play internal candidates work with Cloud N+1.
6. Submit those exact candidates, wait for review, and release progressively.

Mobile N+1 compatibility with Cloud N is not a normal gate. Customers will
inevitably keep Mobile N after Cloud N+1 is deployed, so Mobile N with Cloud N+1
is mandatory.

## One-time repository and account setup

Configure these GitHub environments:

| Environment                    | Purpose                             | Required protection                        |
| ------------------------------ | ----------------------------------- | ------------------------------------------ |
| `production-store-status`      | Read-only store inventory/status    | Store credentials; no public mutation      |
| `production-cloud-status`      | Cloud configuration preflight       | Porter credential; no deployment approval  |
| `production-compatibility-lab` | Non-promotable Mobile N uploads     | Required reviewer; staging target only     |
| `production-cloud`             | Cloud V2 deployment                 | Required reviewer different from initiator |
| `production-mobile-candidates` | Production-signed candidate uploads | Required reviewer; no public release       |
| `production-store-submission`  | App review submission               | Required reviewer                          |
| `production-store-release`     | Public release and rollout evidence | Required reviewer different from initiator |

Required secrets are the existing Porter, App Store Connect, Google Play,
Android upload-signing, Apple Match, Doppler, Mapbox, Sentry, and Starter Kit
checkout credentials used by the reusable release workflows. Operators do not
download them locally.

Before launch week, verify in App Store Connect and Play Console for both app
records:

- agreements, tax, banking, compliance, privacy, export, data safety, content
  rating, countries, support/privacy URLs, screenshots, and listing copy;
- App Review contact, a non-expiring demo account, and complete reviewer steps;
- internal tester membership and dedicated test devices;
- a `Mentra Compatibility Lab` internal TestFlight group;
- automatic TestFlight distribution is off for the production groups;
- managed publishing is enabled for existing Google Play apps; and
- alerting, dashboards, incident channel, release owner, QA owner, approver, and
  rollback owner are staffed for the release window.

### Starter Kit first release prerequisites

The Starter Kit has not previously been public in the stores. Before starting:

- finalize `com.mentra.bluetoothsdkexample` in source, App Store Connect, and
  Google Play;
- create the Play app record, enable Play App Signing and API access, and
  bootstrap internal testing early;
- ensure the stable `sdk-X.Y.Z` Starter Kit tag consumes exact public
  `@mentra/bluetooth-sdk` and `@mentra/engine` version `X.Y.Z`;
- complete the product-quality gate in the design document: this must be a
  finished developer utility, not a placeholder/demo shell; and
- arrange the hardware, account, instructions, and reviewer access Apple needs.

Google Play does not support managed publishing or staged rollout for an app's
first public release. Approval may make that first Starter Kit Android release
public. Submit it only during a staffed release period and monitor continuously.

## Operator commands

From a clean, up-to-date `main` checkout:

```bash
git switch main
git pull --ff-only origin main
./scripts/production-release.mjs start --beta X.Y.Z-beta.N
./scripts/production-release.mjs status --release X.Y.Z
```

`status` is the source of truth for the current state and next action. Use
`--json` for machine-readable output. Use `--attempt N` when inspecting an older
attempt. Use `status --refresh` to dispatch the read-only store status workflow.

Mutating commands require typing the release identity, or `--yes` in an already
reviewed non-interactive procedure. The CLI never reads production credentials
and never calls Porter or a store directly.

## Phase 1 - select and freeze

`start` dispatches `production-release-prepare.yml`. It only reads completed
release/store records and creates the draft promotion evidence container. It
does not deploy, upload, submit, or release anything.

Preparation fails if:

- the beta is incomplete or its immutable artifacts fail verification;
- its source is not contained in `main`;
- the public Mentra App does not match the previous production manifest;
- the stable Starter Kit tag is missing;
- store build numbers cannot be allocated monotonically; or
- the current production release lacks provenance. For a one-time provenance
  bootstrap, create and review an accurate immutable current-production record;
  do not invent coordinates in the workflow.

## Phase 2 - Mobile N against staging Cloud N+1

Run the next action and watch it to completion:

```bash
./scripts/production-release.mjs next --release X.Y.Z
```

After `production-compatibility-lab` approval, this rebuilds the exact frozen
current-production Mobile N source with the allocated lab build number and
staging configuration. It uploads iOS as TestFlight Internal Only to `Mentra
Compatibility Lab` and Android through Play Internal App Sharing, then records
the App Store coordinate, Play download URL, source commit, binary digests, and
target Cloud commit. It does not create a customer-promotable candidate.

Install both builds using the coordinates in the workflow summary and immutable
`production-compatibility-lab.json` evidence. Diagnostics must show
`COMPATIBILITY-LAB-NOT-FOR-PRODUCTION` and staging Cloud N+1. Apple documents that a [TestFlight
Internal Only build cannot be submitted to
customers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).
Google documents that an [Internal App Sharing artifact cannot be included in a
testing or production
release](https://support.google.com/googleplay/android-developer/answer/9844679).

On both iOS and Android record device/OS, glasses/firmware, exact app version and
build, tester, Cloud diagnostics, and timestamps. Verify:

- sign-in and session restoration;
- glasses pair/reconnect;
- Core and Runtime connection;
- a short privacy-safe transcription;
- one representative photo/media/Bluetooth path;
- restart/reconnect; and
- no production endpoint in diagnostics or captured traffic.

Copy `evidence/staging-mobile-n.template.json`, fill it, store screenshots/logs
at durable credential-free HTTPS URLs, then run:

```bash
./scripts/production-release.mjs attest --release X.Y.Z \
  --check staging-mobile-n-compatibility \
  --evidence release-evidence/X.Y.Z/staging-mobile-n.json
```

Any failure requires a fixed beta identity. Do not carry evidence across source
changes.

## Phases 3 and 4 - production config and Cloud V2

Run `next` once for preflight and, after it succeeds, again for deployment:

```bash
./scripts/production-release.mjs next --release X.Y.Z
```

Preflight loads staging and production configuration into temporary mode-0600
files, validates the versioned contract, and publishes only key names and
pass/fail results. It never compares or publishes raw values or secret hashes.

Before approving `production-cloud`, compare the frozen source, target, previous
revision, migration notes, and rollback coordinates in the workflow summary.
The deploy records the observed Cloud V2 deployment result, not merely the
request. Stop if readiness, running revision, digest, or migration evidence is
missing.

## Phase 5 - actual Mobile N against production Cloud N+1

Remove lab builds. Install or update the Mentra App through the public App Store
and Google Play and verify the displayed coordinates match the frozen current
production record. On both platforms repeat sign-in/session restore,
pair/reconnect, Core/Runtime, short transcription, representative media/BLE,
release-specific backward compatibility, and restart.

Use `evidence/production-mobile-n.template.json` and attest:

```bash
./scripts/production-release.mjs attest --release X.Y.Z \
  --check production-mobile-n-compatibility \
  --evidence release-evidence/X.Y.Z/production-mobile-n.json
```

If either platform fails, stop. Choose an explicit Cloud rollback or forward
fix, then repeat all invalidated evidence.

## Phases 6 through 8 - build, upload, and accept candidates

Run:

```bash
./scripts/production-release.mjs next --release X.Y.Z
```

After `production-mobile-candidates` approval, the workflow rebuilds all four
candidates. Mentra App targets production Cloud and uses the frozen OTA pin.
Starter Kit source must already contain the final identifiers and exact stable
SDK dependencies; the workflow refuses to rewrite them. Outputs go only to:

- TestFlight `Mentra Production Candidates`;
- TestFlight `Mentra SDK Example Production Candidates`; and
- each app's isolated Play internal-testing track.

They are normal customer-eligible candidates, never TestFlight Internal Only or
Internal App Sharing artifacts. A retry reuses only an exact matching coordinate
and immutable artifact.

Install through TestFlight and Play, not local archives. On iOS and Android test
the Mentra App clean install/upgrade, production auth/session, pair/reconnect,
Core/Runtime, transcription, media/BLE, OTA identity, permissions/background,
telemetry environment, no staging endpoints, and every release-specific config
check. Test Starter Kit launch, stable SDK identity, pair/reconnect, display,
audio/transcription-local flow, media flow, permissions, and restart.

Use `evidence/production-candidates.template.json` and attest:

```bash
./scripts/production-release.mjs attest --release X.Y.Z \
  --check production-mobile-candidate-acceptance \
  --evidence release-evidence/X.Y.Z/production-candidates.json
```

A binary/configuration failure needs a new build number and new candidate
acceptance. Abort this attempt rather than relabeling a failed build.

## Phases 9 and 10 - submit and wait for review

In both consoles first complete all human-only metadata and verify exact build
numbers. For Apple select manual release; use phased release for normal Mentra
App updates unless the approver documents an exception. For Play verify managed
publishing before an existing-app production submission.

Then run `next`. The protected workflow submits the exact iOS builds with manual
release and creates/reconciles exact Google production drafts. If a store field
blocks the API, finish only the equivalent UI action and rerun; the workflow
must read back the same build.

Apple UI fallback:

1. App Store Connect -> app -> target iOS version.
2. Select the exact accepted build.
3. Choose manual release and phased release as applicable.
4. Add for Review, open the draft submission, verify the build again, and
   Submit for Review.

Google UI fallback:

1. Play Console -> app -> Production -> Create/Edit release.
2. Select the exact internal-track version code.
3. Complete release notes/declarations, Review release, then Send for review.
4. For existing apps, confirm the change remains in managed publishing.

Check without holding a runner:

```bash
./scripts/production-release.mjs status --release X.Y.Z --refresh
```

Record rejection messages and responses. Metadata-only corrections may reuse
the exact binary. Any binary/config change requires a new candidate and full
candidate acceptance.

When Apple and Google show review complete for all four exact coordinates, fill
`evidence/store-review-approved.template.json` and run:

```bash
./scripts/production-release.mjs attest --release X.Y.Z \
  --check store-review-approved \
  --evidence release-evidence/X.Y.Z/store-review-approved.json
```

## Phases 11 and 12 - public release and rollout

Request the protected two-person release approval:

```bash
./scripts/production-release.mjs release --release X.Y.Z
```

This first appends approval only. It does not pretend that a GitHub approval
clicked a store button. After approval, perform the exact UI actions:

- Apple: release the exact approved versions; leave Mentra App phased release
  enabled unless an exception was approved.
- Google existing apps: Publishing overview -> Publish changes, then start the
  approved staged rollout for the exact version code.
- Starter Kit first Android release: approval may already have published it;
  treat this as the documented first-release exception and monitor immediately.

Run `next` to verify the exact builds are publicly rolling out and enter
`rolling-out`.

Use dashboards, crash-free sessions, auth/session, Core/Runtime connection,
transcription, Bluetooth/media, support reports, Cloud saturation/error rate,
and store install telemetry. Halt rollout on unexplained regression. Prefer
halting mobile and forward-fixing Cloud after any Mobile N+1 reaches users;
Cloud rollback is safe only when the affected N+1-to-N pairing was separately
proven.

After changing Google rollout percentage in Play Console and verifying Apple
phased-release state, record monotonically increasing observations:

```bash
./scripts/production-release.mjs advance --release X.Y.Z --android-percent 25
./scripts/production-release.mjs advance --release X.Y.Z --android-percent 50
./scripts/production-release.mjs advance --release X.Y.Z --complete
```

`--complete` records 100 percent and closes the immutable promotion chain. Do
not complete until both store pages are publicly reachable in intended
territories, install/update returns the exact coordinates, production Cloud is
healthy, and the release owner has recorded the final observation window.

## Abort, retry, and incident handling

Abort an attempt with:

```bash
./scripts/production-release.mjs abort --release X.Y.Z --reason "concise reason"
```

Abort is terminal and does not itself roll Cloud back or remove store builds.
Follow the incident commander's explicit mitigation. A new attempt allocates
new store build numbers and references the failed attempt. Never delete failed
evidence.

Common stop conditions include source/lock mismatch, missing store provenance,
unclassified Cloud config, non-backward-compatible migration, Mobile N failure,
wrong endpoint or OTA pin, store coordinate drift, rejected binary, missing
reviewer access, and monitoring uncertainty during rollout.

## UI-only GitHub fallback

If the local CLI is unavailable, open Actions, select the workflow named by the
current state, click Run workflow, keep branch `main`, and copy release identity
and attempt exactly from the promotion container. Never select a feature branch.
Human evidence must first be uploaded with the immutable naming convention; the
recommended recovery is to restore the CLI rather than improvising API calls.

## Validation boundary

Changes to these workflows are validated by pull-request tests and tabletop
records. A PR must never dispatch a production workflow. The first end-to-end
external validation necessarily occurs during an explicitly authorized release,
with every protected approval and stop condition above still in force.
