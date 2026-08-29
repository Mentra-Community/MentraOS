---
status: approved
owner: Mentra
---

# Production promotion system design

## Outcome

Mentra can promote one completed coordinated beta release to production through
a repeatable, resumable, and auditable process that another trained employee can
operate from a written runbook.

The promotion releases:

- Cloud V2 Core and Runtime;
- the Mentra App for iOS and Android; and
- the React Native Bluetooth SDK Starter Kit example app for iOS and Android.

The process proves the two mobile/cloud compatibility relationships that matter:

1. the currently published Mentra App continues to work with the new Cloud; and
2. the new production Mentra App works with that new Cloud.

It does not require the new Mentra App to work with the old Cloud. That pairing
is relevant only if an incident commander wants the option to roll Cloud back
after the new mobile app has already reached users; it is not a normal release
gate.

This document is the normative design. Existing workflows, checks, comments,
and older design notes are implementation inventory, not policy. Where they
conflict with this document, this document describes the intended replacement.

## User-visible promise

A production promotion must never depend on the release operator remembering an
undocumented command, knowing which store build “looks right,” or inferring that
a green health endpoint means the mobile product works.

From a fresh checkout, an authorized employee must be able to:

1. open the production-release README;
2. identify the release and required access;
3. run one documented command to see the current state and next action;
4. perform the human checks the README names;
5. resume safely after Apple or Google takes hours or days to review an app;
6. know when to stop, retry, roll back, or escalate; and
7. prove which Cloud deployment and store artifacts reached customers.

## Scope

### In scope

- Selecting a completed coordinated beta release as the production source.
- Verifying that the selected MentraOS and Starter Kit sources are approved for
  production and immutable.
- Validating production Cloud configuration without exposing secret values.
- Testing the currently published Mentra App generation against candidate and
  production Cloud.
- Deploying and verifying Cloud V2 production.
- Rebuilding the selected Mentra App source with production configuration.
- Building the selected Starter Kit example against the stable coordinated SDK
  release.
- Uploading normal, customer-eligible candidates to TestFlight and Google Play
  internal testing.
- Testing the exact store-delivered candidates.
- Submitting the exact accepted builds for store review.
- Releasing, progressively rolling out, observing, halting, and finalizing.
- Human approvals, evidence, rejection handling, and rollback instructions.
- A version-controlled operator CLI and a UI-only fallback procedure.

### Integration points, not redesigned here

The broader coordinated release remains responsible for producing and
verifying the stable package family, native Bluetooth SDK artifacts, Mentra
Live OTA set, documentation inputs, and immutable release records. Production
promotion consumes those outputs and includes their identities in its final
record.

Before the Starter Kit store candidates can build, the exact stable npm, Maven,
and SwiftPM coordinates they consume must be publicly readable and verified.

### Out of scope

- Cloud V1, which was removed before implementation began.
- Defining dev or staging publication policy.
- Dynamically rewriting a signed mobile binary.
- Patching and re-signing a staging mobile artifact as production.
- Requiring Mobile N+1 to work with Cloud N.
- An unrestricted server URL switcher in a public mobile app.
- A fully automated runtime smoke test that pretends to replace device testing.
- Replacing Porter, Doppler, App Store Connect, or Google Play.
- Product marketing decisions such as final Starter Kit store name, screenshots,
  supported countries, or launch announcement copy.

## Terminology

- **Release N**: the production generation currently used by customers, such as
  Mentra App 3.0 and Cloud 3.0.
- **Release N+1**: the proposed generation, such as Mentra App 3.1 and Cloud 3.1.
- **Selected beta**: one completed coordinated staging release whose exact
  source and artifacts are the basis of production.
- **Compatibility-lab build**: a deliberately non-promotable mobile build made
  from the exact current-production source but configured to use candidate
  staging Cloud N+1.
- **Production candidate**: a normal customer-eligible store build made from
  the selected N+1 source with production configuration.
- **Promotion record**: append-only evidence that identifies release inputs,
  completed phases, human attestations, Cloud deployment, store builds, review
  states, rollout states, and final public availability.
- **Release operator**: the employee executing the runbook.
- **Release approver**: a second authorized person approving irreversible
  production actions.

## Hard decisions

1. **Cloud is promoted before the new mobile apps.** Existing Mobile N clients
   must continue operating throughout the Cloud deployment and store-review
   delay.
2. **Cloud N+1 must support Mobile N.** Store updates cannot be forced, and
   customers may remain on N for an extended period.
3. **The production Mentra App is rebuilt from the selected source.** Staging
   embeds staging endpoints; production embeds production endpoints.
4. **Production candidates are built after Cloud N+1 is deployed and Mobile N
   has passed against it.** This keeps the human sequence simple and ensures all
   candidate acceptance testing targets the intended server generation.
5. **The exact store-delivered candidate is promoted.** No rebuild occurs
   between internal acceptance and store submission or release.
6. **Store submission and public release are separate decisions.** Apple uses
   manual release. Existing Google Play apps use managed publishing and staged
   rollout. External review approval must not silently publish an update.
7. **External review does not hold a GitHub runner.** Promotion is a resumable
   state machine made of idempotent phases, not one workflow waiting for days.
8. **Production configuration is a checked contract.** Presence, type,
   environment ownership, and safe dependency probes are verified before
   deployment; raw secrets are never compared, printed, hashed into public
   evidence, or copied from staging.
