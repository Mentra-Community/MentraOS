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
- [ ] Keep compilation evidence separate from packaging/publication success;
      recover signing or upload failures without unnecessary recompilation.
- [x] Align workflow triggers and notification applicability so either platform
      can deliver a complete candidate for the same PR changes.
- [ ] Verify cold and reuse CI paths, effective OTA pins, artifact integrity and
      provenance. Measure compilation-verdict and publication latency.
- [ ] Validate the exact iPhone/Mac downloads, document remaining Mac installer
      friction, and update the PR description around the complete change.

Current CI evidence: run `35632234805` for initial head `292ef6571c` failed. Its
first archive attempt failed signing Mapbox frameworks with
`errSecInternalComponent`; the clean retry also failed. The failure of the
second attempt needs separate diagnosis. No new iOS download from this run has
been verified. Android, ASG and mobile quality checks passed.

Local validation: shared selection/fingerprint and publication tests, real signed
Android APK repackaging, real Mach-O re-signing/payload checks, metadata resolver
tests and workflow lint pass. Cold/reuse CI qualification remains pending.
