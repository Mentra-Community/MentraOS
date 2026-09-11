# Coordinated Google Play Distribution

The existing `coordinated-release.yml` owns Android distribution alongside
TestFlight. There is no separate release train for the example app.

| Product | dev | staging |
| --- | --- | --- |
| MentraOS (`com.mentra.mentra`) | Internal testing | Open testing (`beta` API track) |
| React Native example (`com.mentra.bluetoothsdkexample`) | Internal testing | Open testing (`beta` API track) |

MentraOS retains its existing dev/internal and staging/beta routing. Internal
testers must opt out of internal testing before joining the open test for the
same app. Neither branch targets production.

## One-Time Console Setup

1. Create a free app named `Mentra Bluetooth SDK Example` with package
   `com.mentra.bluetoothsdkexample` in the Mentra Labs developer account. An
   authorized person must complete the policy and export declarations.
2. Grant the existing `GOOGLE_PLAY_KEY_JSON` service account access to this app
   and permission to manage testing releases. Reuse the existing upload key
   and signing secrets; do not create a second release credential.
3. Use the signed AAB persisted by the coordinated example Play job for the
   first Console upload and Play App Signing setup. The job preserves the AAB
   even if Play lookup fails during first-time setup. Its error includes the
   immutable download URL. Do not substitute a debug APK or rebuild the same
   version code under another key.
4. Assign the appropriate internal-only tester list to the example's internal
   track. A public opt-in URL does not grant internal access by itself.
5. Complete the store listing, privacy policy, app access, data safety, content
   rating, target audience, and other declarations Play requests for open
   testing. Select the intended countries and open-test audience, and submit
   the initial open release for review. Do not publish unrelated MentraOS
   pending changes.
6. Retry the same coordinated run after setup. The job reuses the persisted AAB
   and confirms its version code on the requested track before recording the
   result.

## Evidence And Retries

The example Play job consumes the validated Starter Kit release commit and
the coordinated marketing version/build number. It preserves the example's
existing Android ABI configuration, signs the AAB with the shared upload key,
and persists it in the immutable coordinated release container before upload.

The release manifest records the package, track, audience, version, exact source,
AAB URL/hash/size, and workflow provenance under `starterKit.googlePlay`.
`submitted` means the upload was accepted and the exact version code was read
back from the track. It does not assert review approval or tester availability.
The finalizer fails if the required Play job or its publication evidence is
missing. Historical manifests without Play evidence remain readable.

Existing MentraOS releases already submitted to `beta` are not removed by this
change. Review any pending Console changes separately before publishing them.

References: [Google Play testing](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en),
[fastlane Play setup](https://docs.fastlane.tools/actions/upload_to_play_store/).
