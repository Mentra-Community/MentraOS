# Fable 5 Handoff - Engine Boundary Stack

Date: 2026-07-01

Current top branch: `codex/scope-glasses-status-boundary`

Top PR: https://github.com/Mentra-Community/MentraOS/pull/3276

## What Is The Engine?

The engine is the MentraOS runtime API that the host app should use. In this
stack it is implemented by the island package under `mobile/modules/engine` and
exported to `mobile/src` through typed facades.

The engine owns MentraOS behavior:

- normalized glasses runtime state
- pairing and reconnect readiness rules
- BLE/native event interpretation
- Wi-Fi and hotspot orchestration
- OTA checks and OTA runtime commands
- gallery sync and media runtime plumbing
- diagnostics and bug-report context
- Cloud V2 client calls for MentraOS core services

The host app owns OEM presentation:

- screens, routes, and navigation
- layout and branded copy
- buttons, dialogs, alerts, and empty states
- user choices such as "start update", "retry", "open settings", or
  "submit report"

The boundary we are enforcing is: host UI asks the engine for a typed read
model, event, or command. It does not import the raw glasses status store,
mutate runtime state, normalize SDK state, or shuttle internal state out of the
engine and back in.

## What We Are Doing

This stack moves MentraOS runtime logic behind engine facades so the host app
can become OEM-brandable UI rather than another owner of smartglasses OS state.

The work started with Cloud V2 incident reporting. The current top branch then
applies the same separation to glasses status, OTA, pairing, gallery network
plumbing, and dev/debug surfaces.

The important shape is:

```text
mobile/src UI
  -> engine facades exported by mobile/modules/engine
      -> island services, stores, Bluetooth SDK, native modules, cloud-client
```

The host should not reach around the engine into island internals, Bluetooth
SDK internal event stores, or Cloud V1 device-state sync.

## Stack Map

The PR stack is currently:

1. `aisraelov/island-namespace-wifi`
   - PR: https://github.com/Mentra-Community/MentraOS/pull/3167
   - Base: `dev`
   - Purpose: broad island/engine namespace work, moving more host runtime
     functionality into the island package.
   - Current live GitHub state when this doc was written: conflict exists
     against `dev`. Resolve this first when babysitting the stack.

2. `codex/migrate-incidents-cloud-v2`
   - PR: https://github.com/Mentra-Community/MentraOS/pull/3268
   - Base: `aisraelov/island-namespace-wifi`
   - Purpose: migrate incident/feedback/bug reporting to Cloud V2 reports and
     route mobile submission through the engine/cloud-client boundary.
   - Current live GitHub state when this doc was written: mergeable, checks not
     fully green yet.

3. `codex/scope-glasses-status-boundary`
   - PR: https://github.com/Mentra-Community/MentraOS/pull/3276
   - Base: `codex/migrate-incidents-cloud-v2`
   - Purpose: remove host-side leaks of glasses runtime state and route glasses,
     OTA, pairing, gallery, and devtools usage through engine facades.
   - Current live GitHub state when this doc was written: mergeable, checks not
     fully green yet.

## Incident Reporting Baseline

Cloud V2 reports are the clean-sheet replacement for Cloud V1 incidents.

The current decision is that bug reports, feedback, and automatic runtime
reports are all one Cloud V2 reporting primitive. "Incident" and "feedback" are
not separate concepts in the new design.

Host UI calls the engine report surface for manual user submission. The island
engine owns the internal details:

- collecting phone state, logs, and runtime diagnostic context
- attaching artifacts, including glasses logs
- calling `cloud-v2/packages/cloud-client`
- telling glasses to upload logs where needed
- filing automatic reports from runtime-owned failure detection

Cloud V2 report routes live under `/api/client/reports`. There is intentionally
no compatibility alias such as `/api/incidents` in Cloud V2.

## Glasses Status Boundary Baseline

Before this stack, `mobile/src` had direct or semi-direct access to glasses
runtime state. In practice that meant host UI could inspect `GlassesStatus`,
status stores, compatibility projections, hotspot details, OTA status, and
pairing state.

That was the wrong shape for OEM UI. The host was learning details of the
MentraOS runtime, then passing those details back into services or rendering
based on internal state that should not be part of the app branding API.

The current top branch replaces that with smaller surfaces:

- `engine.glasses` for product/status read models and readiness snapshots
- `engine.pairing` for pairing and reconnect flows
- `engine.ota` for update check/progress/runtime OTA commands
- `engine.gallery` for gallery network/media runtime plumbing
- `engine.dev` for debug read models and engine-owned developer screens

The goal is not to create a new public `GlassesStatus` type. The goal is to
avoid needing one.

## Important Decisions To Preserve

- Do not add a generic "replacement GlassesStatus" facade.
- Do not expose raw island stores to host UI.
- Do not expose hotspot credentials, hotspot IP, or low-level network internals
  unless a specific host screen truly needs a sanitized read model.
- Do not wrap the entire Bluetooth SDK just to hide it. The Bluetooth SDK is a
  standalone lower-level product and should continue to expose low-level
  connection data to SDK consumers.
- Engine facades should add MentraOS runtime semantics, not duplicate SDK data.
- Debug/dev screens are allowed to live in and be exported by the engine. They
  are not OEM surfaces.