9. **Human tests produce durable evidence.** A checkbox in someone's memory is
   not a release gate.
10. **Production Cloud deployment and public store release require protected,
    two-person approval.** The initiating operator cannot be the sole approver.
11. **The operator CLI is executable, not sourced.** It must not mutate the
    caller's shell or contain production credentials.
12. **A failed phase is resumable under the same release identity.** A retry
    reuses identical completed outputs and fails on conflicting state.

## Compatibility contract

### Required matrix

| Client                                | Server              | Environment | When                               | Requirement |
| ------------------------------------- | ------------------- | ----------- | ---------------------------------- | ----------- |
| Mobile N compatibility-lab build      | Cloud N+1 candidate | Staging     | Before production Cloud deployment | Required    |
| Actual Mobile N from App Store/Play   | Cloud N+1           | Production  | Immediately after Cloud deployment | Required    |
| Exact Mobile N+1 production candidate | Cloud N+1           | Production  | Before store submission            | Required    |

The first row proves the protocol and behavior before changing production. The
second row closes the gap by exercising the actual currently distributed
artifact against production. The third row accepts the artifact proposed for
customers.

Both iOS and Android are required. A release may not infer one platform's
result from the other because authentication, networking, permissions,
background execution, Bluetooth, and store packaging differ.

### Explicitly not required

`Mobile N+1 -> Cloud N` is not part of normal promotion acceptance. The release
order never exposes Mobile N+1 before Cloud N+1.

After Mobile N+1 begins public rollout, a Cloud rollback to N could break those
new clients. The default incident policy is therefore to halt mobile rollout
and forward-fix Cloud N+1. An incident commander may roll Cloud back to N only
if that specific N+1-to-N pairing has separately been demonstrated safe.

### Compatibility-lab builds

The currently published mobile artifacts generally cannot be redirected to
staging because their endpoints are embedded and signed. The release system
therefore creates lab builds with these properties:

- source revision and dependency locks exactly match the current store release;
- only the environment identity, Cloud endpoints, telemetry environment, and
  required numeric build coordinate differ;
- the in-app diagnostics identify the build as `COMPATIBILITY LAB — NOT FOR
PRODUCTION`;
- the output is cryptographically and operationally non-promotable;
- a machine-readable record lists every difference from the published build;
  and
- dedicated QA devices install the lab build without overwriting the evidence
  about the actual store-installed build used after deployment.

Prefer separate lab and production device pairs. If the team has only one iOS
and one Android test device, the README must require removing the lab build,
reinstalling from the public store, and verifying the exact public build
coordinates before Phase 5.

Recommended non-promotable distribution:

- iOS: TestFlight Internal Only in a `Mentra Compatibility Lab` group. Apple
  explicitly prevents these builds from being submitted to customers.
- Android: Google Play Internal App Sharing. Those artifacts cannot be used in
  testing or production releases.

These mechanisms are appropriate for compatibility evidence, but not for the
N+1 production candidate. The production candidate must remain eligible for
customer distribution.

## Release inputs

Starting a promotion freezes these inputs:

- selected beta identity and completed beta-manifest digest;
- MentraOS full source commit contained in `main`;
- Starter Kit full source commit approved for the stable channel;
- current production Mentra App iOS version/build and Android version code;
- provenance mapping those current store builds to source commits and locks;
- target stable family version;
- immutable Mentra Live OTA manifest URL and digest;
- stable package and native SDK coordinates and digests;
- production Cloud configuration-contract version;
- intended production Cloud source commit and image inputs;
- monotonic store build numbers allocated independently for each app record;
- release owner, QA verifier, approver, and incident contact; and
- planned public release window and supported countries.

The release record must reject a selected beta whose source has not completed
the normal review path into `main`. A workflow ref, branch head, or local
checkout is never an implicit production source.

## Production state machine

```text
selected
  -> staging-compatible
  -> production-config-ready
  -> cloud-deployed
  -> current-clients-accepted
  -> mobile-candidates-uploaded
  -> mobile-candidates-accepted
  -> stores-submitted
  -> stores-approved
  -> public-release-approved
  -> rolling-out
  -> finalizing
  -> completed
```

`aborted` is terminal for one promotion attempt. A new attempt can reuse the
same source only when it allocates new unique store build numbers and clearly
references the aborted attempt. The allocator permits at most one non-aborted
attempt for a release identity, so a second operator or direct workflow dispatch
cannot bypass the point-of-no-return rule. Production preparation is serialized
across release identities while it allocates the attempt, avoiding a second
beta selection racing the initial state publication. If allocation succeeds but
initial state publication does not, retry resumes that same empty container only
when its draft metadata matches the exact selected beta and source commit.

Each transition consumes the immutable records from earlier phases and emits a
new append-only record. It never edits an earlier successful record to make a
different result appear equivalent.

`finalizing` is a durable retry boundary after the 100 percent rollout
observation. From there the workflow creates or verifies the canonical stable
plan and manifest in the draft `mentra-vX.Y.Z` release before it may append
`completed`. Candidate archives remain in the private, attempt-scoped promotion
container so an aborted attempt cannot be mistaken for a later attempt or for
the public release. The exact finalizing checkpoint is copied into the stable
draft as a public-verifiable canonical asset. Because 100 percent rollout is
already a customer-visible point of no return, `finalizing` cannot be aborted;
an interrupted attempt must resume finalization.

