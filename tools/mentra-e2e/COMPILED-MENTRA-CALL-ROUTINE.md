# Mentra Call paired UI routine

Start on paired English home with permissions granted, saved name Mentra Live, Direct link on, and 540p / 15 fps / Auto / 102° bottom. This routine preserves preferences and creates no meeting. Text editing and connected media are not qualified.

1. **CALL-UI-01-host** Verify paired host home is ready to open Mentra Call. Expected: The Call launcher is available and no miniapp is open.
2. **CALL-UI-02-open** Open Mentra Call from home. Expected: Join via Link, New Call and Settings are enabled.
3. **CALL-UI-03-settings** Open Call settings and inspect the saved call name. Expected: Settings is open and Name in calls is Mentra Live.
4. **CALL-UI-04-preferences** Verify the configured Direct link and Chat TTS states. Expected: Direct link is on; Chat TTS is off and disabled.
5. **CALL-UI-05-video** Reveal Bitrate using Auto's semantic scroll action. Expected: Auto and the unchanged 960×540, 15 fps, Auto bitrate, 102° bottom profile are visible.
6. **CALL-UI-06-back** Return from settings to Call home. Expected: Both meeting entry points are enabled.
7. **CALL-UI-07-join** Open Join via Link without joining. Expected: The empty link field and disabled Join Meeting action are visible.
8. **CALL-UI-08-leave-form** Leave the empty join form. Expected: Call home returns.
9. **CALL-UI-09-new** Open New Call without creating a meeting. Expected: The default meeting name is Mentra Call and Create & Join is enabled.
10. **CALL-UI-10-leave-new** Return from New Call without submitting it. Expected: Call home returns with no connecting state.
11. **CALL-UI-11-minimize** Minimize Call using the named capsule button. Expected: Host home returns and the Call home controls disappear.
12. **CALL-UI-12-reopen** Reopen Call from the host launcher. Expected: Call home is usable again without another permission prompt.
13. **CALL-UI-13-close** Close Call using the named capsule control. Expected: The host launcher returns and Call's controls disappear.
