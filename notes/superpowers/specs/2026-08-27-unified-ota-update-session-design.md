---
status: active
owner: Mentra
---

# Unified OTA update session design

## Outcome

After a user approves a Mentra Live update, every required APK, MTK, and BES
install pass is presented as one update session. An individual pass completing
must not claim that the whole update is complete. The flow reserves its success
checkmark, final installed version, accumulated changelog, and **Done** action
for the point where a fresh manifest check confirms that no additional update
is available.

## Current problem

The OTA coordinator intentionally checks the manifest again after every install
pass and automatically starts a newly offered pass. The UI currently exposes
the boundaries of that implementation:

1. An install pass renders **Update complete!**, **Your glasses are up to
   date**, a success checkmark, and the accumulated changelog.
2. After a short delay, the flow renders **Checking for updates**.
3. A subsequent pass starts, or an update offer is shown if Wi-Fi setup is
   required.

This sequence contradicts itself. It tells the user the journey is finished,
then resumes it. A multi-pass release can also expose the changelog before all
of the release's components have converged.

## UX principles

1. One approval starts one user-visible update session.
2. APK, MTK, BES, and manifest passes remain implementation details.
3. An intermediate pass completion is progress, not success.
4. The UI does not promise a step count because the number of passes is not
   known before each refreshed manifest check.
5. A percentage may reset for a new pass only after the copy establishes that
   an additional update is being installed.
6. The user is asked to approve the session once. The flow interrupts only
   when it needs an action such as Wi-Fi setup or encounters an error.
7. The changelog describes the complete starting-to-final release transition
   and appears only on terminal success.

## User flow

### Initial offer

The initial **Update Available** page keeps the existing release transition and
approval controls. It adds this expectation:

> Your glasses may install more than one update and restart several times. Keep
> them nearby until finished.

The existing downgrade explanation remains visible for required version
changes.

### Installation and continuation

Downloading, installing, restarting, and verification keep their existing
phase-specific pages and progress. When an install coordinator reports
`complete` while the auto-chain session is active, the headless controller
projects the semantic `finishing` screen instead of `complete`.

The stock page renders:

- Title: **Finishing your update**
- Message: **Checking whether your glasses need any additional updates.**
- Activity indicator; no success icon, changelog, or completion action

This same presentation remains visible while hotspot resources are torn down
and while the fresh manifest check runs, avoiding a flash between pages.

If another install is admitted, the coordinator starts it automatically. The
user may see its per-pass percentage, but it is introduced as a continuation of
the same update session rather than a new update journey.

### Wi-Fi intervention

If an additional pass cannot begin because the glasses require Wi-Fi, the
auto-chain session remains active while the existing Wi-Fi setup page is shown:

- Title: **WiFi Needed for Update**
- Message: **Connect your glasses to WiFi to install the update.**

Returning with Wi-Fi available resumes the already approved session. This page
does not offer **Later** because the user is already inside an update session.

### Terminal success

Only a successful refreshed manifest check with no remaining update ends the
session. The final page renders:

- Success checkmark
- **Update complete** when the user just completed a release transition, or
  **Up to Date** for a standalone manual check
- Final coordinated release version when available
- The accumulated changelog for the complete release range
- **Done** after a completed session, or **Continue** after a standalone check

The changelog is scrollable while the action remains outside its scrolling
area. If no release notes exist, the changelog section is omitted.

## Controller contract

`MentraLiveOtaScreen` gains a `finishing` state. It represents both the brief
install teardown after a pass completes and the refreshed manifest check that
follows it.

For an active session:

- Intermediate install `complete` projects `screen: "finishing"`.
- The auto-chain remains active through manifest checks and Wi-Fi intervention.
- `canFinish` and `canDismiss` are `false` during continuation.
- `changelogs` is empty until terminal `up_to_date`.
- `releaseTransition` may remain available as session context, but the stock
  continuation page does not render it.

For terminal success:

- The controller copies the active release range and changelogs into completed
  state before stopping the auto-chain.
- `screen` becomes `up_to_date` after the auto-chain ends.
- `completedUpdate` is `true` after an approved session reaches this terminal
  check; it does not depend on optional release metadata.
- `releaseTransition` and `changelogs` describe the full completed session.

## Failure and recovery behavior

Existing OTA safety behavior remains unchanged: duplicate offers, unapproved
downgrades, maximum-pass admission, disconnect timeouts, install failures, and
reboot-required failures still fail closed. An interrupted progress screen
without an in-memory auto-chain session may still expose the existing recovery
completion state because its prior approval and release range cannot be
reconstructed safely.

## Acceptance criteria

- An active pass completion never renders **Update complete**, **Your glasses
  are up to date**, a success checkmark, a changelog, or a completion button.
- The continuation presentation remains stable across install teardown and the
  refreshed update check.
- A subsequent admissible offer begins automatically without showing a second
  approval page.
- A Wi-Fi-blocked continuation retains the session and does not offer **Later**.
- Only the final no-update result renders the final version and accumulated
  changelog.
- A standalone no-update check still renders **Up to Date** without implying
  that an installation occurred.
- The public controller type, stock component, Mentra App translations,
  integration documentation, and focused tests describe the same behavior.
