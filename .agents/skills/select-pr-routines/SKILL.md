---
name: select-pr-routines
description: Select relevant existing Mentra device routines and add their routine:* labels when opening or updating a MentraOS PR. Map changed behavior to recorded coverage, report gaps, and preserve hardware limits. This is PR test selection, not permission to start or reconfigure hardware.
---

# Select device routines for a PR

**Add the matching `routine:<id>` labels to the PR.** A label requests a test of
its CI artifact; it does not mean the test passed or authorize new hardware access.

## Find coverage

1. Read the PR diff and describe the behavior it changes. For an existing PR:

   ```bash
   gh pr view PR --repo Mentra-Community/MentraOS --json headRefOid,baseRefOid,labels,files
   gh pr diff PR --repo Mentra-Community/MentraOS
   ```

2. Discover current executable definitions through Core's authenticated
   `GET /api/internal/routine-catalog`, using the existing configured capability
   and caller client without printing credentials. It returns enrolled
   routine/platform pairs, including new definitions that have never passed.
   Admin's routine catalog shows latest recorded passing examples; use it to
   inspect evidence, not to exclude never-passed executable coverage.

   Read each selected definition's purpose, requirements, fixtures, platforms and
   named steps, then its `source.repository`, `source.revision` and `source.path`.
   The source is `routines/<id>/routine.ts` exporting `createRoutine(state)` in
   the private harness. Use a checkout at that exact revision or GitHub's contents
   API; do not substitute another local revision. The harness discovers `routines/`
   without a static registry. If API/private access is unavailable, report the
   specific coverage you could inspect and the missing enrollment/source evidence.

3. Select the smallest set whose actual steps exercise the changed behavior.
   Do not select every routine for shared SDK files. Trace the actual affected
   path. Mac evidence does not qualify Android-only or physical-iPhone behavior.
   A visibility change may need different coverage from a real meeting;
   report the gap instead of inventing a dispatch ID.
   If the PR intentionally changes an expected outcome, identify the conflicting
   step and propose a reviewed routine update. Selecting a relevant routine does
   not make its old assertions valid for a new behavior.

## Apply the labels and explain why

Build each label as `routine:<id>` from a selected enrolled definition. When
creating the PR, include its `--label` in the existing `gh pr create` command.
For an existing PR, set `selected_label` to that exact discovered label:

```bash
gh pr edit PR --repo Mentra-Community/MentraOS --add-label "$selected_label"
gh pr view PR --repo Mentra-Community/MentraOS --json labels,headRefOid
```

For the GitHub REST API, **POST appends** labels; do not use PUT to replace them:

```bash
gh api --method POST repos/Mentra-Community/MentraOS/issues/PR/labels \
  -f "labels[]=$selected_label"
```

Add only missing selected labels. Preserve unrelated and previously requested
labels; flag a stale routine label for the author rather than silently removing it.
In the PR's validation section, name each label and its covered behavior, separate
pending routine results from completed local tests, and list uncovered changes.
Skill/catalog-only edits need no device routine unless they also change covered
product behavior.

## Keep request status honest

- PR dispatch is off unless `DEVICE_ROUTINE_PR_DISPATCH_ENABLED` is explicitly
  enabled. Adding labels does not enable that gate. When enabled, the existing
  request workflow discovers enrolled definitions and submits exact PR build
  sources through `POST /api/internal/routine-dispatches`; Core resolves artifacts,
  freezes the current definition and routes to explicitly configured host/lane
  bindings. Check its request status and linked result. A queued, rejected,
  unavailable or unrecorded request is not a pass. After artifact publication,
  use the normal request workflow/Admin path for an authorized retry; do not
  toggle labels or repeatedly dispatch to overcome an explicit denial.
- Existing enabled coverage may run after labeling. For firmware/meeting tests,
  confirm the request fits the existing authorized fixture and finite attempt
  budget. If that authorization is unknown, defer adding the label and report
  the recommendation and missing prerequisite. Do not enable dispatch or increase
  limits. Installed provider capabilities and current ownership are checked by
  Core and the host controller; an
  authorized queued request need not wait for an idle device, and an unavailable
  fixture must be reported as pending/not-run rather than passed.
- No matching routine: state the gap. When asked to add coverage, use
  [create-routine](../create-routine/SKILL.md) to extend the closest readable flow
  on the shared setup/test/teardown foundation, or add independently selectable
  coverage. Enroll its supported platform definition before its label becomes a
  valid request; a recorded pass is required for the passing-example catalog,
  not for requesting the new executable definition on a PR.
- Public PRs contain coverage/status and approved result links, not credentials,
  account details, private logs, firmware assets or raw recordings.
