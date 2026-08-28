---
status: active
owner: Mentra
---

# Cloud V2 coordinated release deployment design

## Outcome

Cloud V2 Core and Runtime deployment becomes a required stage of the coordinated
Mentra release. The branch-associated cloud must deploy successfully and pass
readiness checks before that run can publish a Mentra App build.

This change moves the existing Cloud V2 deployment behavior into the release
orchestrators. It does not redesign which backend is embedded in each mobile
channel. In particular, the current beta built from `staging` continues to use
the production cloud.

## Scope

In scope:

- Cloud V2 Core and Runtime under `cloud-v2/`.
- The Porter applications and configuration already used by
  `.github/workflows/cloud-v2-dev.yml`, `cloud-v2-staging.yml`, and
  `cloud-v2-prod.yml`.
- Dev and beta publication in `.github/workflows/coordinated-release.yml`.
- Production store promotion in
  `.github/workflows/coordinated-production-promotion.yml`.
- Deployment evidence in the coordinated release result and final manifest.

Out of scope:

- The unused legacy Cloud V1 implementation under `cloud/` and its
  `porter-dev.yml`, `porter-staging.yml`, and `porter-prod.yml` workflows.
- Changing beta mobile from the production backend to the staging backend.
- Rebuilding production mobile binaries instead of promoting the selected beta
  binaries.
- Cloud V2 static websites deployed by `cloud-v2-pages.yml`. They are not a
  runtime dependency of the Mentra App and remain independently path-filtered.
- Debug and personal Cloud V2 environments.
- Redesigning Porter, Doppler, databases, domains, or regional topology.

## Preserved environment and publication matrix

Cloud deployment environment and mobile backend environment remain separate
release-plan concepts.

| Source / channel                            | Cloud deployed by this run                  | Mobile backend embedded today | Mobile publication gated by cloud                                        |
| ------------------------------------------- | ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `dev` / dev                                 | `cloud-dev` using `porter.dev.yaml`         | dev                           | GitHub APK, Mentra Dev TestFlight, and the existing Play internal upload |
| `staging` / beta                            | `cloud-staging` using `porter.staging.yaml` | **prod**                      | GitHub APK, Mentra Staging TestFlight, and the existing Play beta upload |
| main-approved stable promotion / production | `cloud-prod` using `porter.prod.yaml`       | prod                          | Play production promotion and App Store submission/release flow          |

For production, “main-approved” retains the coordinator's current rule: the
selected completed beta source commit must be reachable from `main` before the
protected production approval. The production cloud deployment uses that
verified release source, not the ref from which an operator happened to click
`workflow_dispatch`.

The staging row is an explicit temporary exception. The release proves that the
branch-associated staging cloud deployed, but the beta binary still connects to
production. This work must not claim that the staging deployment is the runtime
backend exercised by that beta. Selecting staging as the beta mobile backend is
a later policy change.

## Required ordering

The release invariant is:

```text
successful branch-associated Cloud V2 deployment
  + successful readiness verification
  + existing mobile prerequisites
    -> mobile publication may begin
```

“Mobile publication” means making a dev or beta APK available on the
coordinated GitHub release, assigning the iOS build to its TestFlight group, or
uploading to the existing Play prerelease track. For production it also means
moving the Android build to the Play production track and submitting/releasing
the iOS build through the App Store flow.

The first implementation gates the entire reusable mobile workflow, including
its build, because that workflow currently combines building and distribution.
This is slower than building in parallel and gating only upload, but it creates
one unambiguous dependency without a risky mobile-workflow split. A later
optimization may separate `mobile-build` from `mobile-publish` while retaining
the same publication gate.

Dev and beta flow:

```text
plan ──> cloud-v2 deploy + verify ───────────────┐
  ├──> OTA ──────────────────────────────────────┼──> mobile build/publish ──> finalize
  ├──> npm ──────────────────────────────────────┤
  └──> native SDK / Engine consumer ─────────────┘
```

Only the dependencies actually needed by mobile need to join its `needs` list;
npm and the external Engine consumer can retain their current parallelism. The
finalizer waits for and records both cloud and mobile results.

Production flow:

```text
verify selected beta and main ancestry
  -> protected approval
  -> stable package and Engine-consumer gates
  -> cloud-prod deploy + verify
  -> exact beta mobile store promotion
  -> finalize stable release
```

This preserves the existing production policy that public mobile store changes
start only after stable package verification, while adding the required cloud
gate immediately before mobile promotion.

