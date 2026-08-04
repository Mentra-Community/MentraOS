# OS-1785: Glasses reconnect leaves mic disabled — root cause + fix spec

Linear: OS-1785. Observed live 2026-07-21 (Pixel 8 + Mentra Live, dev build).
All file references are in
`mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/`.

## How the state machine is supposed to work

- The engine (JS) pushes standing audio requirements via
  `MentraBluetoothSdk.setMicStates(sendPcm, sendTranscript, sendLc3)`
  (`MentraBluetoothSdk.kt:695`), which writes three DURABLE DeviceStore flags
  (`should_send_pcm/lc3/transcript`) and calls `DeviceManager.setMicState()`.
- `setMicState()` (`DeviceManager.kt:1828`) derives the master switch:
  `micEnabled = shouldSendPcm || shouldSendLc3 || shouldSendTranscript ||
  localSttFallbackActive`, then `updateMicState()` picks and enables the first
  available mic in `micRanking`.
- `updateMicStateInternal()` (`DeviceManager.kt:791`) only ever ENABLES a mic
  when `micEnabled` is true.
- Recovery watchdog `checkAndReinitGlassesMic()` (`DeviceManager.kt:325`)
  re-inits the glasses mic when audio stalls, but early-returns unless
  `glasses.micEnabled` is already true.

## The wedge (why we got into the state)

1. Translation had an active subscription -> `should_send_lc3 = true`
   (durable), `micEnabled = true`, glasses mic streaming.
2. Glasses died. The app-level reconnect cycle ran `disconnect()`
   (`DeviceManager.kt:1985`): `sgc.disconnect()`, `sgc = null`, and
   **`micEnabled = false`**. The `should_send_*` flags were NOT cleared (
   correct - the requirement still stands).
3. Glasses came back; `handleDeviceReady()` (`DeviceManager.kt:1228`) ran. It
   re-applies dashboard height/depth after reconnection - but it NEVER calls
   `setMicState()`. Nothing else does either:
   - The DeviceStore change-triggers (`DeviceStore.kt:317-331`) only fire when
     a `should_send_*` value CHANGES. The flags were true before and after, so
     no trigger fired.
   - The engine only calls `setMicStates(...)` when subscriptions change. The
     miniapp's subscription never changed, so JS pushed nothing.
4. Self-consistent wedge: `micEnabled=false` gates `updateMicState()` off; the
   watchdog is gated on `glasses.micEnabled` (false after teardown) so it
   early-returns; every layer agrees the mic "should" be off, and no input
   ever arrives to say otherwise.
5. A Metro/JS reload does NOT recover (native DeviceManager singleton
   persists). Only a full process kill re-runs the engine bootstrap, which
   re-pushes `setMicStates(...)` - hence the force-stop "workaround".

The exact same wedge applies to Captions or any audio subscriber; it is not
translation-specific.

## Fix (prevention): re-derive mic state on device ready

In `handleDeviceReady()` (`DeviceManager.kt:1228`), after the SGC is
confirmed, call `setMicState()` - mirroring how the function already re-applies
dashboard position after reconnection:

```kotlin
fun handleDeviceReady() {
    ...
    syncSystemTimeOnceForConnection(readyKey)

    // Re-derive the mic master switch from the DURABLE should_send_* flags.
    // disconnect() clears micEnabled, but the standing requirements survive;
    // without this, a reconnect leaves the mic off forever while apps hold
    // active audio subscriptions (OS-1785).
    setMicState()
    ...
}
```

`setMicState()` is idempotent (recomputes from durable flags, clears the VAD
buffer, and `updateMicState()` is re-entrancy-guarded), so calling it on every
ready event is safe - including the simulated-device path (`connectSimulated()`
already funnels through `handleDeviceReady()`).

## Fix (instant recovery / defense in depth): un-gate the watchdog

`checkAndReinitGlassesMic()` currently trusts `glasses.micEnabled` - the very
state that wedges. Make it re-derive intent from the durable flags instead, so
ANY future path that strands the mic self-heals within one watchdog tick:

```kotlin
private fun checkAndReinitGlassesMic() {
    val glassesConnected = DeviceStore.get("glasses", "connected") as? Boolean ?: false
    if (!glassesConnected) return

    val required = shouldSendPcm || shouldSendLc3 || shouldSendTranscript || localSttFallbackActive
    if (!required) return

    // ... existing isMicSuspendedForAudio / own-audio-playing guards ...

    if (!micEnabled) {
        // Requirements say audio is needed but the master switch is off:
        // a reconnect (or future bug) stranded the state. Re-derive it.
        Bridge.log("MAN: mic required but disabled after reconnect; re-deriving mic state")
        setMicState()
        return
    }

    // ... existing lastLc3Event staleness check + sgc.setMicEnabled(true) ...
}
```

Keep the OS-1712 fix in mind: the staleness path must still respect VAD (do
not re-introduce the 10s reinit spam on VAD-equipped models during silence).
The new `required`-based branch above only fires when `micEnabled` is false,
which cannot spam - one `setMicState()` flips it true and the branch stops
matching.

## Acceptance tests (device)

1. Start Translation (or Captions), verify audio flows. Power the glasses off,
   wait for the reconnect loop, power them on. Within one watchdog interval of
   the reconnect, speech must produce transcripts again - no app restart, no
   reload.
2. Same, but toggle the miniapp off during the outage: after reconnect the mic
   must STAY off (no requirements) - confirms the fix does not force-enable.
3. Regression: OS-1712 scenario (VAD-equipped glasses, silence) must not log
   reinit spam.

## Notes

- Root-cause session evidence (log excerpts) is on Linear OS-1785.
- This spec intentionally leaves the JS engine untouched: the requirement
  flags are already durable and correct; the native layer just has to consult
  them at the two moments that matter (device ready, watchdog tick).
