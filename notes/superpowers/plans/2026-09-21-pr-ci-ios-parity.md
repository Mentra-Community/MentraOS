---
status: active
owner: Philippe
---

# Close the iOS PR CI gap

Goals and current specification: [PR CI](../specs/2026-09-21-pr-ci.md).

Work in PR #4125, branch `codex/pr-ios-ota`. Changes to coordinated dev/staging
release workflows are outside this task's scope; that is a task boundary, not a
requirement of PR CI.

- [x] Confirm the gap: #4011 covered Android when iOS PR builds were compile-only;
      later installable iOS artifacts omitted OTA and compiled-artifact reuse.
- [x] Reproduce the missing OTA pin in the installed Mac app and add an exported
      artifact check. The initial OTA-only implementation is committed, but is
      not sufficient for the combined requirements.
- [x] Adapt the existing mobile fingerprint/selection and packaged configuration
      contract for both platforms. Identify packaging-only inputs explicitly.
- [x] Add iOS artifact reuse before dependency installation, prebuild and archive
      where feasible. Repackage fresh and reused artifacts through the same path,
      preserving compiled code and capabilities while updating PR configuration,
      native build number and signing.
- [x] Avoid a clean rebuild for confirmed signing-only failures: retry with the
      existing build outputs and report a persistent signing error separately.
      Publication remains a separate job that can be rerun independently.
- [x] Align workflow triggers and notification applicability so either platform
      can deliver a complete candidate for the same PR changes.
- [ ] Verify cold and reuse CI paths, effective OTA pins, artifact integrity and
      provenance. Measure compilation-verdict and publication latency.
- [ ] Validate the exact iPhone/Mac downloads, document remaining Mac installer
      friction, and update the PR description around the complete change.

CI evidence for head `f94ff0b7be`: Android run `35642899369` passed a fresh build
and an unchanged-input rerun. Publication took about 8 minutes initially and
1 minute on reuse; the rerun skipped compilation. Independent checks of both
downloaded APKs verified their hashes, current PR/OTA configuration and unchanged
compiled payload. Mobile quality, OEM typecheck and ASG checks passed.

iOS run `35642899514` failed signing `Turf.framework` after compilation with
`errSecInternalComponent`, with the correct identity and job keychain present.
This reproduced the initial candidate's signing failure and motivated the
targeted incremental retry. A successful Apple artifact and real reuse run are
still required; local re-signing fixtures do not establish production signing.

ASG run `35642899395` rebuilt on rerun: the existing selector only searches
coordinated release artifacts, not previously published PR ASG builds. Preserve
this as a remaining optimization gap rather than claiming universal ASG reuse.

Local validation: shared selection/fingerprint and publication tests, real signed
Android APK repackaging, real Mach-O re-signing/payload checks, metadata resolver
tests and workflow lint pass. Cold/reuse CI qualification remains pending.
