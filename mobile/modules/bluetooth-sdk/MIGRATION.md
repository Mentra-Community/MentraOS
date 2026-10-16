# Bluetooth SDK migration: Mentra Live pairing state

This note covers the public pairing API in `@mentra/bluetooth-sdk` `3.3.0` relative to the published `3.2.1` package. `3.3.0` is the current release family in `package.json` and is not on npm yet.

## Version

The SDK version is `package.json` `"version"`. The iOS podspec (`ios/MentraBluetoothSDK.podspec`) and the Android Gradle module (`android/build.gradle`) read that same value. Swift package metadata is injected from it at pack time.

This repository keeps the Bluetooth SDK version aligned with the matching Mentra Live software release. It does not cut an independent major for a breaking SDK change. The break below ships in the unpublished `3.3.0` family. No further version bump was applied in this change. Integrators on `3.2.1` pick it up by moving to `3.3.0` when that release is published.

## Removed

- `confirmReplaceOwner()` is removed.
- The `confirm_replace_owner_result` event and its types are removed.
- `owner_replaced` is deprecated and is never emitted. Remove listeners. Use `pairing_state_changed` or `GlassesStatus.pairingState`.
- `pairing_info` no longer includes `awaiting_confirm` or `retained_owner_link`.

## Added

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
| `pairing_rejected` | Another phone took over. Reconnect has stopped. Show **Pair Again**. This clears only after a successful explicit `connect()` / `connectDefault()`, or after `forget()`. |

`useMentraBluetooth().glasses` does not include `pairingState`. Read `getGlassesStatus()`, `subscribeGlassesStatus()`, or the `pairing_state_changed` event (`{state: MentraLivePairingState}`).

Other additions:

- `entering_pairing_mode` includes `window_id` (same window as `pairingState.windowId`).
- `pairing_mode_ended` fires when the glasses close the window and this phone is still accepted. `reason` is `"paired"`, `"cancelled"`, or `"timeout"`. Optional `window_id`. The previous phone does not get this event when another phone pairs; it moves to `pairing_rejected`.
- `pairing_info.auto_audio` is true when the glasses derive Classic audio from the LE pair (CTKD), so audio should connect on its own.
- `pair_failure.code` may be `"ios_forget_pairing"`: iOS holds a stale Bluetooth pairing for these glasses during an explicit attempt. The user must open Settings > Bluetooth, choose Forget This Device, then pair again. On Android and iOS native apps this arrives as the pairing-failure error's `failureCode`.

## Behavior

On supported Mentra Live firmware, three presses of the power button open one 120-second pairing window. The glasses speak a 4-character code. Three presses again cancel the window. After a timeout or a cancel, the phone that was already paired reconnects automatically. If another phone pairs, that previous phone gets `pairing_rejected`.

User-facing sample copy should say "Pair Again". Do not say "owner" in that copy. API fields such as `owner_retained`, `owner_committed`, and `ownership_transfer` are unchanged identifiers on `entering_pairing_mode` and `pairing_info`.
