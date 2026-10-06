---
name: select-pr-routines
description: Select device-test coverage when opening or updating a MentraOS PR. Request existing routine runs with routine:* labels, or request an edit or new routine through the PR authoring system when coverage needs to change. Use create-routine for machine-side authoring.
---

# Select or request routine coverage for a PR

Match coverage to the PR's behavior, then make the appropriate request:

| Coverage needed | Request |
| --- | --- |
| Existing steps already test the behavior | Add `routine:<id>` for ordinary replay of the PR build |
| An existing flow needs changed expectations or additional steps | Request `routine-work:edit` with an authoring brief |
| No suitable flow exists | Request `routine-work:create` with an authoring brief |

A request is not a passing test result. Docs-only changes need no device coverage.

## Find coverage

1. Read the PR diff and describe the behavior it changes. For an existing PR:

   ```bash
   gh pr view PR --repo Mentra-Community/MentraOS --json headRefOid,baseRefOid,labels,files
   gh pr diff PR --repo Mentra-Community/MentraOS
   ```

2. Read the private
   [Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing)
   through `gh`. Resolve its latest default-branch commit once, then list routines
   and read candidates at that SHA. This needs GitHub access to the repository,
   not Core/Admin credentials, and does not depend on a local checkout's branch
   or modify it with `git pull`:

   ```bash
   harness_repository=Mentra-Community/Mentra-Automated-Testing
   harness_branch=$(gh api "repos/$harness_repository" --jq .default_branch)
   harness_sha=$(gh api "repos/$harness_repository/commits" --method GET \
     -f sha="$harness_branch" -f per_page=1 --jq '.[0].sha')
   gh api "repos/$harness_repository/git/trees/$harness_sha?recursive=1" \
     --jq 'if .truncated then error("Incomplete routine tree; inspect directories individually") else .tree[] | select(.type == "blob" and (.path | test("^routines/[^/]+/routine\\.ts$"))) | .path end'
   ```

   The harness discovers `routines/<id>/routine.ts` without a static registry.
   Set `routine_path` to a discovered path and read its source:

   ```bash
   gh api "repos/$harness_repository/contents/$routine_path" --method GET \
     -f ref="$harness_sha" -H 'Accept: application/vnd.github.raw+json'
   ```

   Fetch imported helper paths with the same command and SHA too. The PR author
   inspects coverage and submits the brief; the assigned machine-side authoring
   agent makes routine edits.
   Read purpose, platforms, prerequisites, fixtures and ordered step IDs. Follow
   each candidate's actions into helpers to identify pages, clicked controls and
   assertions; the English description alone does not prove coverage. Report
   missing private repository access explicitly. Core/Admin credentials are not
   needed for this source inspection.

3. Select the smallest set whose actual steps exercise the changed behavior.
   Do not select every routine for shared SDK files. Trace the actual affected
   path. Mac evidence does not qualify Android-only or physical-iPhone behavior.
   A visibility change may need different coverage from a real meeting;
   report the gap instead of inventing a dispatch ID.
   If the PR intentionally changes an expected outcome, identify the conflicting
   step and request an edit rather than running known-invalid old assertions.
   Prefer extending a coherent existing flow over creating duplicate coverage.
   Explain which stable step IDs cover the PR; for an edit, name the insertion
   before/after an existing step and its expected outcome. A matching recorded
   example can corroborate behavior, but it may use an older source revision.

## Request existing coverage

Build each label as `routine:<id>` from the selected routine's declared ID. Source
inspection establishes intended coverage; the trusted request workflow checks
enrollment and supported platforms using its own configured Core credential.
A source file is not proof that its latest revision is installed. If the workflow
reports an unknown or unavailable definition, resolve enrollment with its owner;
if it selects an earlier revision, compare that source before claiming coverage.
Do not claim the request ran or substitute another routine. When creating the PR,
include its `--label` in the existing `gh pr create` command. For an existing PR,
set `selected_label` to that exact discovered label:

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

## Request an edit or new routine

Use the existing [PR authoring contract](../../../.github/scripts/routine-work.md)
and its JSON template. This dispatches machine-side work using
[create-routine](../create-routine/SKILL.md); the PR author does not need to reserve
hardware or implement another authoring workflow.