## One reusable Cloud V2 deployment owner

Add `.github/workflows/reusable-coordinated-cloud-v2.yml` with
`workflow_call`. It owns the deployment implementation currently duplicated in
the three branch workflows.

Inputs:

- `source_commit`: full commit SHA to check out and deploy.
- `deployment_environment`: enum `dev`, `staging`, or `prod`.
- `release_plan_artifact`: coordinated release plan to validate.
- `dry_run`: validates without calling Porter or changing an environment.

Outputs:

- `result_artifact`: artifact containing `cloud-v2-deployment.json`.
- `deployment_environment` and `porter_app` for summaries.

The called workflow derives all security-sensitive target values from one
checked-in environment matrix. Callers do not independently supply Porter app
names, Porter files, domains, clusters, projects, or deployment-target IDs.

| Environment | Porter app      | Config                         | Required public endpoints                                                             |
| ----------- | --------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| dev         | `cloud-dev`     | `cloud-v2/porter.dev.yaml`     | `core.dev.us-west-2.mentraglass.com`, `runtime.dev.us-west-2.mentraglass.com`         |
| staging     | `cloud-staging` | `cloud-v2/porter.staging.yaml` | `core.staging.us-west-2.mentraglass.com`, `runtime.staging.us-west-2.mentraglass.com` |
| prod        | `cloud-prod`    | `cloud-v2/porter.prod.yaml`    | regional and global Core/Runtime production hosts                                     |

The workflow validates that the release plan's source commit and expected cloud
environment match its inputs. Production additionally consumes the source that
the production plan has already proven reachable from `main`.

## Deployment and health contract

For a real release the reusable workflow:

1. Checks out the exact `source_commit`.
2. Resolves and records the full SHA and short tag.
3. Sets up the pinned Bun and Porter versions already used by the existing
   workflows.
4. Runs `porter apply -w` with the environment's existing Porter file and waits
   for the rollout.
5. Resolves every required hostname instead of warning and continuing.
6. Requires both `/healthz` and `/ready` to return success for Core and Runtime.
7. Reads back the deployed image reference/digest and deployment identifier from
   Porter or the resulting Kubernetes workloads.
8. Writes and uploads deployment evidence.

The current “DNS missing; skip health checks” behavior is not sufficient for a
mobile publication gate. A coordinated run fails closed if an expected endpoint
cannot be resolved or made ready.

`porter apply -w` and the external probes serve different purposes: Porter
proves rollout completion inside the deployment platform; public `/ready`
proves the endpoints and their configured dependencies are reachable through
the path the app will use.

The minimum result record is:

```json
{
  "schemaVersion": 1,
  "component": "cloud-v2-core-runtime",
  "releaseSetId": "mentra-3.1.0-dev.123",
  "sourceCommit": "<full SHA>",
  "environment": "dev",
  "status": "deployed",
  "porter": {
    "app": "cloud-dev",
    "config": "cloud-v2/porter.dev.yaml",
    "requestedTag": "<short SHA>"
  },
  "observedServices": [
    {"service": "core", "digest": "sha256:...", "images": ["registry/cloud-v2:<short SHA>"]},
    {"service": "runtime", "digest": "sha256:...", "images": ["registry/cloud-v2:<short SHA>"]}
  ],
  "deploymentId": "<Porter deployment identifier>",
  "checks": [
    {
      "service": "core",
      "url": "https://core.dev.us-west-2.mentraglass.com/ready",
      "ready": true,
      "statusCode": 200
    }
  ],
  "completedAt": "<UTC timestamp>",
  "provenanceUrl": "<GitHub Actions run URL>"
}
```

If Porter reports one built image for both process types, the record may use one
digest with both service names. What matters is recording the observed immutable
deployment, not assuming that a short Git tag proves what is running.

For `dry_run: true`, the workflow validates the plan/environment mapping,
installs dependencies, runs Cloud V2 type checks, and verifies that the selected
Porter file exists and names the guarded application without deploying. Porter
does not expose a non-mutating `apply` validation mode, so dry runs must not
invent unsupported `porter apply` flags. The workflow emits a clearly distinct
`validated` record and must not claim readiness or an observed digest.

## Coordinator integration

### Dev and beta

`coordinated-release.yml` gains a `cloud-v2` job after `plan`:

- `dev` maps to deployment environment `dev`.
- `staging` maps to deployment environment `staging`.
- The existing `backend_environment` output remains `dev` for dev and `prod`
  for staging.
