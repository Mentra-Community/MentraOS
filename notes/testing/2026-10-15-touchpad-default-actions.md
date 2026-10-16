# OS-2123 physical touchpad verification

Requires the SDK PR build, its linked BES firmware build, and an assigned Mentra
Live pair on both Android and physical iPhone. Source/compile tests do not qualify
physical AVRCP, media routing, gesture delivery, or BLE disconnect reset. Do not
install firmware without the device owner's authorization and passing OTA gates.

Use a Bluetooth SDK consumer that logs `touch_event` and exposes
`setTouchGestureDefaultBehaviorEnabled(gesture, enabled)`. The Mentra App does not
currently expose this API as a routine-selectable UI control. An SDK consumer
build and a fixture that performs real touchpad gestures are prerequisites for
routine authoring; no enrolled host/lane or fixture is assumed.

1. Connect and verify unmodified double tap toggles a known phone media player.
   Record app, SDK, BES and phone versions; observe the selected player's actual
   playback state and gesture events.
2. Disable `double_tap`; wait for the matching applied acknowledgement. With the
   player paused, double tap must produce `touch_event` without starting playback.
   Repeat during playback; it must keep playing. Test foreground and background.
3. Confirm a second gesture's stock behavior remains enabled. Disable and restore
   each gesture independently. Volume swipes and previous/next-track swipes must
   stop changing the corresponding player state while continuing to emit events.
   Single/triple taps and long press must still emit events when disabled.
4. Re-enable each gesture, wait for its acknowledgement, then verify stock media
   and feedback behavior resumes.
5. Disable double tap, disconnect BLE, and confirm its stock behavior resumes.
   Reconnect and confirm the override is absent until explicitly set again.
   Repeat with a glasses restart.
6. On older BES firmware, the method must reject/time out; it must never report an
   applied setting or imply music suppression. Invalid gesture input and unsupported
   glasses models must reject.
7. Restore all enabled settings, stop owned playback, close the SDK consumer, and
   release device custody through the owning controller.

Routine source inspected at Harness `5cd57f008664abfc072ca9462641444c6ba141bd`:
`camera-settings-android` edits camera-button settings; `connected-settings-android`
checks navigation; `youtube-audio-android` and its fixture exercise browser
playback/pause and a photo. None invokes this SDK API or performs touchpad gestures.
No existing label verifies OS-2123. Authoring is pending a testable SDK consumer,
physical gesture fixture, and an owner-confirmed host/lane for Android and iPhone.
