# Example App Screenshots

Captured on September 4, 2026 with physical Mentra Live glasses pointed at a
scene approved for the public README. Each image is an actual app screenshot
after requesting a new photo and displaying the returned preview, not a mockup
or a simulator capture.

| Screenshot | App and build | Hardware and delivery |
| --- | --- | --- |
| `native-macos.jpg` | AppKit source example, local macOS SDK from MentraOS PR #3929 | Apple silicon Mac; local HTTP webhook |
| `react-native-macos.jpg` | React Native macOS source example, local macOS SDK from MentraOS PR #3929 | Apple silicon Mac; local HTTP webhook |
| `native-ios.png` | SwiftUI example from PR #135 CI run `33930205674`, SDK `3.2.0-dev.116`; development-signed for installation | iPhone 15; phone photo receiver |
| `react-native-ios.png` | Installed React Native example `3.2.0` build `310000116`, SDK `3.2.0-dev.116` | iPhone 15; phone photo receiver |
| `native-android.png` | Kotlin/Compose example from PR #135 CI run `33930205674`, SDK `3.2.0-dev.116` | Galaxy Z Fold 6 cover screen; phone photo receiver |
| `react-native-android.png` | Released `mentra-example-react-native-3.2.0-dev.116.apk`, SDK `3.2.0-dev.116` | Galaxy Z Fold 6 cover screen; successful Bluetooth fallback to the phone photo receiver |

The Mac examples demonstrate native macOS support, not the iOS compatibility
mode available on Apple silicon. Their source override is needed until the
macOS SDK changes are published.

The ElevenLabs audio repro is not included in this photo gallery because it
does not implement photo capture.

The [iPhone automation brief](../../iphone-ui-automation.md) explains how the
iPhone accessibility tree and screenshots were captured over USB with XCTest
and WebDriverAgent.
