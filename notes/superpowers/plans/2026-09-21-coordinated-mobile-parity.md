---
status: active
owner: PhilippeFerreiraDeSousa
---

# Coordinated mobile parity implementation

Spec: ../specs/2026-09-21-coordinated-mobile-parity.md

- [x] Inspect current dev/staging workflows and PR artifacts.
- [x] Implement #4138 with Gradle task caching, Xcode compilation caching, signing preflight/retry and frozen-source compatibility.
- [x] Implement #4139 with registered-device iPhone/Mac exports, verified immutable receipts and symmetric release Slack links.
- [x] Qualify #4139 signed exports on dev (35683670210) and staging (35688158326); independently verify downloaded signatures, hashes, metadata and OTA pins.
- [x] Finish #4138 signed cold/warm compiler-cache qualification and record metrics and archive identity.
- [ ] Verify actual public release links and store delivery after merge.

Parallel compilation before Cloud readiness is deferred to a separate build/publication split. Both PRs retain the Cloud publication gate.

## Signed cache qualification

Both full workflows passed on Xcode 26.2:

| Measurement | [Cold: 35692296639](https://github.com/Mentra-Community/MentraOS/actions/runs/35692296639) | [Warm: 35695051415](https://github.com/Mentra-Community/MentraOS/actions/runs/35695051415) |
| --- | --- | --- |
| Release / native build | 3.3.0-dev.11 / 303000011 | 3.3.0-dev.12 / 303000012 |
| Cacheable compiler tasks reused | 0 / 3,319 | 3,319 / 3,319 |
| Archive time | 26m35s | 17m06s |
| Build step (prebuild through signed export) | 32m06s | 21m04s |
| Compiler cache | Saved 2.17 GB | Restored in 32s; no duplicate upload |

The build step was 34.4% shorter in this comparison; cache restore is a separate step. This is one measured pair, not a guarantee for every release. Identical mobile/dependency source trees produced different generated release metadata. The cold source was `c3c89ddaca5b76a8920d9c22b3c5afc0ad087911`; the warm source was `40100da293057297aa9d65c097d6be00b6012ef7`. Native caching code was unchanged between the runs; the later revision only separated qualification artifacts by attempt.

Independently downloaded both IPAs and verified Apple signatures, app/SDK versions, source identity, and native plus JavaScript OTA pins. Both use the deliberately invalid qualification URL and must not be used for glasses updates. Warm IPA SHA-256: `9b65510770788d776bc147b86a03ac33167bbc0652e0186e4b317f05b9af2df9`.

Android passed both runs. The cold APK build reused 847 Gradle tasks; the AAB reused 15 and had 1,807 up-to-date tasks. Independent artifact inspection verified the APK signature, release/build metadata, OTA pin, ARM64-only APK and four-architecture AAB.

Read `CompilationCacheMetrics` and archive timings, not counts of `CompileC` steps (cache hits still emit those steps). Cache only the compiler store and SwiftPM sources/downloads. The discarded DerivedData/timestamp experiment is not qualification evidence.

Focused checks: 45 passed, one artifact-dependent check skipped; syntax and workflow validation passed. Both PRs combine without conflicts and the combined workflow passes actionlint. Local detailed evidence is under `.test-results/coordinated-mobile-qualification/cas-cold` and `cas-warm`.

For future comparisons, use the latest qualification workflow: apply `qualify-coordinated-mobile`, then rerun all jobs. The rerun retains its source commit and increments the test release/native number, with separate artifacts for each attempt. Do not rerun the old cold run above, whose original artifact names predate that change.
