# OS-1615 — Mentra Live Pairing UX: Implementation Plan / Design Doc

**Linear:** [OS-1615](https://linear.app/mentralabs/issue/OS-1615/improve-mentra-live-pairing-ux) · **GitHub:** #3131
**Status:** Design complete — ready to implement
**Repos involved:** `MentraOS` (mobile app + asg_client) and `mentra-live-bes` (BES firmware, `~/Documents/mentra-live-bes`, branch `main`)

---

## 1. Problem

Two distinct problems, one root cause (the glasses have no notion of "who" they belong to and no explicit pairing handshake):

- **(A) Identity.** When scanning, you can't tell which physical Mentra Live is which. In a room with several units it's trial-and-error. The scan list shows only a stripped name suffix and nothing the user can match to a specific pair of glasses.
- **(B) Security.** An idle Mentra Live advertises and accepts a connection from *any* phone. If your phone isn't actively connected, someone else can connect and pull your photos. There is no bonded-device restriction and no explicit "pairing mode."

## 2. Desired end state (from the ticket)

1. Mentra Live only accepts connections from its **bonded phone** when not in pairing mode.
2. A **button combo** puts it into **pairing mode**; in pairing mode the status LED flashes and the glasses **speak their code** on repeat: *"Pair with Mentra Live using the app. Your code is: E-7-F-A."*
3. `prep.tsx` in the mobile app guides the user through this.

## 3. Decisions (locked)

| Decision | Choice | Notes |
| --- | --- | --- |
| Pairing gesture | **Hold power + camera button together for 10 seconds (GROUPKEY)** | Avoids all conflict with video (long press) and photo (short press). Uses BES native GROUPKEY event. See §6.2. |
| Voice readout | **BES-side ROM audio clips, chained** | Reuse existing `AUD_ID_NUM_0..9`; add 6 new letter clips `A–F` + 1 intro clip. |
| Pairing code source | **Existing BLE name suffix** | The runtime suffix is `%02X%02X` of BT-MAC bytes `[1],[0]` → 4 **hex** chars (e.g. `E7FA`). Already advertised, already device-unique. |
| **Bonded-phone policy** | **Single bonded phone — new pairing replaces (evicts) the old bond** | Ownership transfer. The moment a new phone pairs, the previous phone loses silent-reconnect access and would itself need pairing mode to return. Exactly one trusted phone at a time. |
| **Photos on ownership transfer** | **Wipe is required to transfer ownership; declining aborts pairing** | If a previous bond existed, the app shows a required destructive confirmation. Confirm -> `wipe_media` deletes the entire `getDefaultMediaDirectory()` tree and the bond is finalized. Decline -> pairing aborts (disconnect, previous owner's bond restored, no data touched). |
| Scope/sequencing | This design doc first, then implement | Implementation order in §9. |

## 4. How it works today (recon summary, with file:line)

### 4.1 Mobile app
- Flow: `select-glasses-model.tsx` → `prep.tsx` → `scan.tsx` → `loading.tsx`/`btclassic.tsx` → `success.tsx`.
- `prep.tsx` Mentra Live guide is just a power-on video, then `advanceToPairing()` → `push("/pairing/scan")` (`mobile/src/app/pairing/prep.tsx:226-257, 210`).
- `scan.tsx` starts a scan (`BluetoothSdk.startScan(deviceModel)`, `scan.tsx:60-70`), lists results, and on tap calls `BluetoothSdk.connect(device)` (`scan.tsx:100-118`).
- The list shows only a **stripped suffix** of the BLE name — `filterDeviceName()` removes `MENTRA_LIVE_BLE_`, `Mentra_Live_`, etc. (`scan.tsx:120-127, 172-183`). MAC/UUID/RSSI are **not** shown.
- Native filters by name prefix: `"Xy_A"`, `"XyBLE_"`, `"MENTRA_LIVE_BLE"`, `"MENTRA_LIVE_BT"`, `mentra_live*` — Android `mobile/modules/bluetooth-sdk/android/.../sgcs/MentraLive.kt:963-983`, iOS `mobile/modules/bluetooth-sdk/ios/Source/sgcs/MentraLive.swift:835-859`.
- "Remembered device" = `device_name` + `device_address` persisted in DeviceStore/settings; reconnect via `connectDefault()` → `connectById(name)`. No bonded-only gate, no pairing-mode concept.
- `PairingModeRequest` protobuf exists but is an **empty stub** (`mentraos_ble.pb.swift:599-607`).

### 4.2 asg_client (MTK Android, glasses)
- Pure relay between phone and BES over UART (`/dev/ttyS1` @ 921600). Buttons, LED, advertising, BLE, audio all physically live on **BES**; asg_client just sends/receives K900 JSON.
- Button events arrive as K900 (`McuEventParser.java:44-150`) → `ButtonEventSubscriber.java`. Only short/long today.
- Status LED via `K900RgbLedController` (`cs_ledon`), but **BES owns the LED** until MTK claims authority with `android_control_led` (`PhoneReadyCommandHandler.java:171-204`).
- **No Android TTS**; audio is pre-recorded assets over I2S (`I2SAudioController.java`).
- Glasses BT MAC available via `SysProp.getBesBtMac()` (`persist.mentra.live.mac`).
- **No bonded-phone storage on the glasses side** — bonding is a BES + phone concern.

### 4.3 BES firmware (`mentra-live-bes`) — the decisive layer
- Custom app logic in `apps/xysmart/m8_*.cpp`. Command list in `apps/xysmart/m8_cmdlist.h`.
- **BLE connect handler:** `bthost/service/ble_app/app_main/app_ble_customif.c:52` `app_ble_customif_connect_event_handler()`. Already demonstrates rejecting a connection: during active SCO it calls `app_ble_start_disconnect(conidx)` (`:60-63`). Peer address available as `event->p.connect_handled.peer_bdaddr`.
- **Bond store / lookup:** `services/nv_section/userdata_section/nvrecord_ble.c`:
  - `nv_record_blerec_is_paired_from_addr(uint8_t *pBdAddr)` (`:330`) — true if peer BD addr is bonded.
  - `nv_record_blerec_get_paired_dev_from_addr()` (`:309`), `nv_record_blerec_get_bd_addr_from_irk()` (`:230`) for RPA/privacy resolution.
  - `nv_record_blerec_add()` (`:369`) adds/updates a bond record.
- **LED:** `apps/xysmart/m8_glass.cpp:178-303` (`lxy_glass_led_red/green/blue/orange/white`, `lxy_glass_flash_blue_led`, etc.) and blink timer `lxy_ble_led_on_off_timer` (`m8_ble.cpp:81-103`). `cs_ledon` JSON handler at `m8_ble.cpp:444-459`.
- **Audio prompts:** `media_PlayAudio(AUD_ID_*, 0)`. Enum in `bthost/stack/bt_if/inc/bluetooth.h:96+`. **Digit clips already exist**: `AUD_ID_NUM_0..9` (`:102-111`). Mentra-custom clips under `#ifdef LXY_CODE` (`:140-163`). Pairing clips `AUD_ID_BT_PAIR_ENABLE/PAIRING/PAIRING_SUC` (`:113-115`).
- **Camera button:** physical button = `APP_KEY_CODE_FN2` (a.k.a. `KEY_BUTTON_RIGHT_BUTTON`). Handler `app_ibrt_glass_customkey_click()` in `services/app_ibrt_v2/src/app_tws_ibrt_ui_test.cpp:1948`; CLICK→photo (`:2069`), LONGPRESS→video (`:2104`), DOUBLE/TRIPLE→events. Registered in the key table at `:2262-2265`.
- **Key event model:** `platform/hal/hal_key.c:828-829` sends `HAL_KEY_EVENT_CLICK + cnt_click`; `MAX_KEY_CLICK_COUNT = RAMPAGECLICK - CLICK = 5` (`:109`). Enum order `platform/hal/hal_key.h:55-59`: CLICK(8), DOUBLECLICK(9), TRIPLECLICK(10), ULTRACLICK(11), RAMPAGECLICK(12). **⇒ 4 taps = ULTRACLICK, 5 taps = RAMPAGECLICK.** Long-hold tiers exist too: `APP_KEY_EVENT_LONGLONGPRESS`.
- **BLE name construction:** `services/nv_section/userdata_section/nvrecord_bt.c:991-1002` — `sprintf(pble_name, "%s%02X%02X", "Mentra_Live_", btd_addr[1], btd_addr[0])`. So the suffix is 4 hex chars derived from the MAC. (`config/.../tgt_hardware.c:89 BLE_DEFAULT_NAME="XyBLE_3008"` is only the compile-time default.)

## 5. Design overview

**Unify identity + security around one value: the 4-hex-char code already in the BLE name** (`Mentra_Live_E7FA` → code `E7FA`).

- The glasses **speak** that code in pairing mode.
- The phone **only shows units that are in pairing mode** in the scan list (filtered by adv-data flag — invisible otherwise).
- A new central is only allowed to **bond** while pairing mode is active; otherwise BES rejects non-bonded connections.

A user taps 5×, hears/sees `E7FA`, and the app shows exactly that unit — solving (A); and because non-pairing-mode units are invisible to scanners and reject connections at the BLE layer, (B) is solved.

### Expected behavior (final)

- **Fresh / factory-reset glasses (unbonded):** auto-enter pairing mode on power-on — no gesture. Discoverable + connectable by any phone while unbonded. Indicators (LED + voice) run for a ~120s window then go quiet, but the device stays pairable indefinitely until a phone bonds.
- **Bonded phone:** always reconnects silently — no gesture, no code. Day-to-day owner experience unchanged.
- **Any other phone (e.g. Cayden's):** once a bond exists, refused at the BLE layer unless the glasses are in pairing mode, and absent from BLE scan lists (adv flag clear).
- **Pairing a new (already-owned) phone — step by step:**
  1. Open Mentra app → pair new device → Mentra Live.
  2. App instructs: *"New glasses pair automatically. If nothing appears, hold the power + camera buttons together for 10 seconds until they flash and read out a code."*
  3. If bonded, user holds both buttons 10s → glasses enter pairing mode (LED flashes, voice speaks code). If unbonded, already in pairing mode from boot.
  4. User presses **Continue** on the phone.
  5. Phone connects (only pairing-mode units are discoverable; auto-connects to the one in range).
  6. **If glasses had a previous bond:** app requires a wipe to proceed — *"To use these glasses, the previous owner's photos and videos must be deleted. Delete and continue?"* → **Delete & Continue** (wipe + finalize bond) or **Decline** (pairing aborts: disconnect, previous owner restored, nothing changes).
  7. **If first-time pairing:** completes silently, no prompt.
  8. On finalize, old bond evicted. Pairing mode exits. New phone is the sole trusted device.

## 6. BES firmware implementation (primary)

### 6.1 Pairing-mode state
Add a global `static bool g_pairing_mode` (plus an entry timestamp) in `m8_glass.cpp` (or a new `m8_pairing.cpp`).
- Enter: on the power + camera GROUPKEY held for 10 seconds, OR automatically on boot if unbonded (see 6.8).
- Indicators (LED + voice) run for a ~120s window, then stop. `g_pairing_mode` clears on the timeout, successful new bond, or power events.
- Derived predicates (depend on bond count, not the indicator timer):
  - Discoverable (adv flag): `g_pairing_mode || bond_count == 0`.
  - Accept new connection: always if `bond_count == 0`, else only if `g_pairing_mode`.
- Bond count via `nv_record_blerec_enum_paired_dev_addr()` (`nvrecord_ble.c:292`, returns `saved_list_num`).

### 6.2 Gesture: hold power + camera together for 10 seconds (GROUPKEY)
- Register a new GROUPKEY handler using `APP_KEY_CODE_PWR | APP_KEY_CODE_FN2` with event `APP_KEY_EVENT_GROUPKEY_DOWN` or `APP_KEY_EVENT_GROUPKEY_REPEAT` at the 10s mark (verify the exact event/threshold in `hal_key.h` and the GROUPKEY implementation in `app_key.cpp` / `hal_key.c`).
- Wire to a new `lxy_pairing_mode_enter()` function.
- **No video conflict:** GROUPKEY is a completely separate event path from the single-button LONGPRESS (video) and CLICK (photo). Holding both buttons simultaneously never triggers either.
- **Power-off conflict check:** holding the power button alone for a long time triggers shutdown (`app_tws_ibrt_ui_test.cpp:2020-2025`). The GROUPKEY (both buttons together) is distinct from power-alone long press — verify no overlap in the key handler dispatch.
- Verify `APP_KEY_CODE_PWR | APP_KEY_CODE_FN2` GROUPKEY is not already registered elsewhere (`apps/main/apps.cpp:790-819`).

### 6.3 Bonded-only connection gating
In `app_ble_customif_connect_event_handler()` (`app_ble_customif.c:52`), after the SCO guard, add:

```c
uint8_t *peer = event->p.connect_handled.peer_bdaddr.addr;   // resolve RPA via IRK if needed
bool bond_exists = (nv_record_blerec_enum_paired_dev_addr(addr_buf) > 0);
if (bond_exists && !g_pairing_mode && !nv_record_blerec_is_paired_from_addr(peer)) {
    LOG_I("[PAIR-GUARD] rejecting non-bonded central conidx=%d", conidx);
    app_ble_start_disconnect(conidx);
    return;
}
```

**Critical:** the `bond_exists` guard is required. On a fresh/unbonded device nothing is paired, so without it this would reject every phone and lock the device out of pairing entirely. An unbonded device always accepts (it is in/auto-enters pairing mode anyway).

- **Privacy/RPA caveat:** iOS/Android centrals use resolvable random addresses. The raw `peer_bdaddr` may not match the stored identity address until resolved. Use the existing IRK path (`nv_record_blerec_get_bd_addr_from_irk`, `nvrecord_ble.c:230`) / the LTK-report flow (`app_ble_customif_encrypt_ltk_report_event_handler`, `:210`) to gate at the right moment. Recommended: **defer the hard gate to the encrypt/LTK stage** and additionally disallow GATT data callbacks until bonded.
- **Hardening (recommended):** when bonded and idle, set the advertising filter policy to **accept-list (whitelist) only** with the bonded device added; switch to **allow-all** in pairing mode. Verify the adv-filter API in `bthost/service/ble_app/app_main/app.c` / `app_ble_core.c`. This stops a non-bonded central from ever completing a link, stronger than app-layer disconnect.

### 6.4 LED flash
While `g_pairing_mode`, drive a distinctive pattern (proposed: blue blink ~500/500 ms, infinite) using the existing blink timer:
- Reuse `g_ledtimer_control_*` + `lxy_ble_led_on_off_timer` (`m8_ble.cpp:81-103`) or call `lxy_glass_flash_blue_led()` on a periodic timer.
- On exit, stop the timer and clear LEDs (`lxy_glass_leds_off()`).
- BES owns this LED, so no `android_control_led` handoff is needed for the pairing indicator.

### 6.5 Voice readout
On a repeating timer (proposed every ~6 s while in pairing mode):
1. Play intro clip (new): *"Pair with Mentra Live using the app. Your code is"* → add `AUD_ID_PAIRING_INTRO` in the `LXY_CODE` block of `bluetooth.h` and its audio resource.
2. Chain the 4 code characters with a short gap. Digits reuse `AUD_ID_NUM_0..9`. **Hex letters A–F need 6 new clips** → add `AUD_ID_LETTER_A..F`.
- `media_PlayAudio` is fire-and-forget; chain via the audio-finished callback or a short inter-clip timer so clips don't clobber each other.
- Helper `lxy_pairing_speak_code()` reads `bt_global_addr[1], bt_global_addr[0]`, formats `%02X%02X`, maps each nibble char to its `AUD_ID_*`.
- **Audio assets to produce:** intro phrase + `A,B,C,D,E,F` (6). Digits already exist.

### 6.6 New-bond bookkeeping — single bonded phone (replace on re-pair)
- On a successful new pairing/bond while in pairing mode (`app_ble_customif_connect_bond_event_handler`, `:83`):
  1. **Evict any prior bond(s)** so exactly one phone remains trusted — clear the previous record(s) in `nvrecord_ble.c` before/while adding the new one via `nv_record_blerec_add()` (`:369`). Confirm the saved-list capacity and whether to hard-clear vs. overwrite the single slot.
  2. Exit pairing mode, stop LED/audio, optionally play `AUD_ID_BT_PAIRING_SUC`.
- Effect: the previously bonded phone immediately loses silent-reconnect access; to return, it must go through pairing mode like any new phone.

### 6.8 Auto-enter pairing mode on unbonded boot
On boot, after nvrecord + BLE init (hook in/near `lxy_ble_init()`, `m8_ble.cpp:1075`), check bond count via `nv_record_blerec_enum_paired_dev_addr()` (`nvrecord_ble.c:292`). If `bond_count == 0`, call `lxy_pairing_mode_enter()` so a fresh/factory-reset device is immediately pairable with no gesture.
- Indicators (LED + voice) run for the ~120s window then stop (windowed).
- Discoverability + acceptance persist while unbonded regardless of the timer, since those predicates (6.1) depend on `bond_count == 0`.
- After the first successful bond, normal gating (6.3) takes over.

### 6.7 Media wipe on ownership transfer (required)
**Decision:** after a new phone bonds, if the glasses had a previous bond, the app **requires** a media wipe to complete pairing. Declining aborts pairing and restores the previous owner.

**Flow:**
1. New phone connects to glasses in pairing mode; SMP bond forms **provisionally** (old bond not yet evicted).
2. Glasses signal `{"type": "pairing_info", "had_previous_bond": true/false}` immediately post-connect.
3. **If `had_previous_bond: true`:** app shows a required confirmation: *"To use these glasses, the previous owner's photos and videos must be deleted. Delete and continue?"*
   - **Delete & Continue** → app sends `{"type": "wipe_media"}` → asg_client wipes `getDefaultMediaDirectory()` → replies `wipe_media_result` → BES finalizes (evict old bond, keep new) → pairing completes.
   - **Decline** → app `disconnect()` + `forget()` (no default device set); BES rolls back the provisional new bond and keeps the previous owner; nothing is wiped. User sees "Pairing cancelled."
4. **If `had_previous_bond: false`:** finalize immediately, no prompt.

See plan workstream 1g for the BES provisional-bond / rollback sequencing.

**asg_client implementation:**
- Add a new `WipeMediaCommandHandler` (or extend `GalleryCommandHandler`) handling command type `"wipe_media"`.
- On receipt: recursively delete everything under `fileManager.getDefaultMediaDirectory()` (the `com.mentra.asg_client.camera` package dir), using the existing `MediaUtils.deleteMediaFile()` per file and then remove subdirectories.
- Also cancel any in-progress uploads in `MediaUploadQueueManager`.
- Reply with `{"type": "wipe_media_result", "success": true/false}`.

**Key files:**
- `asg_client/.../io/file/core/FileManagerImpl.java:660` — `getDefaultMediaDirectory()`
- `asg_client/.../io/media/utils/MediaUtils.java:184` — `deleteMediaFile()`
- `asg_client/.../io/media/managers/MediaUploadQueueManager.java` — cancel queued uploads
- `asg_client/.../service/core/processors/CommandProcessor.java` — register new handler

## 7. asg_client changes (light / optional)
With the BES-only design, asg_client needs **no functional change**. Optional: relay a `pairing_mode` status event to the phone so the app can show "glasses are in pairing mode."

## 8. Mobile app changes
1. **`prep.tsx` (`MentraLivePairingGuide`, `:226`):** replace the current single power-on step with a two-step guide:
   - Step 1: power on the glasses (existing video).
   - Step 2: *"Hold the power button and camera button together for 10 seconds. The glasses will flash and read out a code."* → **Continue** button.
2. **`scan.tsx`:** on Continue, start scanning for pairing-mode units (adv flag filter). **Auto-connect to the first unit found.** No list in the common case. Show a list only if multiple pairing-mode units are found simultaneously.
   - **Timeout handling:** if no pairing-mode unit is found within ~15s, show *"No glasses found. Make sure you've tapped the camera button 5 times, then try again."* with a **Try Again** button that returns the user to the tap-5× step in `prep.tsx`.
3. **`loading.tsx` / post-connect:** listen for `pairing_info` event (`had_previous_bond: true/false`). If true, show media-wipe confirmation before proceeding to `success.tsx`. If false, proceed directly.
4. **Native discovery filter** (`MentraLive.kt:963`, `MentraLive.swift:835`): after matching the name prefix, check for pairing-mode flag in adv payload before emitting `device_discovered`.
5. **Reconnect:** `connectDefault()` unchanged — bonded phone still auto-reconnects silently.
6. **i18n:** new strings in `pairing:`/`onboarding:` namespaces.

## 9. Proposed implementation order
1. **BES bonded-only gating** (§6.3) — biggest security win, testable in isolation (verify a 2nd phone is refused while a bonded phone is away).
2. **BES pairing-mode state + 5× gesture + LED** (§6.1, 6.2, 6.4).
3. **BES voice readout + audio assets** (§6.5).
4. **BES single-bond eviction on new pairing** (§6.6).
5. **asg_client `WipeMediaCommandHandler`** (§6.7).
6. **Mobile `prep.tsx` + `scan.tsx` + wipe confirmation modal** (§8).
7. **Optional:** adv-data pairing flag + whitelist hardening (§6.3, §10).

## 10. Open questions / risks
- **RPA resolution timing.** Gating on `peer_bdaddr` at connect may misfire with resolvable random addresses; likely need to gate at the encrypt/LTK stage. Needs device testing.
- **Adv-data pairing flag implementation.** BES must add a flag/byte to the advertising payload when in pairing mode (verify `app_datapath`/`app_customer_pz_advdata.c`), and clear it on exit. Phone native layer filters on this flag — verify the adv payload is accessible in `ScanResult` (Android) and `CBAdvertisementDataManufacturerDataKey` (iOS) at the discovery callback point.
- **Whitelist vs app-layer disconnect.** App-layer disconnect is simpler; controller accept-list is more secure. Prefer accept-list if the SDK exposes it cleanly.
- **Inter-tap timing for 5×.** Confirm `KEY_DOUBLECLICK_THRESHOLD` allows a comfortable 5-tap window; tune if needed.
- **Audio clip production.** Need recorded assets for the intro phrase and A–F; match existing prompt voice/format.
- **Backward compatibility / OTA.** Already-bonded glasses keep reconnecting to their phone after the update. New pairing requires the updated app that knows the 5× flow.

## 11. Key file index

**BES firmware (`~/Documents/mentra-live-bes`)**
- Connect gating: `bthost/service/ble_app/app_main/app_ble_customif.c:52` (+ `:83`, `:210`)
- Bond store: `services/nv_section/userdata_section/nvrecord_ble.c:330, 309, 230, 369`
- Camera button handler + key table: `services/app_ibrt_v2/src/app_tws_ibrt_ui_test.cpp:1948, 2030-2107, 2262-2265`
- Key event model: `platform/hal/hal_key.c:828-829, 109`; `platform/hal/hal_key.h:55-59`
- LED + blink: `apps/xysmart/m8_glass.cpp:178-303`; `apps/xysmart/m8_ble.cpp:81-103, 444-459`
- Audio enum: `bthost/stack/bt_if/inc/bluetooth.h:96-163`
- BLE name suffix: `services/nv_section/userdata_section/nvrecord_bt.c:991-1002`
- BT addr / `cs_btaddr`: `apps/xysmart/m8_ble.cpp:595-603`
- Adv start / filter policy: `bthost/service/ble_app/app_main/app.c`, `app_ble_core.c` (TBD)

**asg_client (`MentraOS/asg_client`)**
- Button parse: `app/src/main/java/com/mentra/asg_client/io/peripheral/McuEventParser.java`
- LED authority: `.../service/core/handlers/PhoneReadyCommandHandler.java:171-204`
- MAC: `.../service/utils/SysProp.java`

**Mobile (`MentraOS/mobile`)**
- Prep: `src/app/pairing/prep.tsx:226-257`
- Scan: `src/app/pairing/scan.tsx:60-70, 100-127, 172-183`
- Native filter: `modules/bluetooth-sdk/android/.../sgcs/MentraLive.kt:963-983`; `modules/bluetooth-sdk/ios/Source/sgcs/MentraLive.swift:835-859`
