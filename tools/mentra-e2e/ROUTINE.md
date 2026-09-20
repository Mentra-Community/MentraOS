# No-glasses routine — English checklist

This is the Step 1 specification for the real Mentra App on an Apple Silicon Mac, with no glasses connected. The compiled routine contains **70 actions and checks**, with three consecutive deterministic passes on September 15, 2026. Exact run evidence is tracked in [README.md](README.md).

The exact executable order and expected outcome of every action are in [COMPILED-ROUTINE.md](COMPILED-ROUTINE.md), generated from `flows/no-glasses.ts` with `bun run tools/mentra-e2e/run.ts describe`. The broader checklist below retains the original coverage IDs. Replay starts signed in on English, unpaired home, exercises navigation first, then logs out, validates authentication, signs in again, and restores home. Credentials are supplied at runtime. Each executed action has a screenshot and video chapter.

All controls work through native accessibility. Missing semantics are app defects to fix and rebuild. Verified source fixes include the bottom sheet's individually accessible children and close action, the switcher's measured card container, the home tray, capsule and Back controls.

Observed contracts: search persists across sheet dismissal/reopening and Clear Search resets it; Gallery and Captions both show their specific glasses-required dialog; device settings and Appearance are hidden in the consumer unpaired fixture; the local miniapp list replaces the old separate store surface. Logout returns to authentication; this account's next sign-in reaches onboarding. Set up with glasses → model selector → Back → normal relaunch returns to unpaired home without scanning or choosing a model. A second relaunch restores home directly. These paths were replayed successfully; they do not imply paired-device or Phone Mode coverage.

### Preparation and authentication

1. **PRE-01 — Identify the target.** Locate the running Mentra window; record version, build, host, window size, display scale and source reference. Expect one unambiguous target and working capture/control.
2. **PRE-02 — Classify starting state.** Record signed-in/out state, locale, appearance and wearable profile when visible. Expect a recognized fixture; do not clear app storage, Keychain, or existing pairings.
3. **AUTH-01 — Reach the authentication start screen.** Use the existing screen, or the app's normal logout flow for the full auth scenario. Expect the email and existing-account entry points.
4. **AUTH-02 — Open Log In.** Expect the email field, secure password field and submit control. This transition was observed.
5. **AUTH-03 — Submit an empty form.** Expect the email-required validation, with no successful navigation. Dismiss it and expect the form again.
6. **AUTH-04 — Enter a deliberately malformed email and submit.** Expect local invalid-email validation. Dismiss it and clear the field; do not send repeated bad-password requests to the backend.
7. **AUTH-05 — Enter the designated account email with an empty password and submit.** Expect password-required validation. Dismiss it and remain on the form.
8. **AUTH-06 — Open Forgot your password.** Expect the recovery form. Return without requesting an email, and expect the login form.
9. **AUTH-07 — Return to the start screen and reopen Log In.** Expect both transitions to work. The return transition was observed.
10. **AUTH-08 — Sign in with the supplied test account.** Obtain credentials at runtime; keep the password masked. Expect successful authenticated navigation and no remaining login error. Do not treat disappearance of the form alone as success.
11. **AUTH-09 — Handle first-run onboarding explicitly if shown.** Record the visible path and its resulting wearable profile. Use only a verified ordinary UI path. If reaching home requires Phone Mode, record that profile and run its separate expectations; do not call it disconnected coverage. An unavailable disconnected start state is a fixture gap, not a pass.
12. **AUTH-10 — Verify identity.** Open Profile through Settings and verify it is the designated account; record visible build/backend information where available. Return to home. A cached name or account object alone is insufficient evidence of a usable session.

### Home and local navigation

13. **HOME-01 — Inspect the home screen.** Expect a settled miniapp grid and the connection/pairing presentation for the selected fixture. Persistent skeletons, a blank screen, or a false connected state fail.
14. **HOME-02 — Open the all-apps sheet.** Expect its search field and known built-in miniapps. Scroll down and back up through the list without leaving the sheet; then exercise search and clear.
15. **HOME-03 — Search for Settings.** Expect the matching built-in miniapp to remain visible and unrelated entries to be filtered.
16. **HOME-04 — Search for a unique nonsense string.** Expect no matching miniapps rather than stale previous results. Capture the actual empty presentation and clear the query.
17. **HOME-05 — Dismiss and reopen the sheet.** Expect home to remain usable and the observed search-reset/persistence contract to hold. Record that contract during discovery rather than assuming it.
18. **HOME-06 — Open Settings and return through the app's home/capsule navigation.** Expect the correct screen each way, with no duplicate overlay or trapped navigation.
19. **HOME-07 — Open the running-apps/app-switching surface and dismiss it.** Expect a valid empty/list state consistent with miniapps started by this run. Do not require a hard-coded count from an unrelated account fixture.

