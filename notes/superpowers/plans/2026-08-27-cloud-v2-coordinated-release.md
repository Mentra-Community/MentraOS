---
status: active
owner: Mentra
---

# Cloud V2 coordinated release implementation plan

> Execution checklist. Update this file as implementation lands.

**Goal:** Make a successful, evidence-bearing Cloud V2 Core/Runtime deployment
a hard prerequisite for publishing the corresponding coordinated Mentra App
release, while preserving the current branch targets and beta mobile's current
production-cloud configuration.

**Architecture:** One reusable workflow derives a guarded Porter target from a
release-plan environment, deploys an exact source commit, verifies public
readiness, and emits a deployment record. Dev/beta and production orchestrators
call it before their mobile jobs and include its result in final manifests.

**Tech Stack:** GitHub Actions, Porter, Bun, Node.js release-record scripts,
Cloud V2 Core/Runtime health endpoints.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-27-cloud-v2-coordinated-release-design.md`

---

## File map

| Path                                                       | Action                          | Responsibility                                                                  |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `.github/workflows/reusable-coordinated-cloud-v2.yml`      | Create                          | Guard target mapping, deploy exact source, verify readiness, emit evidence      |
| `.github/workflows/coordinated-release.yml`                | Modify                          | Call Cloud V2 for dev/staging and gate mobile/finalization                      |
| `.github/workflows/coordinated-production-promotion.yml`   | Modify                          | Deploy production cloud after approval/package gates and before store promotion |
| `.github/workflows/cloud-v2-dev.yml`                       | Delete or remove push ownership | Retire duplicate dev deployer after cutover                                     |
| `.github/workflows/cloud-v2-staging.yml`                   | Delete or remove push ownership | Retire duplicate staging deployer after cutover                                 |
| `.github/workflows/cloud-v2-prod.yml`                      | Delete or remove push ownership | Retire duplicate production deployer after cutover                              |
| `.github/scripts/coordinated-cloud-v2-records.mjs`         | Create                          | Validate and serialize deterministic deployment evidence                        |
| `.github/scripts/coordinated-cloud-v2-records.test.mjs`    | Create                          | Test record identity, environment, digest, and readiness validation             |
| `.github/scripts/assemble-coordinated-release-results.mjs` | Modify                          | Merge Cloud V2 evidence into prerelease results                                 |
| Production result/finalization scripts                     | Modify                          | Merge production Cloud V2 evidence into the stable manifest                     |
| `.github/scripts/coordinated-workflow-contract.test.mjs`   | Modify                          | Enforce cloud-before-mobile job dependencies and preserved environment mapping  |
| `cloud-v2/docs/runbooks/porter/deploys.md`                 | Modify                          | Document coordinated ownership, retry, manual repair, and rollback              |

Do not change `cloud/`, the Cloud V1 Porter files/workflows, or
`.github/workflows/cloud-v2-pages.yml` in this work.

---

## Phase 1: Deployment contract and reusable workflow

### Task 1: Define the guarded environment matrix

**Files:** `.github/workflows/reusable-coordinated-cloud-v2.yml`, record-script
tests

- [x] Accept only `dev`, `staging`, and `prod`; reject empty or arbitrary
      environment, app, and configuration values.
- [x] Derive Porter app, Porter file, cluster/project/deployment target, and all
      required hostnames from the checked-in matrix.
- [x] Validate `source_commit` and the release plan's source/release-set identity
      before any deployment side effect.
- [x] Preserve `dev -> cloud-dev`, `staging -> cloud-staging`, and protected
      production -> `cloud-prod`.
- [x] Keep mobile `backend_environment` as a separate field; assert staging
      remains `prod` in the workflow contract test.

### Task 2: Move the existing Porter deploy implementation

**Files:** `.github/workflows/reusable-coordinated-cloud-v2.yml`

- [x] Check out the exact full source SHA rather than an ambient branch head.
- [x] Pin the existing Bun and Porter setup behavior.
- [x] Run the existing environment Porter file with `porter apply -w` and the
      existing 45-minute bound.
- [x] Give deployments a shared per-environment concurrency group with
      `cancel-in-progress: false`.
- [x] Ensure secrets are scoped to the deploy job and are not written into the
      result artifact or step summary.

### Task 3: Make readiness fail closed

**Files:** reusable workflow, `cloud-v2/docs/runbooks/porter/deploys.md`

- [x] Require DNS resolution for every expected endpoint.
- [x] Probe `/healthz` and `/ready` for both Core and Runtime with bounded
      retries.
- [x] Remove the current warning-and-success path when DNS is absent.
- [x] Read back the deployed service image digest(s) and Porter deployment ID.
- [x] Document how operators inspect and roll back the recorded deployment.

### Task 4: Emit deterministic deployment evidence

**Files:** `.github/scripts/coordinated-cloud-v2-records.mjs` and test file,
reusable workflow

- [x] Create the schema from the design spec without secrets or mutable-only
      identifiers.
- [x] Require release set, source commit, environment, Porter target, observed
      digest, readiness results, completion time, and workflow provenance.
- [x] Reject a record with mismatched source, environment, release set, missing
      digest, or failed readiness check.
- [x] Upload the record under a stable result-artifact name and expose it as a
      called-workflow output.
- [x] For dry runs, emit `validated` evidence without a deployment ID/digest and
      never describe the environment as ready.

---

## Phase 2: Dev and beta orchestration

### Task 1: Add Cloud V2 to the prerelease plan

**Files:** `.github/workflows/coordinated-release.yml`, release-plan scripts if
the environment is persisted in `release-plan.json`

- [x] Add a `cloud_environment` plan output: `dev` for `dev`, `staging` for
      `staging`.
- [x] Leave the existing mobile backend mapping unchanged: `dev -> dev`,
      `staging -> prod`.
- [x] Include both values in the workflow summary so the staging exception is
      visible to operators.
- [x] Add validation that cloud and mobile environments cannot be accidentally
      conflated.

### Task 2: Gate prerelease mobile publication

**Files:** `.github/workflows/coordinated-release.yml`

- [x] Add a `cloud-v2` reusable-workflow job after `plan`.
- [x] Pass exact plan source, plan artifact, environment, and dry-run flag.
- [x] Add `cloud-v2` to `mobile.needs`; do not weaken existing OTA dependency.
- [x] Confirm no GitHub APK asset, TestFlight assignment, or Play prerelease
      upload can start when cloud deployment/readiness fails.
- [x] Retain parallel OTA/package/native work where dependencies allow it.

### Task 3: Add cloud evidence to prerelease finalization

**Files:** `.github/workflows/coordinated-release.yml`,
`.github/scripts/assemble-coordinated-release-results.mjs`, related tests

- [x] Add `cloud-v2` to `finalize.needs` and download its result artifact.
- [x] Merge Cloud V2 as a deployed component rather than a versioned package.
- [x] Fail finalization on release-set, source, or environment mismatch.
- [x] Include Porter app, observed digest(s), readiness time, and provenance in
      the completed manifest and job summary.

### Task 4: Retire duplicate branch deployers

**Files:** `.github/workflows/cloud-v2-dev.yml`,
`.github/workflows/cloud-v2-staging.yml`

- [x] Remove normal push deployment ownership only after coordinated dev and
      staging calls pass dry-run contract validation.
- [x] Delete the files or retain clearly named manual-only dispatchers that call
      the shared implementation; do not retain copied deploy steps.
- [ ] Ensure a manual dispatcher validates an explicit source SHA against the
      allowed branch and shares the environment concurrency group.

---

## Phase 3: Production orchestration

### Task 1: Add the protected production cloud job

**Files:** `.github/workflows/coordinated-production-promotion.yml`

- [x] Reuse the selected beta source commit that the plan proves reachable from
      `main`; never deploy the operator's ambient dispatch ref.
- [x] Run the production cloud job only after protected approval and the
      existing stable package/Engine-consumer gates.
- [x] Pass `prod`, the exact plan artifact, and the verified source to the same
      reusable workflow.
- [x] Keep the existing production Porter app, Doppler-synced env group,
      regional/global domains, and Porter config unchanged.

### Task 2: Gate store publication on production readiness

**Files:** `.github/workflows/coordinated-production-promotion.yml`, workflow
contract tests

- [x] Make the mobile promotion job depend on successful `cloud-v2`.
- [x] Prove Play production promotion cannot start before the cloud job.
- [x] Prove App Store submission/release flow cannot start before the cloud job.
- [x] On cloud failure, leave the selected beta artifacts and draft stable
      release intact for a safe retry.

### Task 3: Finalize production cloud evidence

**Files:** production result/finalization scripts and tests,
`.github/workflows/coordinated-production-promotion.yml`

- [x] Download and validate the production deployment record.
- [x] Include it in the stable release manifest and approval/final summary.
- [ ] Record the previous known-good deployment/digest needed for rollback where
      Porter exposes it.
- [x] Reject a production record that is not `cloud-prod`, is not ready, or does
      not match the verified selected release source.

### Task 4: Retire the independent production deployer

**Files:** `.github/workflows/cloud-v2-prod.yml`, production runbook

- [ ] Remove the `main` push deployer after one protected promotion proves the
      coordinated production path.
- [ ] Preserve a protected manual repair path through the reusable workflow if
      operations requires it.
- [ ] Confirm no main push and production promotion can race to write
      `cloud-prod`.

---

## Phase 4: Verification and cutover

### Task 1: Static contract tests

- [x] Run `node --test .github/scripts/coordinated-cloud-v2-records.test.mjs`.
- [x] Run `node --test .github/scripts/coordinated-workflow-contract.test.mjs`.
- [x] Run the existing coordinated release-script test suite.
- [x] Run `actionlint` on every changed workflow when available.
- [x] Run the repository-pinned formatter/checker on changed YAML, JavaScript,
      and Markdown files.

Required contract assertions:

- [x] dev calls cloud `dev` and mobile `dev`;
- [x] staging calls cloud `staging` and mobile `prod`;
- [x] production calls cloud `prod` only after approval/package gates;
- [x] every mobile publication job needs its cloud job;
- [x] finalizers require and validate cloud evidence;
- [x] dry runs have no `porter apply` side effect;
- [x] no retired push workflow still owns the same Porter target.

### Task 2: Non-production exercise

- [ ] Run coordinated dev dry-run and inspect the `validated` cloud record.
- [ ] Run one real dev release and confirm the Porter deployment/readiness
      completes before the first mobile job starts.
- [ ] Compare the recorded observed digest to Porter/Kubernetes readback.
- [ ] Exercise a controlled readiness failure and prove mobile publication stays
      skipped.
- [ ] Run one staging release and verify the summary clearly shows cloud
      environment `staging` and mobile backend `prod`.

### Task 3: Production cutover

- [ ] Verify selected beta source ancestry against `main` before approval.
- [ ] Confirm the approval summary names the exact cloud source, target, and
      mobile artifacts.
- [ ] Deploy and read back `cloud-prod`; verify regional/global `/healthz` and
      `/ready` endpoints.
- [ ] Confirm the first Play/App Store action starts only after readiness.
- [ ] Verify the public stable manifest contains exact cloud deployment evidence.
- [ ] Disable the independent production push deployer and document rollback.

### Task 4: End-state audit

- [x] Search workflows for every `porter apply` targeting `cloud-dev`,
      `cloud-staging`, or `cloud-prod`; each normal path must resolve to the
      reusable coordinated implementation.
- [x] Verify Cloud V1 workflows still point only to `cloud/` and were not edited.
- [x] Verify Cloud V2 Pages still has its independent path-filtered behavior.
- [x] Verify dev/beta APK and TestFlight publication, plus production store
      promotion, are all downstream of successful cloud evidence.
- [ ] Update this plan's status only after the first successful production
      cutover and archive it according to `notes/README.md` when complete.
