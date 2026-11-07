# Bluetooth SDK migration

Public API changes in `@mentra/bluetooth-sdk`, for apps upgrading from an earlier release.

## `3.4.0`: `unpair()` replaces `clearDefaultDevice()`

- `clearDefaultDevice()` is removed, in TypeScript, Kotlin and Swift. It forgot the saved default device but left the phone bonded with the glasses, so the next pairing skipped pairing mode.
- Use `unpair()`: it disconnects, forgets the default device and, on Mentra Live, removes the phone's Bluetooth bond, so pairing again starts from pairing mode. `forget()` is unchanged.

## `3.3.0`: Mentra Live pairing state

This covers the public pairing API change in `3.3.0`, for apps upgrading from `3.2`.

### Version

The SDK version is `package.json` `"version"`. The iOS podspec (`ios/MentraBluetoothSDK.podspec`) and the Android Gradle module (`android/build.gradle`) read that same value. Swift package metadata is injected from it at pack time.

This repository keeps the Bluetooth SDK version aligned with the matching Mentra Live software release. It does not cut an independent major for a breaking SDK change. The break below shipped in `3.3.0`. Apps on `3.2.1` pick it up by moving to `3.3.0` or later.

### Removed

- `confirmReplaceOwner()` is removed.
- The `confirm_replace_owner_result` event and its types are removed.
- `owner_replaced` is deprecated and is never emitted. Remove listeners. Use `pairing_state_changed` or `GlassesStatus.pairingState`.
- `pairing_info` no longer includes `awaiting_confirm` or `retained_owner_link`.

### Added

`GlassesStatus.pairingState` (absent on models other than Mentra Live):

```ts
type MentraLivePairingState =
  | {state: "normal"}
  | {state: "pairing_mode"; windowId: number; endsAtMs: number}
  | {state: "pairing_rejected"}
```

| State | What to do |
| --- | --- |
| `normal` | Automatic reconnect is allowed. |
| `pairing_mode` | A pairing window is open. Leave reconnect paused until `endsAtMs`. That timestamp is the window plus a 30-second margin. `windowId` identifies the window and survives a cold start. |
| `pairing_rejected` | The glasses no longer accept this phone (another phone paired, or repeated authentication rejections on secure-pairing firmware). Reconnect has stopped. Show **Pair Again**. This clears only after a successful explicit `connect()` / `connectDefault()`, or after `forget()`. |

`useMentraBluetooth().glasses` does not include `pairingState`. Read `getGlassesStatus()`, `subscribeGlassesStatus()`, or the `pairing_state_changed` event (`{state: MentraLivePairingState}`).

`GlassesStatus.audioSetup` (every model) says whether the user has to do anything for glasses audio:

```ts
type GlassesAudioSetupState =
  | {state: "idle"}
  | {state: "not_applicable"}
  | {state: "connecting"}
  | {state: "connected"}
  | {state: "needs_user"; action: "connect_in_settings"}
```

Render `needs_user` as a step that sends the user to Settings > Bluetooth, and treat `connected` and `not_applicable` as done. The SDK owns the waits (on iPhone: up to 8 seconds after a pair on firmware with `auto_audio`, none on older firmware, 10 seconds after a reconnect). Remove any app-side audio timers or `pairing_info.auto_audio` checks. Changes also arrive as `audio_setup_changed` (`{state: GlassesAudioSetupState}`).

Other additions:

- `entering_pairing_mode` includes `window_id` (same window as `pairingState.windowId`).
- `pairing_mode_ended` fires when the glasses close the window and this phone is still accepted. `reason` is `"paired"`, `"cancelled"`, or `"timeout"`. Optional `window_id`. The previous phone does not get this event when another phone pairs; it moves to `pairing_rejected`.
- `pairing_info.auto_audio` is true when the glasses derive Classic audio from the LE pair (CTKD). The SDK already uses it for `audioSetup`.
- `pair_failure.code` may be `"ios_forget_pairing"`: iOS holds a stale Bluetooth pairing for these glasses during an explicit attempt. The user must open Settings > Bluetooth, choose Forget This Device, then pair again. On Android and iOS native apps this arrives as the pairing-failure error's `failureCode`.

### Behavior

On supported Mentra Live firmware, three presses of the power button open one 120-second pairing window. The glasses speak a 4-character code. Three presses again cancel the window. After a timeout or a cancel, the phone that was already paired reconnects automatically. If another phone pairs, that previous phone gets `pairing_rejected`. Pairing readiness needs no app-side `pairing_info` wait: the SDK reports the glasses ready only after secure firmware commits the bond, and treats glasses that send no `pairing_info` within 5 seconds as older firmware.

User-facing sample copy should say "Pair Again". Do not say "owner" in that copy. API fields such as `owner_retained`, `owner_committed`, and `ownership_transfer` are unchanged identifiers on `entering_pairing_mode` and `pairing_info`.
