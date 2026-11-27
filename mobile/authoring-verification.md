# Autonomous Android routine authoring verification

This temporary pull request supplies an exact Android PR build for validating
the routine authoring service. It changes no Mentra App behavior and must remain
unmerged while the verification runs.

The requested machine-side edit targets `connected-settings-android`: clarify
`SETTINGS-01-open` so its English instruction identifies the Settings card on
Home and its expected result identifies Account settings plus the capsule's
minimize and close controls. Preserve all three existing step IDs, executable
checks and the connected Mentra Live prerequisite.

Verification requires the machine-owned authoring job to traverse the complete
saved flow, open an unmerged harness pull request, obtain an independent approval
on its exact head, run the ordinary routine against this PR's published Android
build, verify the published recording and restore its captured installation.
The originating PR receives progress and the final recorded run link. A source
edit, review approval or queued run alone does not qualify completion.

Keep this fixture open until that final result is available, then close it.
