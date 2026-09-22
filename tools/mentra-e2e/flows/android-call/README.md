# Observed Android Call controls

These Maestro fragments preserve the controls exercised on the Razr in the September 17 recording. Use an explicitly selected phone (`maestro --device SERIAL test FILE`), in a run with recording and screenshots enabled.

- `open-form.yaml`: from Call home, open the unsubmitted New Call form. Does not create a meeting.
- `participants.yaml`: on the current owned call, open the roster. Its title changes with the count; the close action is stable.
- `leave.yaml`: on the current owned call with no sheet open, leave, observe the terminal screen, and return home. Verify native stream/hotspot teardown separately; this UI fragment does not retire the server meeting.

Do not run call fragments against an unrelated user's call. They perform no OTA. Meeting creation, fresh-SSID hotspot approval, guest admission, native cleanup and attempt accounting belong to the coordinator. The live routine remains unqualified until the replacement build passes admission and media checks.
