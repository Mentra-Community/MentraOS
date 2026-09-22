---
status: active
owner: PhilippeFerreiraDeSousa
---

# Coordinated mobile release parity

## Goals

Verify changed software quickly and deliver the complete dev/staging release on Android, iPhone and Apple Silicon Mac. Preserve coordinated release identities, backend isolation, exact OTA pins, supported ABIs, and store distribution.

## Implementation boundaries

1. Reuse native compilation through Gradle's task cache and Xcode's content-addressed compilation cache. Coordinated builds generate Kotlin, Swift and JavaScript release metadata, so the PR binary rewriter cannot simply relabel an old release. Keep the normal store packaging path and regenerate changed metadata. Cache successful compiler work with toolchain/workspace isolation; report cache use and build timings. Whole-artifact reuse for identical immutable releases remains first priority.
2. Retain the Cloud readiness dependency for this cache increment. Parallel compilation needs a separate build/publication split so a failed Cloud deployment cannot publish mobile artifacts or reach stores. Track that optimization separately.
3. Export registered-device iPhone and Mac packages from the same iOS archive used for TestFlight. Keep TestFlight delivery and its review status distinct from immediate downloads.
4. Give Android/iOS/macOS comparable Slack rows; iPhone includes direct installation and an HTTPS share link. Include the exact ASG/BES/MTK targets, backend and source identity.
5. Verify delivered files, signatures, runtime OTA and build identity; keep immutable release assets and normal release retention.

## Validation

Run focused contract/unit checks plus fresh and warm coordinated builds. Validate package identity/configuration, supported architectures, signing, direct-install files and publication recovery. Measure actual native task reuse and elapsed time; a cache restore alone is not proof of avoided compilation. Do not claim a qualified speedup until the real builds demonstrate it.

iOS uses `COMPILATION_CACHE_ENABLE_CACHING=YES` with a workspace-local `COMPILATION_CACHE_CAS_PATH`. Cache only that compiler store and SwiftPM sources/downloads. Generate native projects and build graphs fresh; do not rewrite source timestamps. This uses the [compilation caching introduced in Xcode 26](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes), which covers Swift and C-family clean builds. Cache keys isolate the workspace, SDK/toolchain, runtime environment and dependency inputs; repeated releases of identical source reuse one entry.

A local Xcode 27 archive probe regenerated the entire project, cleared its build directory and changed release metadata while retaining only the compiler cache: 9/10 cacheable tasks hit, the changed metadata missed the cache, and the resulting archive contained the new version without the old one. Full signed Xcode 26.2 qualification remains required; this probe is not a mobile release qualification.
