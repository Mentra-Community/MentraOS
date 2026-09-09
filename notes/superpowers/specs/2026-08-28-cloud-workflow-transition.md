---
status: active
owner: Mentra
---

# Cloud workflow transition and staging beta backend design

## Outcome

Replace the useful pre-merge validation previously supplied by Cloud V1
workflows, delete Cloud V1 workflow ownership without redirecting it to Cloud
V2, and make coordinated beta Mentra App builds from `staging` connect to the
staging Cloud V2 backend.

The work is split into three focused pull requests against `dev`:

1. Add deterministic Cloud V2 pull-request validation.
2. Delete Cloud V1 workflows and their orchestration references.
3. Change staging-triggered beta mobile builds from the production backend to
   the staging backend.

The pull requests must merge in that order. The design is based on the workflow
tree at `origin/dev` commit `80585dd0dec3b5b77c13be19fddeccd20e288144`.

## Decisions

### Validate Cloud V2 before merge without deploying it

One path-filtered `Cloud V2 Validation` workflow will run for pull requests into
`dev`, `staging`, and `main` when `cloud-v2/**`, `sdk/miniapp-cli/**`, or the
validation workflow changes. It will:

- install `cloud-v2` dependencies with the frozen lockfile and Bun `1.3.14`,
  matching the Cloud V2 deployment image;
- run the package tests under `cloud-v2/packages`;
- typecheck the Cloud V2 backend project references;
- typecheck and build Console, Admin, and Enterprise Portal;
- participate in `ci-gate-dev` and the PR-agent CI configuration.

Package tests run before TypeScript build output is generated so Bun does not
discover duplicate tests under ignored `dist/` directories. The workflow does
not start MongoDB or Redis and does not run `cloud-v2/tests`, whose integration,
soak, and external-service requirements need a separate design.

### Do not port `cloud-test`

The Cloud V1 `porter-cloud-test.yml` workflow deployed every qualifying PR merge
commit into one shared Porter application named `cloud-test`. It did not run
tests, check readiness, publish a preview URL, isolate PRs, or clean up. Its only
useful signal was that the Cloud V1 image could build and Porter could apply it.

Cloud V2 will not receive a `cloud-test` deployment or PR-preview replacement.
Pre-merge validation is local and deterministic. Post-merge coordinated Cloud V2
deployment already builds the image, waits for Porter, checks DNS, and requires
`/healthz` and `/ready` before mobile publication.

### Leave runtime smoke-test design alone

The old dev-to-main Cloud V1 workflow tested Live Captions, Mira, and
translation. Mira is obsolete, and Live Captions now runs locally on the phone.
Cloud Runtime transcription remains important, but an end-to-end transcription
smoke test would require product-level decisions about credentials, audio input,
provider cost, cleanup, failure policy, and the environment in which it runs.

No runtime smoke test is added by these pull requests. It is not a prerequisite
for merging `dev` into `staging`.

### Delete Cloud V1 workflows rather than redirecting them

The cleanup pull request deletes these 19 workflow files:

- validation and functional tests:
  - `augmentos_cloud_pr_dev_main.yml`
  - `cloud-build.yml`
  - `cloud-console-build.yml`
  - `cloud-sdk-build.yml`
  - `cloud-store-build.yml`
  - `cloud-tests.yml`
- China Cloud V1 deployment:
  - `china-deploy-static-websites-prod.yaml`
  - `china-deployment-prod.yml`
- Porter Cloud V1 deployment and test targets:
  - `porter-cloud-isaiah.yml`
  - `porter-cloud-test.yml`
  - `porter-debug.yml`
  - `porter-dev.yml`
  - `porter-prod.yml`
  - `porter-staging.yml`
  - `porter-stress.yml`
  - `porter-us-west.yml`
  - `porter-us.yml`
  - `porter_app_end-to-end-tests-prod_4689.yml`
  - `porter_app_live-captions-testing-monitor_4689.yml`

The validation pull request atomically replaces their names and path gates in
`ci-gate.yml`, `pr-agent-orchestrator.yml`, `.github/pr-agent.yml`, and
`.github/CI_GATE.md`. The cleanup pull request then deletes the 19 workflow
files only. It does not delete `cloud/` source code; that remains a later
repository cleanup.

The following are deliberately retained:

- coordinated Cloud V2 release and production-promotion workflows;
- `cloud-v2-pages.yml` for Console, Admin, and Portal deployment;
- Cloud V2 debug and Isaiah sandbox workflows;
- Local Merge dev/prod workflows;
- coordinated release-family checks;
- unrelated reusable or manual workflows, even if a later inventory may find
  additional cleanup candidates.

China is not mechanically ported. Cloud V2 documentation describes Alibaba OSS
as planned and China streaming as undecided, so a future China surface requires
its own regional design if the product still supports it.

### Staging beta mobile uses staging Cloud V2

`Coordinated Mentra Release` runs on every push to `dev` or `staging`. The
environment matrix becomes:

| Source branch                  | Cloud deployed   | Mobile backend embedded                | Mobile distribution            |
| ------------------------------ | ---------------- | -------------------------------------- | ------------------------------ |
| `dev`                          | Cloud V2 dev     | dev                                    | existing dev/internal channels |
| `staging`                      | Cloud V2 staging | **staging**                            | existing beta channels         |
| protected production promotion | Cloud V2 prod    | currently promotes selected beta bytes | production stores              |

For staging, both `EXPO_PUBLIC_CLOUD_CORE_URL` and
`EXPO_PUBLIC_CLOUD_RUNTIME_URL` are stamped to the staging regional endpoints,
and `EXPO_PUBLIC_BUILD_ENV` is `staging`. Android and iOS use the same mapping.

The reusable mobile workflow currently has only development and production
Doppler tokens. It uses the selected token only to fetch the public Sentry DSN;
the backend endpoints come from the checked-in environment generator. The
staging case will reuse `DOPPLER_TOKEN_MOBILE_PRD`, matching the existing
standalone mobile build behavior for distributable builds, without adding a new
secret or using Doppler to select the backend.

## Production-promotion incompatibility

The current production workflow promotes the exact Android and iOS beta bytes.
After the third pull request, those bytes contain staging endpoints. Promoting
them unchanged would publish a production app that still connects to staging.

Redesigning production promotion is explicitly outside these three pull
requests. Until that follow-up lands, operators must not promote a
staging-backed beta with the current exact-byte production workflow. The future
design must choose between rebuilding production-configured signed binaries or
making backend selection environment-neutral at runtime; merely changing the
promotion workflow cannot rewrite endpoints inside an already signed binary.

The current release record does not persist the embedded mobile backend, so a
future promotion design should also add verifiable backend identity to mobile
publication evidence and fail closed on an incompatible candidate.

## Trigger behavior after all three pull requests

### Pull requests

- Cloud V2 changes run `Cloud V2 Validation` for PRs into `dev`, `staging`, or
  `main`.
- `ci-gate-dev` aggregates that workflow for PRs into `dev`.
- No Cloud V1 build, test, shared test deployment, regional deployment, or China
  deployment workflow remains.

### Push to `staging`

- `Coordinated Mentra Release` runs unconditionally.
- It deploys the exact source to Cloud V2 staging and requires readiness.
- Its beta Android and iOS builds connect to Cloud V2 staging.
- Cloud V2 Pages deploy only when their existing website paths change.
- No Cloud V1 workflow runs because the files no longer exist in the resulting
  branch tree.

### Push to `main`

- No coordinated Cloud V2 backend production deployment runs automatically.
- Cloud V2 Pages retain their existing path-filtered production deployment.
- Production Cloud V2 remains owned by the protected manual production
  promotion workflow.
- External Mintlify and repository Pages settings remain outside this YAML
  design.

## Pull-request boundaries and merge order

| PR  | Scope                                                                       | Must not include                                                         |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Cloud V2 validation, atomic CI Gate/PR-agent replacement, design and plan   | deployments, Cloud V1 workflow-file deletion, mobile mapping             |
| 2   | Exactly 19 Cloud V1 workflow deletions                                      | `cloud/` source deletion, Cloud V2 sandbox deletion, runtime smoke tests |
| 3   | staging beta backend mapping plus contract/unit tests and policy-doc update | production-promotion redesign, new deployment owner, runtime smoke tests |

PR 2 depends on PR 1 providing the replacement Cloud V2 validation. PR 3 is
code-independent but merges third so the final branch state and operational
warning are reviewed after the workflow cleanup.

## Verification

PR 1:

- frozen Cloud V2 install;
- package tests only, excluding generated `dist` duplication and
  `cloud-v2/tests`;
- backend typecheck;
- all three website typechecks and builds;
- actionlint, pinned Prettier, and `git diff --check`.

PR 2:

- exact 19-file deletion assertion;
- repository search proving PR 1 removed every deleted workflow name from CI
  Gate and PR-agent configuration;
- actionlint on all surviving workflows;
- pinned Prettier and `git diff --check`;
- combined-tree audit proving Cloud V2 validation remains registered.

PR 3:

- environment-generator unit tests for beta-to-staging URLs and rejection of
  beta-to-prod mismatches;
- coordinated workflow contract tests for `staging -> staging` mobile mapping;
- both Android and iOS reusable jobs accept staging and select the intended
  Sentry-token source;
- the complete `.github/scripts/*.test.mjs` suite;
- actionlint, pinned Prettier, and `git diff --check`.

## Rollback

- PR 1 can be reverted without affecting any deployment.
- PR 2 can restore individual deleted workflow files from its parent commit,
  but Cloud V1 targets must not be re-enabled accidentally after `cloud/`
  deletion.
- PR 3 can restore `staging -> prod` mobile mapping if beta distribution must
  return to production services before the promotion redesign is ready. Cloud
  V2 staging deployment ownership remains unchanged either way.