Workflow-produced evidence assets use content-addressed names. Evidence is
published before the state that references it; if state publication fails, a
retry can publish another content-addressed observation without overwriting the
first. Only evidence referenced by the successfully published state chain
counts as completed. Human attestations must identify the exact frozen
marketing version and native build/version code for every required product and
platform.

## Phase 0: account and launch readiness

This phase is completed once per app and rechecked before every release.

### Access

The release owner verifies:

- GitHub write access and GitHub CLI authentication;
- membership in the required TestFlight internal groups;
- App Store Connect App Manager or Admin access for submission/release;
- Google Play permissions for internal testing, production releases, and
  Publishing overview;
- access to the release dashboards and incident channel; and
- a distinct approver able to approve protected production environments.

Automation credentials remain in protected GitHub environments. An operator
must not download store keys, Porter credentials, or Doppler service tokens to
run the normal release.

### Store bootstrap

For each app record, the owner verifies before the desired launch week:

- agreements, tax, banking, and compliance state permit submission;
- bundle/package identifiers and signing are final;
- privacy policy and support URLs are live;
- age rating, data-safety/privacy declarations, export-compliance answers,
  screenshots, descriptions, categories, territories, and contact details are
  complete;
- App Review has a non-expiring demo account and detailed testing notes when
  login or hardware is required;
- Google Play App Signing and API access are configured;
- internal tester groups contain the intended employees and dedicated devices;
  and
- automatic TestFlight group distribution is disabled for production
  candidates.

The Starter Kit example is a first public store release. Before implementing
this pipeline, its Android Play app record must be created and its production
package identifier finalized. The recommended identifier is
`com.mentra.bluetoothsdkexample` on both platforms, matching the existing iOS
App Store record. Source configuration and both stores must converge on one
identifier before the first candidate is built.

### Starter Kit store-readiness gate

Calling the repository a “Starter Kit” does not exempt the installed app from
store quality rules. Apple does not accept demos, betas, or apps without
adequate utility as public App Store products, and Google Play prohibits apps
with only limited functionality or content. Before its first store candidate,
the product owner, mobile owner, and release owner must sign off that the app:

- is a finished, stable developer utility with a clear standalone purpose, not
  placeholder screens or a thin advertisement for the SDK;
- has customer-facing onboarding, error recovery, privacy/support surfaces,
  and an explanation of the Mentra Live hardware requirement;
- exposes enough meaningful Bluetooth SDK functionality for a developer to
  pair hardware and evaluate the supported capabilities;
- contains no debug-only controls, fake data presented as real, unfinished
  copy, dead links, inaccessible screens, or “coming soon” core paths;
- has accurate screenshots and listing copy showing the real experience and
  required hardware;
- gives Apple App Review full access, including an active account and any
  hardware, sample QR code, instructions, or other resource needed to exercise
  non-obvious features; and
- has a documented reviewer path and a release-day support owner.

A video may supplement review notes, but it is not a substitute for the access
Apple requests. If Mentra cannot provide a reviewer with the hardware or other
resources needed to exercise the core experience, the first public submission
is not release-ready. Resolve that product/review strategy before starting a
promotion; do not ask the pipeline to hide the limitation.

## Phase 1: select and freeze the release

The operator starts from a clean checkout of `main`:

```bash
git switch main
git pull --ff-only origin main
./scripts/production-release.mjs start --beta 3.1.0-beta.57
```

The command authenticates to GitHub, dispatches the preparation workflow from
`main`, prints the run URL, and waits only for the short preparation phase.

Preparation must:

1. download and verify the completed selected beta record;
2. verify source ancestry and immutable artifact hashes;
3. resolve current production store build identities and provenance;
4. resolve the exact Starter Kit stable source;
5. allocate target production build numbers without uploading anything;
6. create the initial promotion record; and
7. print the next required human action.

No production service, registry pointer, TestFlight group, Play track, or store
submission changes during preparation.

## Phase 2: prove Mobile N against candidate Cloud N+1

The candidate Cloud N+1 must already be deployed to staging from the selected
source and configuration contract. The release system builds the two
non-promotable Mobile N compatibility-lab artifacts and records their exact
relationship to the current store versions.

On dedicated iOS and Android devices, the QA verifier follows the README:

1. record device model, OS version, glasses model/firmware, current production
   app coordinates, and tester identity;
2. install the compatibility-lab build;
3. verify diagnostics show Mobile N source and staging Cloud N+1 endpoints;
4. sign in with the staging release-test account;
5. pair or reconnect supported glasses;
6. establish Core and Runtime sessions;
7. run a short, privacy-safe transcription through the current supported
   product surface;
8. exercise one representative media/Bluetooth path used by the release;
9. verify app restart and session restoration;
10. verify no unexpected production endpoint appears in logs; and
11. attach logs, screenshots, and any release-specific feature results.

There is no dependency on an obsolete assistant name or cloud miniapp. The
transcription check exists because it exercises the Runtime session, audio
transport, speech provider, and their configuration. It may remain a documented
human test until a trustworthy automated equivalent is designed.

The operator records the completed checklist:

```bash
./scripts/production-release.mjs attest \
  --release 3.1.0 \
  --check staging-mobile-n-compatibility \
  --evidence release-evidence/3.1.0/staging-mobile-n.json
```

