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
- [ ] Discover actual native accessibility actions and any source accessibility fixes.
- [ ] Compile observed steps; include bundle identity, honest exclusions, cleanup and per-step video/screenshot evidence.
- [ ] Qualify three replays, inspect evidence and document new-Mac setup changes.
- [ ] Update PR #4069 with the completed scope and validation.

The user explicitly authorized restoring iOS availability, supplied USB target `ML396102B` / Bluetooth `Mentra_Live_03BE`, and authorized joining the resulting Teams link in a browser. The app has reached Pair Audio; the old Mac bond failed and the target is no longer advertising. Awaiting the requested three quick power-button presses to enter pairing mode. ADB is connected. No firmware or glasses network configuration was changed. Do not claim Call UI coverage from host visibility or meeting success from local state alone.

Source validation: 71 existing Mentra Call tests passed across `call-ui.link.test.ts`, `meeting-hosts.test.ts` and `video-profile.test.ts`; these are supporting checks, not device/media proof. Harness TypeScript and ten runner/native checks passed, including packaged archive byte identity and keep-awake lifecycle.

Discovery `2026-09-16T18-36-23-092Z-discovery-c77226` and native replay `2026-09-16T18-39-22-641Z-mentra-call-ios-availability-667c36` retained the original Clear Search failure. Adding a prop to the old wrapper still failed (`2026-09-16T18-41-44-817Z-mentra-call-ios-availability-a1008a`); inspecting the React Native wrapper confirmed that it does not forward that prop. After replacing only that control with `Pressable`, all five steps passed (`2026-09-16T18-43-54-655Z-mentra-call-ios-availability-a19d83`, 6.465 seconds); MP4, screenshots, chapters and capture liveness passed artifact checks.

Full regression after the fix: `2026-09-16T18-44-23-699Z-no-glasses-f84f75`, 70 passed, three declared exclusions, 85.86 seconds, zero model calls. All artifact/liveness checks passed and no step recorded Mentra as foreground. Full mobile TypeScript also passed. This build's local source diff is recorded; it is not represented as a clean committed app build.

Enabled-host qualification: `2026-09-16T19-07-26-868Z-mentra-call-availability-5b7785`, `2026-09-16T19-07-54-008Z-mentra-call-availability-fff46b`, and `2026-09-16T19-08-09-417Z-mentra-call-availability-a956b0`: five steps each, 5.841667/5.963333/5.84-second videos, zero model calls, all artifact and liveness checks passed. The actual fixture is recorded as pairing-incomplete. The failed Call launch discovery and successful guard dismissal remain preserved separately.