1. Choose `edit` for an existing `routines/<id>/routine.ts` at the selected harness
   commit, or `create` with a new stable ID absent at that commit. Pin
   `source.revision` to the exact reviewed **harness** SHA, not the MentraOS PR SHA
   or a moving branch. Describe the goal, changed or added English steps and
   observable expected results. For edits, name the affected step IDs and preserve
   the rest of the flow. The machine verifies the complete saved flow, not just
   the new step.
2. Choose an enrolled host/lane offering the required platform, glasses models
   and capabilities. Use an already configured target or ask its owner for the
   host/lane IDs and prerequisites. If Admin access is already available, its
   `GET /api/admin/test-runs/restoration/list` projection for host/lane IDs and
   platform can help, together with the configured lane's capabilities. Authoring uses
   `mac` or `android`; ordinary catalog/replay uses `ios-on-mac` or `android`.
   Current machine-side intake rejects nonempty `requirements.environment`.
   Use `[]` when no generic environment provider is needed; otherwise report
   the unsupported prerequisite. Preserve the routine's actual fixture needs.
   If access or a prerequisite is missing, explain exactly what is needed and
   ask the owner; do not invent IDs or erase requirements to admit the job.
3. Save the contract's comment to a file, replacing its example values. It must
   start with `<!-- mentra-routine-work:v1 -->` and contain exactly one JSON block
   with no surrounding prose. Keep credentials and private device/account data
   out of the public brief. The workflow supplies the current PR build and origin;
   do not put artifact URLs, tokens or build metadata into the comment.

   Validate the draft from the MentraOS checkout without dispatching:

   ```bash
   node --input-type=module - /private/tmp/routine-work-comment.md edit <<'JS'
   import {readFile} from 'node:fs/promises';
   import {parseRoutineWorkBrief} from './.github/scripts/routine-work.mjs';
   const [path, kind] = process.argv.slice(2);
   parseRoutineWorkBrief(await readFile(path, 'utf8'), kind);
   console.log('Valid routine-work brief');
   JS
   ```

   Use `create` as the last argument for a creation request. Validation checks the
   brief's schema; it does not prove host capabilities or source review.
4. On the open same-repository PR targeting `dev` or `staging`, first inspect its
   comments and labels. There must be **one marked brief and one authoring-kind
   label**. If no brief exists, post the file and add the missing matching label
   (`routine-work:edit` in this example):

   ```bash
   gh pr comment PR --repo Mentra-Community/MentraOS --body-file /private/tmp/routine-work-comment.md
   gh pr edit PR --repo Mentra-Community/MentraOS --add-label routine-work:edit
   ```

   The comment author must be a human account with repository access, verified
   through GitHub's collaborator permission endpoint. Comment association labels
   can vary by credential and do not establish access. An AI using that account's
   `gh` login works; a bot-authored brief does not. For an existing request, edit its comment
   by ID instead of posting a second brief. Read back the comment and labels.
   Ordinary `routine:<id>` labels can coexist for other relevant coverage.
5. Follow the request workflow and its updating status comment. Automatic intake
   uses `ROUTINE_WORK_PR_DISPATCH_ENABLED`, independently of ordinary replay's
   gate. When an authorized manual submission is needed, use the same intake:

   ```bash
   gh workflow run request-routine-work.yml --repo Mentra-Community/MentraOS --ref dev -f pr=PR
   ```

   Intake requires the current PR's published platform artifact. A
   `waiting-for-build` notice means nothing was submitted: the enabled automatic
   build callback, or the same manual intake after publication, submits the work.
   Changing the brief, source, target or build creates a new work occurrence.
   Review corrections should continue the existing machine job rather than
   redispatching by editing the brief. After source review and
   installation, require the linked ordinary passing run and recording before
   reporting coverage as verified. The machine owner installs and enrolls the
   resulting definition; request its replay through the ordinary label/workflow
   and report pending enrollment explicitly.

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
- In the PR's validation section, explain the selected replay/edit/create request,
  the behavior it covers and any missing prerequisite. A recorded pass is required
  for the passing-example catalog, not for requesting an enrolled executable
  definition. Queued authoring, source ready for review and installed source are
  progress states; they are not an ordinary test pass.
- Public PRs contain coverage/status and approved result links, not credentials,
  account details, private logs, firmware assets or raw recordings.