### Settings and account surfaces

20. **SET-01 — Open Settings and inspect its sections.** Expect all visible consumer sections: Profile, Feedback, Speech, Privacy and Miniapp Developer Settings for the consumer fixture, plus device settings only when applicable. Source currently hides the entire device section when no device is paired.
21. **SET-02 — Open Profile.** Expect the test identity and available account actions. Return and reopen to check navigation is repeatable.
22. **SET-03 — Open Change Password and return.** Expect the correct form and back navigation. Do not enter or change credentials.
23. **SET-04 — Open Change Email and return.** Expect the correct form and back navigation. Do not submit a change or send verification mail.
24. **SET-05 — Open Feedback and return.** Expect a usable feedback form. Do not submit a report, attach personal files, or send messages during the smoke routine.
25. **SET-06 — Open Speech.** Expect its captions-language and voice-language sections to settle into a valid state. Scroll and return without starting model downloads or audio capture.
26. **SET-07 — Open Privacy.** Expect permission-dependent rows and the privacy-policy entry consistent with the fixture. Return without changing OS permissions. A row for a permission already granted may correctly be absent.
27. **SET-08 — Open Miniapp Developer Settings.** Expect its information and supported controls. Return without installing a miniapp, scanning a QR code or changing server URLs.
28. **SET-09 — Exercise Appearance when enabled for this fixture.** Save the original theme, select another built-in theme, leave/reopen the screen and verify persistence, then restore and verify the original theme. Capture each change. A feature hidden by configuration is explicitly not applicable; an expected visible feature going missing fails.
29. **SET-10 — Recheck the settings/home transition.** Expect the original theme and navigable home. Record any preference restoration failure separately from the original test failure.

### No-glasses behavior and session lifecycle

30. **DEVICE-01 — Open the glasses-model selector from the unpaired home entry.** Expect the allowed model choices. Return before selecting a model or starting a scan; expect the unpaired home state to remain intact.
31. **DEVICE-02 — Inspect an existing paired-disconnected fixture, when configured.** Expect disconnected/reconnect presentation rather than connected status. Do not disconnect, forget or replace another fixture's pairing to manufacture this state.
32. **APP-01 — Open Gallery if present in the fixture.** Expect its valid local-content/empty state or the specified device-required presentation. Return without deleting, exporting or downloading media. Freeze the expected branch after first-run observation and source review.
33. **APP-02 — Open a designated glasses-dependent miniapp.** Choose and record one whose hardware requirements are known. Expect the specific glasses-required/incompatible UI and dismiss it; do not count a missing miniapp as a successful guard test.
34. **APP-03 — Exercise the miniapp browsing/detail surface if exposed by this build.** Open its observed entry point, search a fixed known fixture item, open details, and return. Freeze expected results against an identified catalog fixture. Do not assume the old Home/Store/Glasses/Settings bottom-tab layout or install/purchase anything.
35. **LIFE-01 — Verify operation while another app has desktop focus.** Perform the normal accessibility actions without activating Mentra or moving the pointer. Expect navigation and state checks to keep working. Do not force a focus change during a shared-desktop run. This is Mac coverage, not proof of iPhone background execution.
36. **LIFE-02 — Quit and reopen Mentra through normal application lifecycle.** Expect the stored session to restore and the correct home state to settle. Re-resolve PID, window and selectors after launch.
37. **AUTH-11 — Open Log Out and cancel once.** Expect the user to remain authenticated and Profile to remain accessible.
38. **AUTH-12 — Log out and confirm.** Expect the authentication start screen and no authenticated navigation from ordinary back actions. Do not claim server-side token revocation from this UI observation alone.
39. **AUTH-13 — Sign in again.** Expect the same account and fixture to load, leaving the app useful for subsequent testing.
40. **END-01 — Verify cleanup and finish.** Expect home, the original theme, no test dialogs, and the declared wearable profile. Finalize the report even if a prior step failed.

Optional branches are selected from a declared fixture before replay, not by making every assertion optional. A missing expected feature is a failure. Report not-applicable and unimplemented coverage by ID.

The first expansion within the no-hardware project is a separately recorded Phone Mode routine: enter through the real setup flow, verify its simulated status, exercise only designated local miniapps, stop it, and prove restoration. Other candidates are signup/workspace form navigation, supported local preference round trips, and populated Gallery fixtures. Actual messages, account creation/recovery, permission changes, media mutations and network-fault injection need explicit test fixtures and expected side effects before inclusion. Physical-glasses tests become a later lane using the same reporting format.
