# MentraOS Maestro Tests

This directory contains Maestro E2E tests for the MentraOS mobile app.

## Prerequisites

1. Install Maestro:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

2. Ensure you have a device/emulator running with the MentraOS app installed

## Running Tests

### Run all tests:

```bash
npm run test:maestro
```

### Run specific test:

```bash
maestro test .maestro/flows/01-auth-flow.yaml
```

### Run tests in CI mode:

```bash
npm run test:maestro:ci
```

## Test Structure

### Core UI Tests (No Hardware Required)

- `01-auth-flow.yaml` - Login/logout functionality
- `02-tab-navigation.yaml` - Bottom tab navigation
- `03-app-store.yaml` - Browse and install apps from store
- `05-no-internet-connection.yaml` - Offline error handling

### Simulated Hardware Tests

- `04c-pairing-without-microphone.yaml` - iOS and Android discovery with microphone access denied (signed in, no glasses paired)
- `04b-mentra-live-adaptive-scan.yaml` - Direct Mentra Live scan, timeout help, and in-place retry
- `04-simulated-glasses-pairing.yaml` - Pairing flow with simulated glasses (built-in feature)
- `06-launch-app-simulated-glasses.yaml` - Launch Mira app on simulated glasses

### Real Hardware Tests (Mentra Live and a Teams meeting)

Tagged `hardware`; they need a meeting link and fail fast without one.

- `99-call-stream-preview-lifecycle.yaml` - Mentra Call stream preview: join, show, 50 hide/show toggles, 10 minimize/reopen cycles, 3 page reloads, background and return, leave. Also the release memory gate. Run it with `scripts/stream-preview-run.sh android|ios "<meeting url>"`, which reloads the page through the WebView DevTools socket (Android debug builds) and pulls the `frame-preview` NDJSON run logs afterwards.
- `99-call-stream-preview-non-owner.yaml` - A CAMERA miniapp that does not own the meeting (`fixtures/stream-preview-probe`) is refused with `not_meeting_owner`, and Mentra Call keeps its preview.

### Helper Flows

- `helpers/login-helper.yaml` - Reusable login flow
- `helpers/stream-preview-join-call.yaml` - Open Mentra Call and join `MEETING_URL`
- `helpers/stream-preview-show.yaml` - Turn the Mentra Call preview on and wait for frames

## Environment Variables

- `MAESTRO_APP_ID` - App bundle ID (default: com.mentra.mentra)

## Writing New Tests

1. Create new `.yaml` file in `flows/` directory
2. Follow naming convention: `XX-test-name.yaml`
3. Add to `config.yaml` if needed
4. Use element IDs where possible for reliability
5. Use regex patterns for text that might vary

## Tips

- Use `takeScreenshot` to debug test failures
- Use `optional: true` for elements that might not always appear
- Use `runFlow` with `when` conditions for conditional logic
- Check `helpers/` for reusable flow components

## Troubleshooting

### Tests failing to find elements?

- Run with `maestro studio` for interactive debugging
- Check if element IDs are properly set in the app
- Verify text matches exactly (case-sensitive)

### Simulated features not working?

- Ensure simulated glasses option is available in the glasses pairing flow
- Check that the app can detect and connect to simulated devices

### Network tests failing?

- Some emulators don't properly support airplane mode toggle
- May need to manually test network scenarios

## Microphone denial regression

Run `maestro test -e MAESTRO_APP_ID=com.mentra.mentra .maestro/flows/04c-pairing-without-microphone.yaml`
on a signed-in iOS simulator or Android emulator starting at Home with no glasses paired. This sets
microphone access to denied and verifies that Mentra Live discovery opens.

Before resubmitting to Apple, verify on iPhone, iPad, and Android with the updated native build:

1. With microphone access undetermined, pair Mentra Live and simulated glasses.
   Neither pairing flow should request microphone access. Repeat with access denied.
2. With simulated glasses, launch a miniapp requiring microphone access (for example,
   Captions). Decline the system prompt. The miniapp must remain closed, Home must
   stay usable, and Settings must not open or be suggested immediately afterward.
3. On Android, also exercise repeated denial and "Don’t ask again"; neither should
   immediately suggest Settings. Try that miniapp again after access is blocked. Cancel the feature-specific Settings explanation and
   verify Home remains usable. Repeat and explicitly select Open Settings to verify
   that this is the only action that opens Settings.
4. Grant access and retry the miniapp; verify transcription starts. A miniapp without
   microphone requirements must still open when access is denied.
5. Open the fullscreen mirror without microphone access. Only attempting video
   recording should request access. Declining must leave the mirror usable.

## NIMO preparation and automatic connection

`04e-nimo-preparation.yaml` starts at an unpaired Home with no NIMO available. It
checks the opening instruction, iOS Settings step and foreground return, and
Android's direct discovery route. It does not establish hardware pairing.

For real-device qualification (no microphone permission needed):

1. iOS: open NIMO's arms and connect its main name (without `_BLE`) in Settings.
   In Mentra, choose NIMO and tap **They're open**. One available NIMO should
   proceed to the normal loading/handshake and **NIMO connected** automatically.
2. Repeat with NIMO initially disconnected. From **Connect your NIMO**, open
   Settings, connect the main device, and return. No continuation tap is needed.
3. Connect two NIMOs: **Choose your NIMO** must remain visible until a row is
   selected. Tap the chevron itself to confirm that the whole row works.
4. Leave the screen while discovery is pending. A late result must not navigate.
   With no result for a minute, **Scan Again** must retry in place.
5. Android: **Find my glasses** opens normal discovery without Apple Settings
   instructions. Select a NIMO by tapping the row's chevron and complete pairing.
6. Launch a display miniapp and verify its text on the glasses. Record platform,
   app revision, glasses firmware, connection logs and wearer confirmation.

Check the prep screens and login labels on a small Android screen with standard
and large font sizes. Labels should wrap without hiding words; bottom actions
and the Log In link must remain reachable by scrolling.

## Android login layout

`01c-login-layout.yaml` checks the Google label, Log In link and submit button,
organization sign-in action, and empty-email validation. Start signed in; the
flow uses the existing auth deep link without signing out or submitting credentials.
Run on a connected physical Android phone at standard and large system font sizes,
inspect the screenshots for clipped glyphs, then restore the original font size.

```bash
adb devices -l
maestro --device <phone-serial> test -e MAESTRO_APP_ID=com.mentra.mentra .maestro/flows/01c-login-layout.yaml
```