Any failure blocks production Cloud deployment. A code correction requires a
new beta release identity; evidence from an older candidate cannot be carried
forward implicitly.

## Phase 3: validate production Cloud configuration

Cloud configuration is represented by one checked-in, versioned contract. Each
field declares:

- owning service and feature;
- required, optional, or forbidden status per environment;
- value type and safe structural validation;
- whether changing it requires restart or migration;
- a non-secret dependency probe when one exists; and
- the release test that exercises it.

The protected preflight loads the production environment and verifies it
against this contract. It also verifies staging uses the same contract version.
It does not require equal values between environments.

Minimum production checks include:

- all required variables present and non-empty;
- environment identity and public hosts are production values;
- database, Redis, object storage, authentication, signing-key, email, maps,
  streaming, speech, and telemetry configurations have the required shape;
- public/private key pairs correspond where applicable;
- redirect URLs, buckets, issuers, and allowed origins name production;
- safe provider authentication or read-only probes succeed;
- database migrations are backward compatible with Mobile N and currently
  running Cloud N during rollout; and
- every new or changed configuration field has a named post-deploy acceptance
  test.

Evidence contains contract version, key names, pass/fail states, safe resource
identifiers, and probe timestamps. It contains no values, secret hashes, tokens,
or private key material.

Production `/ready` must fail when a required startup dependency or contract
field is invalid. Lazy features that cannot be proven at readiness remain in
the post-deploy feature checklist; `/ready` alone is not release acceptance.

## Phase 4: deploy Cloud N+1

After staging compatibility and configuration preflight pass, the operator
requests the next transition:

```bash
./scripts/production-release.mjs next --release 3.1.0
```

The CLI shows the exact source, image input, target, previous production
revision, migration plan, and rollback command. It asks for confirmation and
dispatches the protected Cloud workflow. A separate approver reviews the same
summary in GitHub and approves the `production-cloud` environment.

GitHub's protected-environment history is the approval audit record. The
promotion state advances directly from `production-config-ready` to
`cloud-deployed` only after the approved job has deployed, probed, and read
back the exact running revision. It does not publish a separate approval state
that could imply deployment happened before approval or leave an ambiguous
partial transition after the deployment already completed.

The deployment must:

1. use the frozen full source commit and guarded production target;
2. build or resolve one immutable image digest;
3. run expand-compatible migrations before code that needs them;
4. perform a rolling deployment that retains healthy capacity;
5. require internal rollout completion plus public liveness/readiness;
6. read back the running digest and revision rather than trusting the request;
7. preserve the immediately previous Cloud revision and rollback coordinates;
   and
8. emit immutable deployment evidence.

Mobile store build and submission jobs do not start as a side effect of Cloud
deployment.

## Phase 5: prove actual Mobile N against production Cloud N+1

Before changing either dedicated QA device, the tester uses the actual Mentra
App installed from the App Store and Google Play. The app must display the
recorded current production build/version.

Repeat the required compatibility flow against production:

- launch and authentication/session restoration;
- glasses pairing or reconnect;
- Core and Runtime connection;
- short privacy-safe transcription;
- representative media/Bluetooth path;
- one release-specific backward-compatibility path; and
- restart/reconnect.

The tester confirms diagnostics and captured traffic use production Cloud N+1.
This is the decisive proof that users who have not upgraded remain supported.

If either platform fails:

1. stop the promotion;
2. prevent all N+1 mobile candidate publication;
3. decide whether to roll Cloud back to the recorded N revision or forward-fix
   N+1;
4. repeat staging and production evidence after any fix; and
5. do not mark the release selected again by editing failed evidence.

## Phase 6: build production mobile candidates

Only after actual Mobile N passes against production Cloud N+1 does the system
build N+1 candidates.

### Mentra App

The build uses:

- the frozen selected MentraOS source and lockfiles;
- production Core and Runtime endpoints;
- production environment identity and telemetry;
- the immutable production OTA manifest pin;
- stable family version;
- newly allocated iOS build number and Android version code; and
- production signing identities.

### Starter Kit example

The build uses:

- the frozen Starter Kit source;
- exact stable Bluetooth SDK coordinates from the release;
- exact OTA pin and release identity where the example exposes them;
- the production app identifiers;
- app-specific monotonic iOS and Android build numbers; and
- production signing identities.

The Starter Kit example does not depend on Cloud V2 and does not need the
Mentra App compatibility tests. It is sequenced here because it is part of the
same public release and depends on the accepted stable SDK family.

### Build policy

- Build from source; do not patch or re-sign a beta binary.
- Android produces an AAB for Play plus a traceable APK for diagnostics.
- iOS produces a signed App Store IPA/archive and symbols.
- Verify bundle/package id, version, build, entitlements, signing certificate,
  embedded endpoints, OTA pin, source identity, and absence of dev/staging
  URLs.
- Publish hashes, symbols, and provenance to the promotion record.
- A retry accepts an existing store build only if every recorded coordinate and
  hash matches.

## Phase 7: upload and distinguish candidates

### Apple

Upload each normal customer-eligible build to App Store Connect and wait for
processing. Do **not** mark it TestFlight Internal Only; Apple states that such
builds cannot later be submitted to customers.

Assign builds manually, with automatic distribution disabled:

