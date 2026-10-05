Routine authoring uses one collaborator-authored PR comment and one label:
`routine-work:create` or `routine-work:edit`. Existing `routine:<id>` labels still
request ordinary replay independently.

The comment must start with the marker below and contain only one JSON block.
Replace the source revision with the exact reviewed harness commit and choose an
enrolled host/lane. Describe product actions and complete expected results;
environment providers must already be configured on that host.

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
    "repository": "Mentra-Community/Mentra-Automated-Testing",
    "revision": "0000000000000000000000000000000000000000"
  },
  "target": {"hostId": "your-enrolled-host", "laneId": "your-android-lane"},
  "requirements": {"platform": "android", "glasses": [], "capabilities": [], "environment": []}
}
```
````

The trusted dev workflow selects the current same-repository PR's authenticated
published app build. Core freezes the brief, exact harness source, package pins,
originating PR head and target before host delivery. A retry reuses its work ID;
changing a brief, source, target or publication creates a new occurrence.

Automatic intake requires `ROUTINE_WORK_PR_DISPATCH_ENABLED=true`. The manual
`Request routine authoring` workflow on dev uses the same comment, label and API.
This gate is separate from ordinary replay's existing gate.

The machine acknowledges through `/api/internal/routine-work-deliveries` and owns
the job, lane reservation and held authoring lifecycle. Status updates trigger
`Publish routine authoring status`, which updates one bot-owned comment for the
same work. A queued receipt or completed held traversal does not imply an ordinary
passing result. Source review, installation and final verification remain machine
job states.

Direct machine `routine-work.submit` also accepts a frozen dev/staging package
without a PR origin. Those local jobs use `routine-work.inspect` for progress;
they do not create a Core delivery or PR comment. The manual GitHub workflow
described above is a PR intake entry point and still requires its brief and label.