- `mobile.needs` gains `cloud-v2`.
- `finalize.needs` gains `cloud-v2`, downloads the cloud result artifact, and
  supplies it to the release-results assembler.

Cloud deployment does not need to wait for OTA or package publication. Those
jobs may continue in parallel. A cloud failure can therefore leave a draft or
partial non-mobile release, just as another failed required publication can
today, but it cannot expose a mobile build.

### Production

`coordinated-production-promotion.yml` gains a `cloud-v2` job after protected
approval and the existing stable package/Engine-consumer gates. It deploys
`prod` from the verified selected release source. The mobile promotion job then
needs `cloud-v2`, and the finalizer records the production deployment.

The production deployment is a real side effect and is never run before the
existing protected approval. If it fails, neither Play production nor the App
Store flow begins.

## Release records

Extend the release result assembler and manifest finalizer so Cloud V2 is a
coordinated deployed component, not a public SemVer package. The manifest must
record:

- source commit and release-set identity;
- environment, Porter app, and configuration path;
- requested tag and observed immutable image digest(s);
- deployment ID and workflow provenance;
- endpoints checked and readiness completion time.

Finalization fails if the cloud record's release set, source, or environment
does not match the plan. A dev record cannot satisfy staging, and an earlier
successful deployment cannot be silently reused for a different release set.

## Workflow ownership and cutover

At cutover, remove the push triggers from
`cloud-v2-dev.yml`, `cloud-v2-staging.yml`, and `cloud-v2-prod.yml`, or delete
those files after the reusable workflow is proven. Two workflows must not race
to deploy different builds to the same Porter application.

Normal deployment ownership becomes:

- coordinated dev release -> `cloud-dev`;
- coordinated beta release -> `cloud-staging`;
- protected coordinated production promotion -> `cloud-prod`.

If an emergency/manual redeploy is retained, it must be a thin dispatcher to
the same reusable workflow, require an explicit full source SHA, validate that
SHA against the environment's allowed branch, use the same per-environment
concurrency group, and use protected approval for production. It is an
operational repair path, not a second implementation or an alternate normal
release path.

Cloud V1 workflows are not redirected to Cloud V2 and are not included in the
coordinator. Their eventual deletion is a separate cleanup so this release
change cannot accidentally revive or mutate legacy infrastructure.

## Concurrency, retries, and rollback

- Use one deployment concurrency group per Cloud V2 environment across
  coordinated and manual callers.
- Do not cancel an in-progress deployment. This matches the coordinated
  release rule that an active publication completes while newer pending heads
  coalesce.
- A rerun checks out the same source commit and applies the same Porter config.
  Evidence is replaced only within the same GitHub run attempt; immutable
  release records remain identity-checked.
- If cloud deployment fails, mobile publication remains skipped.
- If cloud succeeds and mobile publication fails, retry mobile against the same
  recorded cloud deployment after rechecking readiness.
- Production rollback uses Porter's previous known-good deployment. Store
  publication stays blocked until the rollback is healthy or the intended
  deployment succeeds.
- A cloud deployment must remain backward compatible with the currently
  released mobile app because cloud and app-store rollout cannot be atomic.
  Database changes follow expand/migrate/contract rather than removing an old
  client contract in the same release.

## Acceptance criteria

- A dev coordinated run deploys and verifies `cloud-dev` before any dev mobile
  publication begins.
- A staging coordinated run deploys and verifies `cloud-staging` before any beta
  mobile publication begins, while the beta mobile environment remains `prod`.
- A production promotion deploys and verifies `cloud-prod` only after protected
  approval and before either mobile store action.
- Cloud failure or public readiness failure prevents GitHub APK, TestFlight,
  Play, and App Store publication for that run.
- The completed release manifest identifies the observed Cloud V2 deployment
  and its provenance.
- No independent branch-push workflow can race the coordinator for the same
  Cloud V2 environment.
- Cloud V1 and Cloud V2 Pages behavior is unchanged.
- Dry runs perform validation without deploying cloud or publishing mobile.

## Deferred decisions

- When beta mobile should switch from production to staging cloud.
- Whether mobile building should run in parallel with cloud and only its upload
  phase should wait.
- Whether Cloud V2 Pages and other cloud-adjacent services should join the
  coordinated release record.
- Whether production should promote one staging-built cloud image digest rather
  than build/deploy from the verified release source. That is a larger artifact
  promotion policy and is not needed to establish the deployment-before-mobile
  invariant.