- Cloud V1 remnants should not make the new engine API more complicated.
- Cloud V1 device-state/app sync is not being ported just to preserve old
  miniapp behavior. Cloud V1 miniapps were removed from the home screen.
- BLE command names on glasses can keep legacy wording like "core token" when
  that is what the glasses protocol already calls it, but the value synced going
  forward should be the Cloud V2 user auth token where relevant.

## What Changed In The Top Branch

The top branch added engine facades and moved host callers onto them:

- `mobile/modules/engine/src/facades/glasses.ts`
- `mobile/modules/engine/src/facades/pairing.ts`
- `mobile/modules/engine/src/facades/ota.ts`
- `mobile/modules/engine/src/facades/gallery.ts`
- `mobile/modules/engine/src/facades/dev.ts`

It added runtime services/projections inside island:

- `GlassesStatusProjection`
- `GlassesReadiness`
- `ConnectionCoordinator`
- `DeviceEventRouter`
- `OtaService`
- `OtaUpdateCheckService`
- `RestComms`

It converted host UI and app services to consume engine snapshots/commands
instead of raw runtime state. The broad areas touched are:

- home/status UI
- settings device status
- pairing and reconnect routes
- OTA update check/progress routes
- gallery screen/network monitoring
- developer/debug tools
- mobile service bootstrap and event handling

It also added a guardrail:

- `scripts/check-mobile-runtime-boundary.sh`
- `mobile/boundary-allowlist.txt`

That script is intended to catch new host imports of raw engine/internal
runtime state. The allowlist is not a policy ideal; it is the current migration
state.

## Recent Babysitting Decisions

These are worth preserving because they came out of review/conflict work:

- The host should use package imports such as `@mentra/bluetooth-sdk/internal`
  where that package surface exists. Avoid deep relative imports across package
  boundaries.
- Stale host-side OTA availability projection was removed. The view should not
  keep pretending there is a separate `ota_update_available` source if the
  engine is the owner of update availability.
- The OTA disconnect guard behavior was preserved. We deferred a deeper
  `checkForOtaUpdate` behavior change because it would have changed view
  behavior beyond the review item.
- OTA request errors now include the manifest URL for debugging.
- Legacy Cloud V1 battery websocket forwarding was removed after confirming
  Cloud V1 apps are gone.
- A hydration race in glasses status projection was guarded.

## Known State And Watchouts

Start babysitting from the bottom of the stack:

1. Resolve and validate PR #3167 against `dev`.
2. Rebase/validate PR #3268 on the updated #3167 branch.
3. Rebase/validate PR #3276 on the updated #3268 branch.

Do not assume a green top branch means the bottom branch is ready. At the time
this handoff was written, #3167 was still conflicting against `dev`.

The top branch is documentation-heavy and touches many mobile files. Be careful
not to absorb unrelated dirty workspace changes while rebasing or resolving
conflicts.

If a conflict offers a "shim" that simply re-exports raw island state to keep
host imports alive, treat that as scaffolding to review, not as the final
architecture. Some compatibility shims were acceptable during conflict
resolution only because they preserved behavior while the boundary work was
being split into reviewable commits.

## Where To Look First

Read these docs in order:

1. `cloud-v2/docs/issues/019-incident-reporting-migration/README.md`
2. `cloud-v2/docs/issues/020-glasses-status-boundary/README.md`
3. `cloud-v2/docs/issues/020-glasses-status-boundary/implementation-plan.md`
4. This handoff doc

Then inspect these code areas:

- `mobile/modules/engine/src/facades/`
- `mobile/modules/engine/src/services/`
- `mobile/src/services/core/`
- `mobile/src/app/`
- `mobile/src/components/`
- `mobile/src/pages/`
- `scripts/check-mobile-runtime-boundary.sh`
- `mobile/boundary-allowlist.txt`

## Validation Commands

Useful branch and PR checks:

```bash
git status --short --branch
git log --oneline origin/codex/migrate-incidents-cloud-v2..HEAD
gh pr view 3167 --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,url
gh pr view 3268 --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,url
gh pr view 3276 --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,url
```

Useful boundary checks:

```bash
./scripts/check-mobile-runtime-boundary.sh
```

Useful mobile checks, depending on the changed area:

```bash
cd mobile
bun run compile
bun run test -- glassesFacade
bun run test -- ota
bun run test -- pairing
```

Use the repo scripts for Android compile checks if native/SDK surfaces are
touched:

```bash
./scripts/check-android-compile.sh bluetooth-sdk
./scripts/check-android-compile.sh asg
```

## Suggested Follow-Up Work

For Fable 5, the highest-value follow-up is not to invent new engine API. It is
to keep reducing host access to runtime details while preserving the simple
mental model:

- host renders OEM UI
- engine owns MentraOS runtime behavior
- Bluetooth SDK remains the lower-level customer SDK
- Cloud V2 owns new core web services

Specific next work:

- babysit the three PRs bottom-up until all are mergeable and green
- review remaining allowlisted imports and decide which are true host needs
- continue Cloud V1 removal by feature, especially sign-in/sign-up SSO
- do the same host/engine separation review for gallery behavior
- avoid temporary Cloud V1 compatibility concerns when designing new Cloud V2
  engine APIs