- Mentra App: `Mentra Production Candidates`.
- Starter Kit: `Mentra SDK Example Production Candidates`.

The TestFlight `What to Test` field must begin with `PRODUCTION CANDIDATE` and
include stable version, build number, source commit, Cloud deployment identity
for Mentra App, and promotion-record URL.

### Google Play

Upload each AAB to the app's internal testing track. Use a release name such as:

```text
PRODUCTION CANDIDATE 3.1.0 — build 310000123 — source abcdef12
```

The promotion record captures the Play app id, edit/release id, version code,
artifact digest, tester list, and install link. Dedicated internal-test accounts
must not be shared with normal beta testing because Play track eligibility and
highest-version behavior can otherwise make the installed build ambiguous.

For a newly configured Starter Kit Play app, the first internal-track rollout
may itself require Google review before testers can install it. The release
record remains in `mobile-candidates-uploaded` while this happens, and `status`
must show that external review—not a failed upload—is the blocker. Google says
this first review can take a few hours to seven days or longer. Bootstrap the
app and internal track well before the intended release window.

## Phase 8: accept the exact Mobile N+1 candidates

Testers install the builds through TestFlight and Google Play, not from local
archives. They verify displayed versions/builds against the promotion record.

### Mentra App acceptance

Required on iOS and Android:

1. clean install and upgrade from the current production app where practical;
2. production sign-in and session restoration;
3. glasses pairing and reconnect;
4. Core and Runtime connection;
5. short privacy-safe transcription;
6. one representative photo/media/Bluetooth flow;
7. OTA manifest identity and update eligibility behavior;
8. permissions and background/foreground transition;
9. crash and telemetry environment attribution;
10. no staging/dev endpoints in diagnostics or captured traffic; and
11. every release-specific feature/configuration test declared in Phase 3.

### Starter Kit acceptance

Required on iOS and Android:

1. store-delivered install and launch;
2. displayed SDK/release identity;
3. pair and reconnect supported glasses;
4. basic display command;
5. one representative audio or transcription-local SDK flow;
6. one representative photo/media flow supported by the example;
7. permissions and restart behavior; and
8. no dependency or OTA identity drift from the stable release record.

Failures requiring a binary change allocate a new build number, upload a new
candidate, and repeat candidate acceptance. A failed build is never silently
reassigned to the candidate group as if it had passed.

## Phase 9: submit the exact builds for store review

Submission is protected by a `production-store-submission` environment. The
workflow consumes only accepted candidate build IDs/version codes and fails if
the store points at a different artifact.

### App Store Connect procedure

For each app:

1. Open App Store Connect and select the app.
2. Open the target iOS version.
3. Verify version, build number, bundle id, and candidate evidence.
4. Complete required metadata, privacy, export compliance, territories, review
   contact, non-expiring demo credentials, and review notes.
5. Select **Manually release this version**.
6. For Mentra App updates, enable phased release for automatic updates unless
   the release approver records an explicit exception.
7. Return to the CLI and request the store-submission transition.

After protected approval, automation attaches the exact accepted build, creates
or reuses the draft submission, submits it for review, reads back the selected
build, and records the submission id and resulting status.

If App Store Connect requires a human-only action or the API cannot safely
complete the transition, the workflow stops before submission and links to the
README fallback. The operator then:

1. adds the exact accepted build to the version;
2. clicks **Add for Review**;
3. opens the draft submission and verifies the exact build again;
4. clicks **Submit for Review**; and
5. runs `status` so automation verifies and records the resulting state.

Automation and the manual fallback are mutually exclusive for one attempt. The
workflow must reconcile an already-submitted exact build rather than submitting
it twice.

Apple documents that submissions move through `Waiting for Review`, `In
Review`, and accepted or unresolved states. The workflow records state but does
not keep a runner alive while Apple reviews it.

### Google Play procedure

For Mentra App updates and future Starter Kit updates:

1. Ensure managed publishing is enabled before sending production changes for
   review.
2. Verify countries, device availability, release notes, declarations, and
   intended staged-rollout settings in Play Console.
3. Return to the CLI and request the store-submission transition.

After protected approval, automation promotes the exact accepted
internal-track version code into a production release, sends it for review,
reads back the release/version code, and records the review state. If a
human-only Play Console field blocks submission, the workflow links directly to
it and stops before committing the edit. The README then supplies the exact
**Review release** and **Send for review** fallback steps.

The operator waits until Publishing overview shows no changes in review and the
release is ready to publish. Do not click **Publish changes** until the final
public-release approval.

Google documents that review can take from hours to seven days or longer and
recommends at least a one-week planning buffer. Internal-track availability is
not proof that production review has completed.

### First public Starter Kit Android release

Google Play does not allow managed publishing or staged rollout for an app's
first public release. Therefore:

- complete internal and, if useful, closed testing before production;
- pass the Starter Kit store-readiness gate rather than treating successful
  installation as adequate product acceptance;
- complete all store listing and policy review work well before launch;
- begin the production release only during a staffed release period;
- accept that Google controls the approval time and that approval may make the
  first production release public without a separate managed-publishing hold;
- monitor continuously once submitted; and
- record the first-release exception explicitly.

This limitation must be visible in the README; the operator must not assume the
Starter Kit's first Android release has the same final button as a Mentra App
update.

## Phase 10: wait for and handle store review

The normal operator action while review is pending is:

