# Recorded Android setup fragments

These semantic Maestro fragments were exercised individually on the September 17 Razr/03BE fixture. Run only the fragment matching the currently visible screen. They are setup actions, separate from both the OTA and Call routines; they are not an unconditional reset or a fully qualified onboarding coordinator.

| Fragment              | English action                                                           |
| --------------------- | ------------------------------------------------------------------------ |
| `open-login.yaml`     | From the welcome screen, open Log In.                                    |
| `login.yaml`          | Enter the test account from environment variables and submit login.      |
| `open-pairing.yaml`   | From the glasses question, open Pair glasses.                            |
| `select-live.yaml`    | Select Mentra Live from the model chooser.                               |
| `select-03be.yaml`    | Select the specifically identified 03BE pair.                            |
| `confirm-pair.yaml`   | Confirm the Android pairing request only when its title identifies 03BE. |
| `continue-setup.yaml` | After Mentra Live connected, continue to the app's next setup stage.     |

Select the phone explicitly with `maestro --device PHONE_SERIAL test --test-output-dir PRIVATE_RUN_DIRECTORY FLOW.yaml`. Record the screen independently while executing these fragments, as described in `../../ANDROID.md`. Do not run concurrent `uiautomator dump` commands while Maestro owns UI automation.

Before pairing, independently match the USB glasses' serial and Bluetooth identity to the agreed fixture. The two `03BE` fragments intentionally name the qualified pair; changing them for another pair requires a fresh identity check. After pairing, require the shared BLE/Classic fixture check.

Login expects `MAESTRO_E2E_EMAIL` and `MAESTRO_E2E_PASSWORD` in the environment. Maestro can expand values into its command traces: keep those artifacts private and redact credentials before retaining or sharing traces. The other fragments require no credentials. No fragment clears app storage or removes bonds.

If Continue setup presents an update, switch to the separate OTA run. Do not append OTA steps to Call. The observed camera prompt actions are documented in `../../ANDROID.md`; subsequent runs should not request permission again when it is already granted.
