# Browsing an iPhone App from a Mac

We used [Appium WebDriverAgent](https://github.com/appium/WebDriverAgent) to
capture the physical-iPhone screenshots in this repository. A full Appium server
was not needed.

## How It Works

WebDriverAgent (WDA) is an XCTest UI-test runner, development-signed and installed
on the iPhone. It exposes the current app's accessibility tree, element actions,
coordinate taps, typing, swipes, and screenshots through a local HTTP API.
`iproxy` forwards Mac port 8100 to the runner's port 8100 over USB. The example
apps do not need an embedded automation server or source changes.

This is the iOS counterpart to reading Android's UI hierarchy and driving it
with ADB, but it requires Xcode, Developer Mode, a trusted/unlocked iPhone, and
Apple development signing/provisioning for the runner.

## Minimal Setup

Clone WDA into a temporary directory. Use your development team and the iPhone's
hardware UDID, not its separate CoreDevice identifier:

```sh
git clone --depth 1 https://github.com/appium/WebDriverAgent.git /tmp/WebDriverAgent
cd /tmp/WebDriverAgent
xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -configuration Debug -destination "id=$IPHONE_UDID" \
  -derivedDataPath /tmp/wda-build \
  PRODUCT_BUNDLE_IDENTIFIER=com.yourcompany.WebDriverAgentRunner \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY='Apple Development' -allowProvisioningUpdates test
```

Keep that process running. In another terminal, with `iproxy` installed:

```sh
iproxy 8100 8100 -u "$IPHONE_UDID"
```

Once `GET http://127.0.0.1:8100/status` reports ready, create a session for the
installed app. This example targets the React Native app distributed through
TestFlight:

```sh
curl -sS http://127.0.0.1:8100/session \
  -H 'Content-Type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"bundleId":"com.mentra.bluetoothsdkexample"}}}'
```

Use the identifier matching your installation:

| App | Bundle identifier |
| --- | --- |
| React Native from TestFlight | `com.mentra.bluetoothsdkexample` |
| React Native built from this repository | `com.mentra.bluetoothsdk.example.reactnative` |
| Native SwiftUI iOS example | `com.mentra.bluetoothsdk.example.ios` |

The coordinated TestFlight workflow overrides the React Native source bundle
identifier when building its release; these are intentionally different apps.

Use the returned `sessionId` with `GET /session/<id>/source` to retrieve XML
accessibility data. `POST /session/<id>/wda/tap` accepts `{"x":125,"y":800}`
in screen points; derive coordinates from a fresh tree, not screenshot pixels.
`GET /screenshot` returns a base64-encoded screenshot in `value`.

## Practical Notes

- Inspect the current tree before acting, especially after user interaction or
  navigation. Do not assume coordinates are stable.
- Only one example app should hold the glasses connection at a time. Terminate
  or disconnect the previous app before opening the next one.
- The real camera flow still runs normally: request a photo, wait for delivery,
  verify the preview, then capture the screen. WDA does not fabricate app state.
- Stop the test runner and USB proxy afterward, uninstall the temporary runner,
  and remove its temporary build files. Do not expose WDA to untrusted networks:
  it grants control over the phone's UI.

See Appium's [real-device provisioning guide](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/provisioning-profile/full-manual-config.md)
for signing and provisioning details. The app under test and the WDA runner have
separate signing requirements; WDA does not bypass iOS installation security.