```bash
./scripts/production-release.mjs status --release 3.1.0
```

The command prints each app/platform status, links directly to the relevant
store page, and says whether human action is required. A scheduled status
workflow may notify the release channel of changes; it must not auto-release.

### Apple rejection

1. Open **App Review** and the unresolved submission.
2. Read the guideline citation and message.
3. Reply with clarification or requested evidence when the binary is correct.
4. If only metadata is wrong, correct it and resubmit the same accepted build.
5. If code or packaged configuration must change, withdraw/reject that
   candidate, create a new numbered build, and repeat production-candidate
   acceptance before resubmission.
6. Record the rejection, response, and replacement relationship.

### Google rejection

1. Open Publishing overview and Policy status.
2. Record the rejected item and reason.
3. Correct metadata/declarations without changing the binary when possible.
4. Explicitly click **Send for review** again when Google does not resubmit
   automatically.
5. If the AAB changes, allocate a new version code and repeat candidate
   acceptance.

Store review waiting is not a Cloud incident. Cloud N+1 remains in production
serving Mobile N while review proceeds.

## Phase 11: approve public release

The release owner verifies:

- production Cloud has remained healthy through the review period;
- actual Mobile N compatibility evidence is still valid;
- exact candidate IDs match the approved submissions;
- no unresolved Apple or Google review item remains;
- release notes, support coverage, dashboards, and incident channel are ready;
- no unrelated store change is bundled into Publishing overview; and
- the release approver is available.

The operator runs:

```bash
./scripts/production-release.mjs release --release 3.1.0
```

The CLI displays all customer-facing effects and requests confirmation. A
second person approves the `production-store-release` GitHub environment. The
approved workflow records authorization but does not claim that approving a
GitHub environment released either store build. The operator performs the
exact manual-release actions below, then reruns the workflow. Read-only store
APIs must observe the exact public/rollout state before the promotion advances.

### Apple release

For each exact version in `Pending Developer Release`:

1. Open the version page.
2. Verify the exact build number one last time.
3. Click **Release This Version**.
4. Confirm.

Mentra App updates use Apple's phased release unless explicitly waived. The
Starter Kit's first version is released to all selected territories because
phased release applies only to updates.

### Google release

For existing apps under managed publishing:

1. Open Publishing overview.
2. Verify all intended changes are under **Changes ready to publish** and no
   unrelated change is included.
3. Click **Publish changes**.
4. Start the configured staged rollout for the exact version code.

For the first Starter Kit Android release, this phase may already have occurred
when Google approved the production submission. The workflow verifies and
records public state rather than clicking a nonexistent managed-publishing
gate.

## Phase 12: progressive rollout and completion

### Mentra App defaults

- iOS: Apple's seven-day phased release for automatic updates.
- Android: 10%, 25%, 50%, then 100%, with at least 24 hours at each step unless
  the active-device volume is too small to provide meaningful evidence.

Rollout advancement is evidence-based rather than purely time-based. Before
each Android increase, compare against the pre-release baseline:

- crash-free sessions and startup failures;
- authentication and session-exchange failures;
- Runtime connection and transcription failures;
- Bluetooth pairing/reconnect regressions;
- support reports and store reviews; and
- Cloud saturation, error rate, latency, and provider failures.

Exact numeric alert thresholds must be established from production baselines
before implementation. The initial design must not invent a percentage that
looks scientific but cannot detect a regression at Mentra's active-user volume.
An approver can accelerate rollout only with a recorded reason and healthy
evidence.

### Starter Kit

The first public release cannot use staged rollout on either store. Future
updates use Apple phased release and Google staged rollout by default.

### Completion

A promotion is complete only when:

- Cloud N+1 deployment identity is still observed in production;
- intended store versions are publicly available in selected territories;
- Android has reached the approved rollout target;
- Apple release state and phased-release state are recorded;
- public store pages resolve to the expected app/version;
- final artifacts, symbols, metadata, review ids, and evidence are assembled;
- production docs and release announcements reference the stable release; and
- the final immutable production manifest is published.

Submission, approval, or clicking release is not by itself completion.

## Operator CLI design

The repository provides one executable Node entrypoint:

```text
scripts/production-release.mjs
```

It is committed with the workflows and uses the GitHub CLI/API. It never reads
production secrets or calls Porter/App Store/Play directly from the employee's
machine.

`status` dispatches or reuses a short read-only server-side status workflow when
fresh store state is required. Store credentials remain in GitHub; the local
CLI consumes only the sanitized status record.

Required commands:

```text
start    Select and freeze a completed beta release.
status   Show completed evidence, external review state, blockers, and next action.
next     Dispatch the next safe automated phase.
attest   Submit structured human test evidence for one named gate.
release  Request the final public store-release approval.
advance  Request the next staged-rollout percentage.
abort    Stop the attempt and record why; never delete evidence.
watch    Follow the current short-running workflow without hiding its URL.
```

CLI requirements:

- refuse a dirty or wrong-repository checkout for source-sensitive commands;
- dispatch production workflows from `main`;
- resolve release inputs from the server-side promotion record, not free-form
  local environment variables;
- print exact side effects before confirmation;
- print and persist the resulting run URL;
- be safe to rerun after timeout or terminal interruption;
- never use shell `source`, export caller-shell variables, or retain secrets;
- support `--json` for automation and an interactive human default;
- make `status` and dry-run preparation read-only;
- refuse to skip required gates even if the caller uses GitHub's UI directly;
  and
