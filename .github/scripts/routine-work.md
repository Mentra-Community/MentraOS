Routine authoring uses one collaborator-authored PR comment and one label:
`routine-work:create` or `routine-work:edit`. Existing `routine:<id>` labels still
request ordinary replay independently.

The comment must start with the marker below and contain only one JSON block.
Core resolves current Harness main once by default. Add an exact source revision
or an optional `target` with an enrolled host and lane for a focused investigation. Describe product actions and complete expected results.
The current machine supervisor rejects nonempty `requirements.environment`;
use an empty array when no generic environment provider is needed, and report
unsupported prerequisites otherwise. Keep actual fixtures declared in the routine.

````markdown
<!-- mentra-routine-work:v1 -->

```json
{
  "schemaVersion": 1,
  "kind": "edit",
  "routineId": "email-sign-in-out",
  "brief": {
    "goal": "Verify email sign-in and sign-out",
    "stepsOrChanges": ["Verify the signed-in Home, sign out, then verify the sign-in screen"],
    "expected": ["The whole saved flow completes and normal cleanup restores readiness"]
  },
  "source": {
    "repository": "Mentra-Community/Mentra-Automated-Testing"
  },
  "requirements": {"platform": "android", "glasses": [], "capabilities": [], "environment": []}
}
```
````

The trusted dev workflow selects the current same-repository PR's authenticated
published app build. Core freezes the brief, exact harness source, package pins,
originating PR head and portable resource requirements before Actions selects a
compatible runner. The trusted issuer fills the basic app, recorder, phone and
requested glasses resource kinds. Optional `requirements.resources` declares
additional concrete fixture kinds and capabilities; environment descriptions do
not become routing labels. Core binds one real host and lane before host delivery. A retry reuses its work ID;
changing a brief, source, target or publication creates a new occurrence.

Automatic intake requires `ROUTINE_WORK_PR_DISPATCH_ENABLED=true`. The manual
`Request routine authoring` workflow on dev uses the same comment, label and API.
This gate is separate from ordinary replay's existing gate.

The machine acknowledges through `/api/internal/routine-work-deliveries` and owns
the job, lane reservation and held authoring lifecycle. Its first returned
reservation or repair handoff ends the Actions observer; later source review
continues without retaining an idle runner. Status updates trigger
`Publish routine authoring status`, which updates one bot-owned comment for the
same work. A queued receipt or completed held traversal does not imply an ordinary
passing result. Source review, installation and final verification remain machine
job states.

Direct machine `routine-work.submit` also accepts a frozen dev/staging package
without a PR origin. Those local jobs use `routine-work.inspect` for progress;
they do not create a Core delivery or PR comment. The manual GitHub workflow
described above is a PR intake entry point and still requires its brief and label.
