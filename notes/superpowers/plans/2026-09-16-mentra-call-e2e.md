---
status: active
owner: philippe
---

# Mentra Call recorded routine

Design and English steps: [Mentra Call routine](../../../tools/mentra-e2e/MENTRA-CALL-ROUTINE.md). Reuses the [Mac harness design](../specs/2026-09-15-mentra-app-e2e-harness.md).

- [x] Fetch and merge current `origin/dev` in the isolated harness worktree, preserving the primary checkout. Merge commit: `283992c8541ee6c6c97c62043085b6f626a0c6d0`.
- [x] Clone Mentra Call `main` and compare source/bundled manifest identities (2.1.13).
- [x] Read host launch policy, miniapp connection guards, Settings controls and existing source test boundaries.
- [x] Write the proposed English routine, with normal-iOS availability, disconnected UI and connected-device extensions separated.
- [x] Resolve target: the user requested iOS enablement and a real Mac test with Mentra Live, followed by a browser participant. Product changes live on `codex/enable-mentra-call-ios` and are integrated into the harness for local testing.
- [x] Build latest host and record its identity; running binary contains Call 2.1.13 with the expected ZIP hash.
- [x] Record the old dev exclusion, then replace it with the five-step `mentra-call-availability` check for the enabled host. Three passes have verified launcher/search behavior; no Call WebView/meeting coverage claimed.
- [x] Fix the Clear Search activation failure discovered in the real-app probe. React Native's `TouchableOpacity` drops `onAccessibilityTap`; a native `Pressable` forwards it to the same handler as touch.
- [x] Discover actual actions for paired navigation/settings/form inspection. Text entry and radio-selection semantics remain unresolved.
- [x] Compile 13 observed paired UI steps with per-step evidence and explicit editing/media exclusions.
- [x] Qualify three paired UI replays, inspect evidence and document new-Mac setup and server diagnostic steps.
- [x] Update PR #4069 with paired UI scope, validation and explicit remaining meeting/editing gaps.

The user explicitly authorized restoring iOS availability, supplied USB target `ML396102B` / Bluetooth `Mentra_Live_03BE`, and authorized joining the resulting Teams link in a browser. Pairing is complete after the user entered pairing mode and the native iOS-on-Mac audio readiness fix was installed. ADB identity and the app success screen agree on 03BE. The user completed camera/microphone grants and Call now opens; the prior system-dialog access gate is resolved. Call 2.1.14 removes an unrelated required-calendar launch gate. The external source commit is saved locally but publishing requires write access to Mentra-Community/Mentra-Call. No firmware or glasses network configuration was changed. Do not claim Call UI coverage from host visibility or meeting success from local state alone.

Source validation: 71 existing Mentra Call tests passed across `call-ui.link.test.ts`, `meeting-hosts.test.ts` and `video-profile.test.ts`; these are supporting checks, not device/media proof. Harness TypeScript and ten runner/native checks passed, including packaged archive byte identity and keep-awake lifecycle.

Discovery `2026-09-16T18-36-23-092Z-discovery-c77226` and native replay `2026-09-16T18-39-22-641Z-mentra-call-ios-availability-667c36` retained the original Clear Search failure. Adding a prop to the old wrapper still failed (`2026-09-16T18-41-44-817Z-mentra-call-ios-availability-a1008a`); inspecting the React Native wrapper confirmed that it does not forward that prop. After replacing only that control with `Pressable`, all five steps passed (`2026-09-16T18-43-54-655Z-mentra-call-ios-availability-a19d83`, 6.465 seconds); MP4, screenshots, chapters and capture liveness passed artifact checks.

Full regression after the fix: `2026-09-16T18-44-23-699Z-no-glasses-f84f75`, 70 passed, three declared exclusions, 85.86 seconds, zero model calls. All artifact/liveness checks passed and no step recorded Mentra as foreground. Full mobile TypeScript also passed. This build's local source diff is recorded; it is not represented as a clean committed app build.

Enabled-host qualification: `2026-09-16T19-07-26-868Z-mentra-call-availability-5b7785`, `2026-09-16T19-07-54-008Z-mentra-call-availability-fff46b`, and `2026-09-16T19-08-09-417Z-mentra-call-availability-a956b0`: five steps each, 5.841667/5.963333/5.84-second videos, zero model calls, all artifact and liveness checks passed. The actual fixture is recorded as pairing-incomplete. The failed Call launch discovery and successful guard dismissal remain preserved separately.

Updated-build host qualification: `2026-09-16T20-38-10-217Z-mentra-call-availability-41c677`, `2026-09-16T20-38-17-138Z-mentra-call-availability-1412b7`, and `2026-09-16T20-38-23-929Z-mentra-call-availability-cd0b3e`: five steps each, 6.025 / 5.881667 / 5.906667 seconds, zero model calls, artifact/liveness checks passed. Screenshots visually fill the canvas. The installed 2.1.14 app subsequently opened Call after permission completion; see the paired UI and real-join findings below.

## Paired Call UI and cloud provisioning diagnosis

Paired UI qualification: `2026-09-16T21-22-42-981Z-mentra-call-ui-a9b90f`, `2026-09-16T21-23-09-891Z-mentra-call-ui-613b4a`, and `2026-09-16T21-24-19-512Z-mentra-call-ui-4e9f73`: 13 steps each in 11.855 / 11.75 / 12.196667 seconds, zero model calls. All 39 screenshots/AX snapshots, videos, chapters and frame-liveness checks passed. The installed app, replay code and native driver were unchanged; intervening documentation edits changed the broader harness-directory hash. No step recorded Mentra as foreground. Representative Settings, Join and final-home screenshots were visually inspected. The Settings Teams-status text runs together at this narrow viewport; this is retained as a layout finding, not a visual approval. Ten runner/native checks and harness TypeScript pass.

The first create-and-join made a Teams meeting through the production Call backend, then failed in the MentraOS dev runtime before ACS join. Cloudflare rejected Stream access (403/code 10000) even though token verification returned active. Porter `cloud-dev` maps to Doppler `cloud-v2/dev_aws`; both that config and root `dev` have identical Stream account/token values. This is separate from the external miniapp backend. No credentials or deployment were changed. The exact owned meeting was retired separately (Graph DELETE 204, GET 404); app cleanup is not qualified. See the English routine and run `2026-09-16T21-05-39-830Z-discovery-6bcdc6` for sanitized diagnosis and cleanup evidence. Original transport and three Mac audio defaults were restored.

Android success was reported after this diagnosis. Its transport setting remains unknown. Read-only comparison found the current Porter `cloud-prod` and `cloud-dev` merged configs, plus Doppler root `dev`, `dev_aws` and `prod`, contain the same Stream account/token pair. This does not prove the running Android client takes this path, nor the exact credential loaded by older deployed pods. Direct link bypasses Cloudflare provisioning. The current Mac default internet route is Wi-Fi en0; no network switch was made to attempt a hotspot workaround.