- provide actionable errors with a README anchor.

For `attest`, the CLI validates the small structured JSON locally, uploads it as
an immutable GitHub release-evidence asset, verifies its digest, and dispatches
the attestation workflow with the asset identity. Larger logs and screenshots
must already be in an approved access-controlled evidence location and are
referenced by URL; they are not encoded into workflow inputs.

The CLI is a usability layer, not the security boundary. Every workflow
validates the same release state and authorization independently.

## Workflow decomposition

Do not hold one workflow open across device testing or external review. Use
small idempotent workflows with a shared validated record:

1. **Prepare**: select beta, freeze inputs, allocate coordinates.
2. **Compatibility lab**: create non-promotable N clients and accept human
   staging evidence.
3. **Cloud promotion**: validate production config, approve, deploy, and record.
4. **Current-client acceptance**: accept actual N-on-production evidence.
5. **Mobile candidate**: build, upload, and record both apps/platforms.
6. **Candidate acceptance**: accept exact store-delivered test evidence.
7. **Store submission**: submit exact candidates for review with release holds.
8. **Store release**: release approved builds after protected approval.
9. **Rollout**: advance/halt and finalize public evidence.

Each mutating workflow uses:

- `workflow_dispatch` on the default branch;
- a release identity input, with security-sensitive coordinates derived from
  the record;
- environment-specific concurrency with `cancel-in-progress: false`;
- least-privilege permissions;
- protected environment secrets available only after approval;
- exact source checkout;
- append-only result artifacts; and
- idempotent reconciliation of already completed external operations.

Production environment boundaries should be separate:

- `production-cloud`;
- `production-store-submission`; and
- `production-store-release`.

This separation makes approving Cloud deployment different from authorizing an
app submission or making an approved build public.

## Operator README design

The implementation must add:

```text
.github/production-release/README.md
```

The README is the canonical human procedure. It must be usable without reading
workflow YAML or this design document.

Required sections:

1. Purpose and supported release types.
2. Roles and access matrix.
3. One-time Apple/Google app bootstrap.
4. Before release week.
5. Release-day quick start.
6. Full numbered procedure matching every state-machine phase.
7. Exact CLI commands and expected output.
8. GitHub Actions UI fallback for every command.
9. iOS/Android device test checklists.
10. Apple processing, TestFlight, App Review, rejection, approval, manual
    release, and phased-release instructions.
11. Google internal testing, review, managed publishing, first-release
    exception, staged rollout, halt, and resume instructions.
12. Evidence templates and where results appear.
13. Stop conditions and decision owners.
14. Rollback and forward-fix procedures.
15. Status links, dashboards, incident channel, and escalation contacts.
16. Finalization and post-release review.

Screenshots may supplement the procedure but cannot be the only description;
store interfaces change. Each UI step must name the page, visible status, exact
button text, expected result, and what to do if it differs.

## Evidence model

Every phase emits a small immutable JSON record referencing the preceding
record's digest. The final manifest assembles the chain.

Required evidence includes:

- selected beta and source commits;
- current store release coordinates and source provenance;
- compatibility-lab build identities and declared differences;
- staging Cloud deployment identity;
- production configuration contract and safe probe results;
- production Cloud requested and observed image digests/revision;
- human tester, UTC time, device/OS/glasses versions, checklist result, and
  evidence links;
- production candidate artifact hashes, signing identities, store app ids,
  build ids, version codes, and internal groups/tracks;
- App Store submission/review/release ids and states;
- Play edit/release/review/managed-publishing/rollout states;
- rejection and replacement relationships;
- rollout metrics snapshots and approval actor; and
- final public URLs and observed versions.

Human evidence is submitted through an authenticated workflow so GitHub records
the actor. It must not contain test passwords, access tokens, personal customer
data, or raw production audio.

## Failure and recovery policy

| Failure point                                             | Default action                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Candidate Cloud or Mobile N staging compatibility fails   | Stop; fix staging; create a new beta when source changes                                                                         |
| Production configuration preflight fails                  | Do not deploy; correct production configuration and rerun preflight                                                              |
| Cloud deployment/readiness fails                          | Keep or restore prior Cloud revision; no mobile candidate build                                                                  |
| Actual Mobile N fails against production Cloud N+1        | Stop; roll Cloud back or forward-fix before any N+1 mobile upload                                                                |
| Mobile N+1 candidate fails                                | Leave Cloud N+1 if Mobile N is healthy; build a new numbered mobile candidate and retest                                         |
| Apple metadata rejection                                  | Correct metadata; reuse the same accepted build when Apple permits                                                               |
| Apple binary rejection                                    | New build number; repeat candidate acceptance and submission                                                                     |
| Google metadata/policy rejection                          | Correct and explicitly resend for review; preserve accepted binary when possible                                                 |
| Google binary issue                                       | New version code; repeat candidate acceptance                                                                                    |
| Mobile issue during staged/phased rollout                 | Halt rollout; forward-fix mobile or Cloud; do not assume store rollback                                                          |
| Cloud issue after Mobile N+1 reaches users                | Halt mobile rollout; forward-fix Cloud by default; Cloud rollback requires separately proven N+1 compatibility                   |
| First Starter Kit release issue after public availability | Stop announcements/availability where possible, publish a corrected version, and record that installed copies cannot be recalled |

