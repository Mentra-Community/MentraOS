---
status: active
owner: Philippe
---

# Close the iOS PR CI gap

Goals and current specification: [PR CI](../specs/2026-09-21-pr-ci.md).

Work in PR #4125, branch `codex/pr-ios-ota`. Changes to coordinated dev/staging
release workflows are outside this task's scope; that is a task boundary, not a
requirement of PR CI.

## Implementation

- [x] Confirm the gap: #4011 covered Android when iOS PR builds were compile-only;
      later installable iOS artifacts omitted OTA and compiled-artifact reuse.
- [x] Share mobile fingerprint/selection and packaged configuration between Android
      and iOS, separating compilation inputs from PR identity and OTA URLs.
- [x] Select a verified IPA before dependency installation, prebuild and archive.
      Repackage fresh and reused artifacts through the same path, preserving
      compiled code and capabilities while updating PR configuration and signing.
- [x] Retry confirmed signing-only failures with existing build outputs instead of
      deleting caches and recompiling. Keep publication independently retryable.
- [x] Align workflow triggers and notification applicability so either platform
      can deliver a complete candidate for the same PR changes.

## Qualification procedure

1. Run a changed-input candidate through CI and download its published artifacts.
2. Verify checksums, current PR identity/build number, OTA URL, signing and original
   compilation provenance. iPhone and Mac must contain the same compiled app.
3. Push a documentation-only change outside the fingerprinted inputs. Confirm
   dependency/prebuild/compilation steps are skipped, while the new downloads
   carry the new PR revision and OTA manifest. Compare compiled payloads.
4. Record compilation-verdict and publication latency for both paths. The current
   run links and final qualification results belong in [PR #4125](https://github.com/Mentra-Community/MentraOS/pull/4125).

## Recorded evidence

Local checks: 35 Node checks, 14 Python checks (including real signed Android APK
repackaging and real Mach-O re-signing), 2 metadata resolver tests and workflow
lint pass. Certificate extraction was also checked against an Apple-signed app.

Android head `f94ff0b7be`, run `35642899369`, passed fresh and unchanged-input
runs. Publication took about 8 minutes initially and 1 minute on reuse. Independent
comparisons of the downloaded APKs verified hashes, PR/OTA configuration and
unchanged compiled payload.

iOS head `8782f977e2`, run `35646774876`, passed archive, export, repackaging,
publication and notification. The archive took 5m42s. Independent CDN downloads
of the IPA and Mac ZIP verified their receipts, PR identity, build number and
OTA URL; both contain JavaScript SHA-256
`fce1a000e6a1690d952d97ff27d57e891689d5e77c80ba66a1151fba786401eb`.
The compilation fingerprint is
`21ff482682386e17dc45df51083877577046d76792abad47c3ee15c32408b58e`.
This documentation update supplies the changed PR revision for the reuse check;
see the PR for its subsequent result. Physical installation/OTA flashing is a
separate qualification step; these checks establish packaging and delivery.

Earlier runs reproduced intermittent `errSecInternalComponent` framework signing
failures. A later archive succeeded without needing recovery; the targeted retry
has regression coverage but has not yet been observed recovering that CI failure.

Remaining optimization/usability gaps are recorded in the specification: ASG
currently reuses coordinated releases only, and the Mac installer needs refinement.
