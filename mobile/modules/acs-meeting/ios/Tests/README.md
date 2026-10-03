# Native session concurrency tests

These XCTest cases exercise the actual `AcsMeetingSession`: concurrent snapshot,
mute, audio-source and leave commands, acknowledgement ordering, and roster
teardown. They do not create a meeting or capture media. Real SDK participant
arrival and departure still need device qualification.

Use the provisioned mobile iOS workspace (`bun install`, Expo prebuild without
`--clean`, and the normal CocoaPods prerequisites). Temporarily add the test spec
inside `target 'Mentra' do` in the generated `mobile/ios/Podfile`:

```ruby
pod 'AcsMeeting', :path => '../modules/acs-meeting/ios', :testspecs => ['SessionTests']
```

Run `pod install` from `mobile/ios`. Select an available iOS simulator with
`xcrun simctl list devices available`, then run from the repository root:

```sh
export ACS_TEST_SIMULATOR_UDID='<simulator UUID>'
xcodebuild \
  -workspace mobile/ios/Mentra.xcworkspace \
  -scheme AcsMeeting-Unit-SessionTests \
  -configuration Release \
  -destination "platform=iOS Simulator,id=$ACS_TEST_SIMULATOR_UDID" \
  -derivedDataPath mobile/build/acs-session-tests \
  -resultBundlePath .test-results/acs-session-tests.xcresult \
  -enableThreadSanitizer YES \
  ENABLE_TESTABILITY=YES IPHONEOS_DEPLOYMENT_TARGET=15.5 \
  CODE_SIGNING_ALLOWED=NO test
```

Use a new result bundle path for each run. Release matches the prebuilt React
Native libraries; Debug can fail to link their C++ debug symbols. These tests run
without an application host, so they do not depend on CocoaPods' generated app
delegate or launch the Mentra App. Thread Sanitizer instruments the compiled
native session code; it does not instrument the prebuilt Azure SDK.

Afterward, remove the temporary Podfile entry and run `pod install` again. The
test spec is opt-in and is not run by the existing PolicyKit-only CI job.