Mobile app stores do not provide a dependable binary rollback for already
installed users. Rollout controls limit further exposure; they do not remove an
installed build.

## Security and safety requirements

- Production secrets exist only in protected environments and deployment/store
  systems.
- Workflows use short-lived, least-privilege credentials.
- Persistent macOS runners restore keychain state and delete temporary signing
  material even on failure.
- Promotion records never contain secret values or reusable credentials.
- Lab artifacts are technically non-promotable, not merely named “do not use.”
- Production candidates cannot be distributed automatically to broad beta
  groups.
- Every external mutation is verified by reading back exact ids and state.
- A conflicting existing app build, Cloud digest, or store attachment fails
  closed.
- Protected approvers see source, target, artifact ids, and prior evidence—not
  merely a green approve button.
- Emergency overrides require an incident id, named incident commander, and
  append-only reason; they cannot rewrite normal release evidence.

## Timing policy

### Before the planned public date

- At least one week before: verify store metadata, agreements, demo account,
  privacy declarations, countries, and reviewer access. Google explicitly
  recommends at least a one-week review buffer.
- Before Cloud promotion: selected beta, compatibility-lab evidence, production
  configuration preflight, approver, dashboards, and rollback owner are ready.
- After Cloud promotion: allow enough production observation with actual Mobile
  N before building/submitting N+1 candidates.
- Submit store candidates early and hold approved updates for the planned
  release window using Apple manual release and Google managed publishing where
  supported.

### Release window

- Do not schedule an ordinary release immediately before a weekend, holiday, or
  period without Cloud, mobile, and store coverage.
- Ensure an incident commander and someone able to halt both store rollouts are
  available.
- Do not promise a simultaneous first Starter Kit Android launch because its
  first Google production review cannot use managed publishing.
- Treat Apple/Google approval time as external and variable; the release date
  is chosen after approval, not predicted from submission time.

## Platform references

- Apple: [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- Apple: [add internal testers and builds](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- Apple: [App Review Guidelines, including completeness, reviewer access, and minimum functionality](https://developer.apple.com/app-store/review/guidelines/)
- Apple: [required App Review information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
- Apple: [submit an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/)
- Apple: [reply to App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/reply-to-app-review-messages/)
- Apple: [select manual or automatic release](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/)
- Google: [internal and closed testing](https://support.google.com/googleplay/android-developer/answer/9845334)
- Google: [managed publishing and review](https://support.google.com/googleplay/android-developer/answer/9859654)
- Google: [staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149)
- Google: [functionality, content, and user-experience policy](https://support.google.com/googleplay/android-developer/answer/9898783)
- GitHub: [manually run workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- GitHub: [deployment environments and required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

## Implementation context, not policy

The current repository already contains useful mechanics that implementation
may reuse after evaluating them against this design:

- guarded Porter deployment and observed Cloud digest evidence;
- exact-source release plans and manifests;
- App Store Connect API lookup/upload helpers;
- Fastlane Play upload/promotion helpers;
- signing credential injection and macOS keychain cleanup;
- TestFlight group assignment and build-state polling;
- existing Mentra App identifier `com.mentra.mentra`;
- existing Starter Kit iOS App Store id `6792839366` and production bundle id
  `com.mentra.bluetoothsdkexample`; and
- coordinated Starter Kit source and artifact provenance.

These are reusable components, not reasons to preserve today's ordering,
environment mapping, exact-beta mobile promotion, release holds, or checks.

## Acceptance criteria

Implementation is ready for its first real production promotion only when:

1. An employee who did not implement the workflows completes a tabletop dry run
   from the README and needs no undocumented instruction.
2. `status` always identifies the exact current state, blocker, external review
   status, and next safe action.
3. Lab builds are demonstrably impossible to promote to customers.
4. Mobile N is tested against candidate Cloud N+1 on both platforms.
5. Production configuration preflight catches a required key missing only in
   production without revealing values.
6. Production Cloud deployment can be rolled back before mobile release in a
   supervised exercise.
7. The actual App Store and Play Mobile N builds pass against production Cloud
   N+1.
8. Production Mentra App and Starter Kit candidates are rebuilt from frozen
   source, uploaded, and installed through their stores.
9. The exact accepted build ids/version codes are the only artifacts eligible
   for submission.
10. Apple and Google rejection simulations return to the correct state without
    losing or rewriting evidence.
11. Apple approval remains pending developer release until final approval.
12. Google managed publishing holds existing-app updates until final approval.
13. The first Starter Kit Android exception is explicitly tested and visible.
14. Android rollout can be halted and resumed without selecting a different
    version code.
15. Finalization verifies public store availability and observed production
    Cloud identity before declaring success.

## Follow-up implementation artifacts

After this design is approved, create an implementation plan covering:

- versioned Cloud configuration contract and validator;
- production promotion record schemas;
- compatibility-lab build lanes;
- protected environment and approval setup;
- production mobile build/upload lanes for both applications and platforms;
- store submission, status, release, and rollout integrations;
- `scripts/production-release.mjs`;
- `.github/production-release/README.md`;
- focused workflow-contract and idempotency tests;
- dry-run/tabletop fixtures;
- first Starter Kit Play record and store-listing bootstrap; and
- supervised first-release and rollback exercises.
