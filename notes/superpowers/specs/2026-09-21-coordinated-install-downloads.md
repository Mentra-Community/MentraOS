# Install complete coordinated dev/staging software

Status: implemented; signed export qualification pending.

The release should be easy to install from its Slack post on Android, a registered iPhone, or a registered Apple Silicon Mac. Each app must keep the channel backend and exact release OTA target. TestFlight and Google Play retain their existing channel policies.

## Delivery

The existing coordinated build compiles and exports the App Store IPA once. Xcode then exports a registered-device IPA from the same compiled app, using the existing `IOS_PR_PROFILE_BASE64` ad hoc profile and Apple Distribution signing identity. The portable Mac ZIP contains that same signed app and the existing installer. A minimal archive reconstructed from the unencrypted CI IPA also permits re-exporting an already published store artifact without compiling again.

The packager checks the release/native version, source commit, OTA pin, Apple signature and registered-device profile. It compares the executable with its signature removed and the complete JavaScript bundle before and after Xcode export. ZIP extraction is checked again. No app executable patching, profile-only substitution or local re-signing is used to make the app run on Mac.

The bundle ID remains `com.mentra.mentra`, so installation replaces the current Mentra App and preserves its data. Registered-device distribution is not installation on arbitrary iPhones or Macs. The shared profile must contain the target device and be unexpired. The Mac launcher still needs Bun and macOS trust approvals; improving that installer is separate work.

## Publication and retry

The existing 90-day GitHub Actions handoff preserves store IPA, registered-device IPA, ZIP, installation plist, sharing HTML and their receipt. The Ubuntu publisher verifies all local bytes, uses immutable publication with download verification, and commits the receipt last. Final release records include the extra download hashes. A completed release retry restores and verifies its receipt and all artifacts; a failed publication job reuses its original handoff without rebuilding. Conflicting bytes at an immutable URL fail closed. After partial publication, rerun the failed publication job rather than rebuilding signed packages under the same release identity.

Direct-download outputs come from the publisher independently of App Store Connect processing. Slack can show ready downloads while TestFlight is still unavailable. It retains Android/Google Play and iOS/TestFlight status, with symmetric Android, iOS and macOS download rows. The iPhone row uses a rich-text `itms-services` link plus an HTTPS **Share install link**. The post includes backend and exact ASG/BES/MTK targets from the immutable OTA manifest. Completed release pages also link the sharing page and Mac ZIP.

The `installable_downloads` input defaults off and is enabled only by the dev/staging coordinator. Production promotion and the compatibility lab retain their existing distribution behavior.

## Validation

Unit tests cover both channel links, stale metadata, OTA mismatches, partial sets, changed bytes, publication order, repeat publication, final release records and Slack links. Existing PR packaging and notification tests remain regression coverage. The opt-in `qualify-coordinated-downloads` label runs the actual signed coordinated build and export in dry-run mode, without deploying Cloud, publishing a release or uploading to stores. Its placeholder OTA target makes its intermediate app unsuitable for device OTA testing.

Before merging: require a successful signed export and artifact handoff in this qualification job. Before declaring rollout complete: verify a real coordinated release's published receipt, install links, app OTA pin and TestFlight result.
