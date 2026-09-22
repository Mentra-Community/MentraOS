---
status: active
owner: PhilippeFerreiraDeSousa
---

# Coordinated mobile release parity

## Goals

Verify changed software quickly and deliver the complete dev/staging release on Android, iPhone and Apple Silicon Mac. Preserve coordinated release identities, backend isolation, exact OTA pins, supported ABIs, and store distribution.

## Implementation boundaries

1. Reuse native compilation through Gradle/Xcode's dependency graphs. Coordinated builds generate Kotlin, Swift and JavaScript release metadata, so the PR binary rewriter cannot simply relabel an old release. Keep the normal store packaging path and regenerate changed metadata. Cache successful compiler work with toolchain/workspace isolation; report cache use and build timings. Whole-artifact reuse for identical immutable releases remains first priority.
2. Build mobile concurrently with Cloud; release finalization still requires successful Cloud deployment.
3. Export registered-device iPhone and Mac packages from the same iOS archive used for TestFlight. Keep TestFlight delivery and its review status distinct from immediate downloads.
4. Give Android/iOS/macOS comparable Slack rows; iPhone includes direct installation and an HTTPS share link. Include the exact ASG/BES/MTK targets, backend and source identity.
5. Verify delivered files, signatures, runtime OTA and build identity; keep immutable release assets and normal release retention.

## Validation

Run focused contract/unit checks plus fresh and warm coordinated builds. Validate package identity/configuration, supported architectures, signing, direct-install files and publication recovery. Measure actual native task reuse and elapsed time; a cache restore alone is not proof of avoided compilation. Do not claim a qualified speedup until the real builds demonstrate it.
