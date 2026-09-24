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

2. Read the existing issuer catalog, [device-routines.mjs](../../../.github/scripts/device-routines.mjs).
   It contains exact IDs/labels, coverage, related paths, prerequisites, exclusions
   and revision-pinned private definitions/implementations. Paths are search hints,
   not automatic selection rules. Search those definitions for the changed behavior
   and stable step IDs. Use a checkout at the linked revision or GitHub's contents
   API; do not silently substitute a different local harness revision. If private
   access is unavailable, use the catalog only for the coverage it explicitly states
   and disclose that detailed steps could not be inspected.

3. Select the smallest set that exercises the changed behavior. For example:

   | Changed behavior | Candidate label |
   | --- | --- |
   | Unpaired All Apps search, Settings navigation or existing-account sign-in | `routine:no-glasses` |
   | Customer update chaining or effective OTA manifest | `routine:day1-ota` |
   | Call admission, direct-link media, roster or meeting cleanup | `routine:mentra-call` |
   | Admin-only UI, unrelated backend logic, documentation | None unless a specific covered behavior also changes |

   Do not select every routine for shared SDK files. Trace the actual affected
   path. Mac evidence does not qualify Android-only or physical-iPhone behavior.
   A Call visibility-only change may need the private visibility suite rather than
   a real meeting; report that coverage gap instead of inventing a dispatch ID.
   If the PR intentionally changes an expected outcome, identify the conflicting
   step and propose a reviewed routine update. Selecting a relevant routine does
   not make its old assertions valid for a new behavior.

## Apply the labels and explain why

When creating the PR, include `--label routine:no-glasses` (substitute the selected
catalog label) in the existing `gh pr create` command. For an existing PR:

```bash
gh pr edit PR --repo Mentra-Community/MentraOS --add-label routine:no-glasses
gh pr view PR --repo Mentra-Community/MentraOS --json labels,headRefOid
```

For the GitHub REST API, **POST appends** labels; do not use PUT to replace them:

```bash
gh api --method POST repos/Mentra-Community/MentraOS/issues/PR/labels \
  -f 'labels[]=routine:no-glasses'
```

Add only missing selected labels. Preserve unrelated and previously requested
labels; flag a stale routine label for the author rather than silently removing it.
In the PR's validation section, name each label and its covered behavior, separate
pending routine results from completed local tests, and list uncovered changes.
Skill/catalog-only edits need no device routine unless they also change covered
product behavior.

## Keep request status honest

- Check the `Request device routine` workflow and its linked result. `no-artifact`
  means the matching CI artifact is not ready; after publication, use the normal
  request workflow/Admin path once if a retry is needed. Do not toggle labels or
  repeatedly dispatch to overcome an explicit denial.
- Existing enabled routines may run after labeling. For firmware/Call tests,
  confirm the request fits the existing authorized fixture and finite attempt
  budget. If that authorization is unknown, defer adding the label and report
  the recommendation and missing prerequisite. Do not enable a worker or increase
  limits. Current device readiness is checked by the worker at admission; an
  authorized queued request need not wait for an idle device, and an unavailable
  fixture must be reported as pending/not-run rather than passed.
- No matching routine: state the gap and propose an extension/new routine with
  English steps, assertions, setup, teardown, recovery and evidence. An absent
  routine must be registered and reviewed before its label becomes a valid request.
- Public PRs contain coverage/status and approved result links, not credentials,
  account details, private logs, firmware assets or raw recordings.
