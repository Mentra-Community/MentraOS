# Live test activity

The Admin **Test runs** page shows GitHub's active private worker jobs above the recorded results. It includes PR labels, automatic dev/staging builds, nightly sequences and Admin dispatches. Host maintenance is identified separately; its outcome is never a routine verdict.

| Display | Source | Meaning |
| --- | --- | --- |
| Queued / waiting / running | GitHub Actions | Job activity, not proof of a test step |
| Build and routine | Published request ZIP from its exact Actions run/attempt | The selected build; unavailable metadata does not hide the job |
| Worker / fixture | Assigned GitHub runner and existing Core claim | Unassigned or unreported values remain explicit |
| Phase, step, action and counts | Last committed lifecycle journal checkpoint | Phase step counts and action counts stay separate; dynamic totals may be unknown |
| Recovery required | Original Core settlement | Cleared from the live view only by a correlated recovery result with verified return, passed teardown and a ready fixture |

Queued rows are displayed oldest first. This is waiting order, **not a guarantee of execution order**. Compatible workers and resource ownership still determine when GitHub can execute a job. There is no second scheduler, queue mutation, rank, ETA or calculated completion percentage.

The page refreshes every 15 seconds. A checkpoint older than two minutes is marked as having no recent update; this does not declare a failure. Provider errors retain explicit warnings and the last browser view. GitHub job details remain separate from routine checkpoints. The view caps each GitHub status listing at 100 runs and unsettled claims at 500, and warns when either limit is exceeded.

## Worker checkpoint contract

`PUT /api/internal/test-run-claims/:requestId/progress` uses the existing fleet claim bearer capability and the original execution owner's token. The body is strict and limited to 4 KiB:

```json
{
  "executionToken": "<original owner token>",
  "sequence": 22,
  "mode": "running",
  "phase": "test",
  "step": {"id": "walkthrough", "label": "Walk through the Mentra App"},
  "completedSteps": 0,
  "totalSteps": 1,
  "action": {"id": "open-settings", "label": "Open Settings", "completedActions": 7, "totalActions": null}
}
```

- Sequence comes from the durable lifecycle journal. Newer replaces older; identical retries do not refresh the server timestamp. A conflicting projection at the same sequence is rejected.
- Phase is one of `preflight`, `setup`, `test`, `final-assertions`, `teardown`, `return-verification`, `evidence`. Mode is `running`, `recovering` or `complete`.
- `step` can be null. `action` is optional and nullable. IDs are at most 160 characters; labels at most 240. Counts are 0–10,000, and cannot exceed a known total.
- Core stores `receivedAt`; client/device clocks do not decide freshness. The response contains only `accepted`, `sequence`, `receivedAt`.
- Recovery may update a `recovery-required` claim through the same owner. A terminal claim rejects newer checkpoints. Progress never changes a settlement or grants execution.
- No logs, errors, filesystem paths or credentials belong in the projection. The worker publisher must remain best effort and must not block lifecycle cleanup.

The old claim/get/settle response shapes are unchanged. Checkpoints are a separate field in `test_run_claims`; recorded result payloads remain immutable in `test_runs`. Existing history also displays `provenance.releaseIdentity` when the export has no top-level release.
