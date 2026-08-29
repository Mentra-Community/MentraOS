---
status: active
owner: Mentra
---

# Cloud workflow transition implementation plan

**Goal:** Deliver three focused PRs that add Cloud V2 PR validation, delete
Cloud V1 workflow ownership, and point staging-triggered beta Mentra App builds
at Cloud V2 staging.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-28-cloud-workflow-transition.md`

## Research and design

- [x] Inventory workflow triggers from the `origin/dev` workflow tree.
- [x] Compare Cloud V1 capabilities with coordinated Cloud V2 deployment.
- [x] Confirm `cloud-test` was a shared real deployment, not a test suite or
      isolated PR preview.
- [x] Identify deterministic Cloud V2 package, backend, and website checks.
- [x] Find every CI Gate, PR-agent, and documentation reference to deleted
      Cloud V1 workflow names.
- [x] Trace `backend_environment` through the coordinator, reusable Android and
      iOS jobs, environment generator, contract tests, and production promotion.
- [x] Record the exact-byte production-promotion incompatibility as a required
      later design.

## PR 1: Cloud V2 validation

### Files

- `.github/workflows/cloud-v2-validation.yml`
- `.github/workflows/ci-gate.yml`
- `.github/workflows/pr-agent-orchestrator.yml`
- `.github/pr-agent.yml`
- this spec and plan

### Tasks

- [x] Add path-filtered PR validation for `cloud-v2/**`,
      `sdk/miniapp-cli/**`, and its workflow definition.
- [x] Pin Bun to the Cloud V2 deployment image version and use the frozen
      lockfile.
- [x] Run package tests before generated TypeScript output exists.
- [x] Typecheck backend packages.
- [x] Typecheck and build Console, Admin, and Portal.
- [x] Exclude runtime smoke tests, infrastructure-backed integration tests, and
      every deployment side effect.
- [x] Register the workflow with CI Gate and PR-agent orchestration.
- [x] Remove the replaced Cloud V1 workflow names and path gates from CI Gate,
      PR Agent Orchestrator, `.github/pr-agent.yml`, and `.github/CI_GATE.md`.
- [x] Run local validation.
- [x] Commit, push, and open PR 1 against `dev` as PR #3876.

## PR 2: Cloud V1 workflow cleanup

### Workflow deletions

- [ ] Delete the six Cloud V1 validation/functional workflows listed in the
      spec.
- [ ] Delete the two Cloud V1 China workflows.
- [ ] Delete the eleven Cloud V1 Porter workflows.
- [ ] Assert that exactly those 19 workflow files were removed.

### End-state verification

- [ ] Confirm PR 1 removed Cloud V1 workflow names from CI Gate, PR Agent
      Orchestrator, `.github/pr-agent.yml`, and `.github/CI_GATE.md`.
- [ ] Confirm Cloud V2 Pages, coordinated release/promotion, debug/Isaiah,
      Local Merge, and release-family checks remain.
- [ ] Validate the combined post-PR-1 tree, commit, push, and open PR 2.

## PR 3: Staging-backed beta mobile builds

### Coordinator and environment generator

- [ ] Change the `staging` branch channel output from
      `backend_environment=prod` to `backend_environment=staging`.
- [ ] Change beta environment validation from `beta -> prod` to
      `beta -> staging`.
- [ ] Assert staging Core/Runtime URLs and `EXPO_PUBLIC_BUILD_ENV=staging`.

### Android and iOS reusable jobs

- [ ] Accept `staging` in both backend-token selection blocks.
- [ ] Reuse `DOPPLER_TOKEN_MOBILE_PRD` only for the public Sentry DSN.
- [ ] Keep dev and production behavior unchanged.

### Tests and documentation

- [ ] Update environment-generator unit tests.
- [ ] Update coordinated workflow contract tests.
- [ ] Add a superseding policy note to the prior coordinated Cloud V2 design.
- [ ] Run the complete coordinated script test suite.
- [ ] Run workflow/static validation, commit, push, and open PR 3.

## Final audit

- [ ] Verify all three PRs target `dev` and describe their required merge order.
- [ ] Verify a resulting push to `staging` has one Cloud V2 backend deployment
      owner and produces staging-backed beta Android and iOS builds.
- [ ] Verify no Cloud V1 workflow remains in the combined tree.
- [ ] Report the production-promotion incompatibility without expanding this
      goal into its redesign.
