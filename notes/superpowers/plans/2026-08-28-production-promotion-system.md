---
status: completed
owner: Mentra
---

# Production promotion system implementation plan

> Execution checklist for the non-production implementation PR. No task in
> this plan authorizes a Cloud deployment, app-store upload, review submission,
> or public release.

**Goal:** Implement the approved production promotion design as a safe,
resumable, code-reviewed system that another employee can operate from the
repository README, while keeping all production mutations behind explicit
protected approvals for a later authorized release.

**Architecture:** A versioned Node state/evidence library validates an
append-only promotion chain. A local operator CLI dispatches small default-
branch workflows. Each workflow reloads and validates the current record,
reconciles one external phase, and appends evidence. Production Cloud, store
submission, and store release use distinct protected environments. Human
attestations bridge device testing without holding a runner.

**Tech Stack:** Node.js 24 standard library, GitHub CLI/API, GitHub Actions,
existing coordinated release helpers, Porter, Fastlane, App Store Connect API,
and Google Play.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-28-production-promotion-system-design.md`

---

## Phase 1: contracts and safety boundary

- [x] Add the promotion state, transition, evidence, and attestation contracts.
- [x] Add deterministic serialization and chain-digest verification.
- [x] Replace the obsolete one-shot production entrypoint with fail-closed,
      phase-specific workflows.
- [x] Prove PR events and dry runs cannot access production environments or
      mutate external systems.

## Phase 2: operator interface

- [x] Implement `scripts/production-release.mjs` commands from the design.
- [x] Make status/next-action output deterministic and actionable.
- [x] Make every mutating command print effects and require confirmation.
- [x] Add JSON output and idempotent dispatch behavior.

## Phase 3: workflow phases

- [x] Implement preparation and compatibility-attestation phases.
- [x] Implement production configuration preflight and protected Cloud phase.
- [x] Implement current-client and candidate acceptance phases.
- [x] Implement production mobile candidate build/upload phase.
- [x] Implement protected store submission, release, rollout, and finalization
      phases.

## Phase 4: employee runbook

- [x] Write `.github/production-release/README.md` with prerequisites, exact
      commands, expected states, UI fallbacks, stop conditions, rejection
      loops, rollout, and completion.
- [x] Add structured evidence templates for every human gate.
- [x] Document first-public Starter Kit exceptions and store-readiness gate.

## Phase 5: validation and delivery

- [x] Add unit and workflow-contract tests for transitions, authorization,
      idempotency, and non-production behavior.
- [x] Run all coordinated release tests, workflow syntax validation,
      formatting, and a tabletop dry run.
- [x] Commit only intended files and open a PR targeting `dev` with evidence.
