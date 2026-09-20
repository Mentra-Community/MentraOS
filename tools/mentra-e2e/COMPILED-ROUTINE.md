# Compiled no-glasses routine

Generated from `flows/no-glasses.ts`. Start signed in on English, unpaired home. Credentials are requested at runtime. Each numbered action/check has its own screenshot and video chapter.

1. **PRE-01** Verify the English, signed-in, unpaired home fixture. Expected: Pair glasses, Settings, and all-miniapps navigation are available; no miniapp or dialog is open.
2. **HOME-02-open** Open the all-miniapps sheet from home. Expected: The search field is exposed as an editable field and the close control is named.
3. **HOME-02-scroll-down** Scroll the all-miniapps list down by one page. Expected: The list remains open and its final Translation entry is accessible.
4. **HOME-02-scroll-up** Scroll the all-miniapps list back to its beginning. Expected: Captions, Gallery and the search field are available.
5. **HOME-03-search** Search the all-miniapps sheet for Settings. Expected: Settings is the only matching miniapp; Gallery and Captions are filtered out.
6. **HOME-04-empty** Search for the fixed nonsense query zz-e2e-no-miniapp-9147. Expected: The query remains visible and there are no matching Settings, Gallery or Captions entries.
7. **HOME-05-close** Close the all-miniapps sheet using its named accessibility control. Expected: The sheet and search field disappear; home returns without opening another miniapp.
8. **HOME-05-reopen** Reopen all miniapps and check whether the previous search was retained. Expected: The sheet reopens with the previously entered query unchanged.
9. **HOME-04-clear** Clear the search using the named Clear Search control. Expected: The search field becomes empty and Settings and Gallery return.
10. **HOME-06-from-list** Open Settings from the all-miniapps list. Expected: Settings opens with its capsule controls and the all-miniapps sheet closes.
11. **SET-02-profile** Open Profile in Settings and verify the designated test account. Expected: Profile Settings shows the test email and account actions.
12. **SET-03-open** Open Change Password without entering or submitting credentials. Expected: The current-password, new-password and confirmation fields are secure and visible.
13. **SET-03-back** Return from Change Password using Back. Expected: Profile Settings returns without changing credentials.
14. **SET-04-open** Open Change Email without requesting a verification email. Expected: The new-email and secure-password fields are visible.
15. **SET-04-back** Return from Change Email using Back. Expected: Profile Settings returns without an account change.
16. **SET-02-back** Return from Profile to the main Settings screen. Expected: The main Settings categories return.
17. **SET-05-open** Open Feedback from Settings without submitting a report. Expected: The feedback form exposes its expected-behavior and actual-behavior fields.
18. **SET-05-close** Close the Settings miniapp from its feedback form using the capsule close control. Expected: The feedback form closes and unpaired home returns.
19. **SET-06-settings** Reopen Settings after closing its miniapp. Expected: Settings opens at its main screen.
20. **SET-06-speech** Open Speech without selecting a model or starting a download. Expected: Speech opens and the captions-language section is visible.
21. **SET-06-scroll** Scroll the Speech language list down by one page without selecting a language. Expected: The voice-language section and additional languages are visible.
22. **SET-06-back** Return from Speech without changing language preferences. Expected: Main Settings returns.
23. **SET-07-open** Open Privacy without changing any operating-system permission. Expected: Privacy Settings opens with a privacy-policy entry.
24. **SET-07-back** Return from Privacy without granting permissions or opening an external page. Expected: Main Settings returns.
25. **SET-08-open** Open Miniapp Developer Settings without changing its preferences or loading a miniapp. Expected: The developer information, home-screen preference, and miniapp loading tools appear.
26. **SET-08-back** Return from Miniapp Developer Settings without changing its configuration. Expected: Main Settings returns.
27. **SET-10-home** Minimize Settings to leave one known miniapp available in the switcher. Expected: Home is visible and the Settings capsule is hidden.
28. **HOME-07-open** Open the running-miniapps switcher. Expected: The Settings card and named close control are accessible.
29. **HOME-07-select** Return to Settings from its running-miniapp card. Expected: Account settings is visible and the switcher is closed.
30. **HOME-07-minimize** Minimize Settings again. Expected: Home exposes its running-miniapps control.
31. **HOME-07-reopen** Reopen the running-miniapps switcher. Expected: Settings remains in the running list.
32. **HOME-07-close** Close the running-miniapps list. Expected: Home returns with the Settings card hidden.
33. **DEVICE-01-open** Open the glasses model selector from Pair glasses. Expected: Select Model and the supported glasses choices are visible.
34. **DEVICE-01-back** Return without choosing a glasses model. Expected: Unpaired home returns and the model selector is gone.
35. **APP-01-open** Open Gallery without glasses connected. Expected: The app explains that glasses must be connected to use Gallery.
36. **APP-01-close** Dismiss Gallery's glasses-required dialog. Expected: The dialog closes and home remains available.
37. **APP-02-open** Open Captions without glasses connected. Expected: The app explains that glasses must be connected to use Captions.
38. **APP-02-close** Dismiss Captions' glasses-required dialog. Expected: The dialog closes and home remains available.
39. **AUTH-11-settings** Open Settings before testing logout. Expected: Account settings is visible.
40. **AUTH-11-profile** Open Profile. Expected: The Log Out control is available.
41. **AUTH-11-scroll** Scroll Profile to the session controls. Expected: Log Out is visible.
42. **AUTH-11-open** Open the Log Out confirmation. Expected: The confirmation offers Cancel.
43. **AUTH-11-cancel** Cancel logout. Expected: Profile remains visible and the confirmation is gone.
44. **AUTH-12-open** Open Log Out again. Expected: The confirmation is visible.
45. **AUTH-12-confirm** Confirm logout. Expected: The authentication start screen replaces the authenticated UI.
46. **AUTH-02** Open Log In. Expected: Email and secure password fields are visible.
47. **AUTH-03-empty** Submit the empty login form. Expected: Local validation asks for an email address.
48. **AUTH-03-dismiss** Dismiss email-required validation. Expected: The email field remains empty.
49. **AUTH-04-enter** Enter a malformed email. Expected: The email field contains not-an-email.
50. **AUTH-04-submit** Submit the malformed email. Expected: Local validation asks for a valid email.
51. **AUTH-04-dismiss** Dismiss invalid-email validation. Expected: The login form returns.
52. **AUTH-05-enter** Enter the designated test account email without a password. Expected: The email field contains the test account.
53. **AUTH-05-submit** Submit with an empty password. Expected: Local validation asks for a password.
54. **AUTH-05-dismiss** Dismiss password-required validation. Expected: The login form returns.
55. **AUTH-06-open** Open Forgot your password without requesting an email. Expected: The Forgot Password form opens.
56. **AUTH-06-back** Return from recovery without sending an email. Expected: The login form is visible and recovery is gone.
57. **AUTH-07-back** Return to the authentication start screen. Expected: The start screen returns.
58. **AUTH-07-reopen** Open Log In. Expected: Email and secure password fields are visible.
59. **AUTH-08.1** Enter the designated test account email. Expected: The email field contains the designated account.
60. **AUTH-08.2** Enter the test account password in the secure field. Expected: The password field remains secure.
61. **AUTH-08.3** Submit Log In. Expected: The signed-in, unpaired account reaches the onboarding welcome screen.
62. **SETUP-01** Verify that first sign-in reached onboarding. Expected: Welcome to MentraOS and the setup choices are visible.
63. **SETUP-02** Open the glasses setup choices without selecting or connecting a device. Expected: The glasses model selector is visible.
64. **SETUP-03** Return without choosing a glasses model. Expected: The onboarding welcome screen returns.
65. **SETUP-04** Relaunch after leaving onboarding without a selected device. Expected: The authenticated home exposes Settings and Pair glasses.
66. **AUTH-10-settings** Open Settings after signing back in. Expected: Account settings is available.
67. **AUTH-10-profile** Verify the signed-in account identity again. Expected: Profile shows the designated account email.
68. **AUTH-10-close** Close Settings after verifying identity. Expected: Unpaired home returns.
69. **LIFE-02** Quit and reopen the same app normally. Expected: The stored session restores directly to unpaired home.
70. **END-01** Verify the final home state. Expected: Signed-in unpaired home is usable, with no test dialog, search sheet, or foreground miniapp.

Declared exclusions:

- **SET-09 — Appearance:** The consumer fixture hides Appearance; its absence is asserted on Settings. No theme change is made.
- **DEVICE-02 — Paired-disconnected coverage:** This fixture is unpaired. A separate paired device fixture is required.
- **APP-03 — Store details:** This build exposes the local all-miniapps sheet, covered by HOME-02 through HOME-06, rather than a store/detail surface.
