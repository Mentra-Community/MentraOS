# Mentra Live secure pairing — bug history audit

Regression table of bugs hit while building Mentra Live secure pairing and ownership
transfer (OS-1615 → OS-2055), mapped to the pairing test matrix IDs. Read-only audit,
compiled 2026-10-09 from prior agent chats, PR review threads, canvases, and
`mentra-live-bes/docs/pairing-spec.md` (R1–R14).

## Source legend

| Key | Source |
|---|---|
| `8d049e58` | Transcript 8d049e58-e73f-4397-a72a-28292b67a008 — v1 design and first BES flashes (Jun 17 – Jul 3). Fork: b2186e69-4261-4815-9600-e0e94dec1c00 |
| `d72f271c` | Transcript d72f271c-21fb-4103-bd5c-c6d8326ed427 — OS-1615 v2 plan review (Aug 3) |
| `f1af0285` | Transcript f1af0285-2060-4d02-8207-4f0219152ece — main hardware bring-up session (Aug 5 – Aug 14). Forks sharing its prefix: 5d0c3677, bbacdc9f, 9bb159bf, aa42f15e, 7282da8c, 5c480d37, a61731f8, 5a64b3f2, c58d707a, 4b74dad3, 4f7c7541 |
| `5d0c3677` | Transcript 5d0c3677-fbee-422d-a28b-31abf04a6a41 — discovery-only scan, compatibility matrix (Aug 13) |
| `9bb159bf` | Transcript 9bb159bf-1e90-427e-89db-04ce545feb08 — mixed fleet (old app / new FW) (Aug 13) |
| `5c480d37` | Transcript 5c480d37-50d5-4016-8ebe-d155c01c6943 — Classic owner adoption, spoken-code stitching, test planning (Aug 12 – Aug 20) |
| `a61731f8` | Transcript a61731f8-ec35-456d-a7ae-6fd2046ae8c9 — 30-issue PR audit, Design A decision (Aug 12) |
| `5a64b3f2` | Transcript 5a64b3f2-9f62-4154-b4d6-a248b4e09655 — audit item #10 RPA identity (Aug 12) |
| `4a1a9f1e` | Transcript 4a1a9f1e-338b-45c0-93b2-a469f13c5067 — PR #3224 review-fix pass |
| `416112d2` | Transcript 416112d2-cd02-4646-ac36-3207e6789f04 — OS-2055 session (Oct 8) |
| MOS#3224 | [Mentra-Community/MentraOS#3224](https://github.com/Mentra-Community/MentraOS/pull/3224) (merged 2026-08-24, Rule Alpha app/ASG) |
| MOS#4567 | [Mentra-Community/MentraOS#4567](https://github.com/Mentra-Community/MentraOS/pull/4567) (open, OS-2055 app flag + owner-lost) |
| BES#2 | [Mentra-Community/mentra-live-bes#2](https://github.com/Mentra-Community/mentra-live-bes/pull/2) (merged 2026-08-24, Rule Alpha firmware) |
| BES#91 | [Mentra-Community/mentra-live-bes#91](https://github.com/Mentra-Community/mentra-live-bes/pull/91) (open, OS-2055 three-press + R14 adoption) |

`f1af0285:259` means transcript `f1af0285`, JSONL line 259. "Bugbot" and "cubic" are
the inline review bots on the named PR; "Codex" is the local Codex review posted by nic-olo.

## Regression table

| # | Bug (symptom) | Root cause | Source | Fixed in | Still relevant? | Case ID(s) |
|---|---|---|---|---|---|---|
| 1 | Every boot asserts `nv_record_blerec_enum_paired_dev_addr` → crash loop right after first pairing FW flash | `lxy_pairing_init()` ran from `lxy_ble_init()` (~2.8 s) before `nvrecord_ble_p` existed (~9.3 s) | `8d049e58:404` | BES `05e510a7e3` (defer init to `app_ble_customif_init`) | Yes — D-NVRACE / R9: no NV read before BLE NV is up | C7, A4, A3 |
| 2 | Same NV-enum assert boot loop returns after OS-1615 v2 flash (unit never advertises) | First MTK UART frame → `lxy_pairing_on_mtk_ready` → `set_radio_exposed` → `load_owner_from_nv` before BLE NV init; crash dump over UART retriggers it | `f1af0285:259`, `f1af0285:266`, `f1af0285:776` | BES `1052d22907` (null-safe enum, `g_pending_radio_expose`) | Yes — D-READY now couples pairing to MTK frames, so MTK-before-BES-NV ordering is the exact risk | A4, C7, A3 |
| 3 | MemFault data access violation `MMFAR=0x20056681` right after `app_ble_customif_init` | New journal wrote into MPU read-only NV extension mirror without `nv_record_pre/post_write_operation` bracket | `f1af0285:313`, `f1af0285:340` | BES `1052d22907` | Partly — journal removed by Rule Alpha, but owner-record and bond-delete NV writes still need the bracket | A4, D1, C1 |
| 4 | Built BES image cannot OTA: 1,984,252 B (and later debug build 1,966,652 B) vs 1,966,080 B limit; several builds shipped with 4–836 B margin | Pairing code + TRACE strings growth; debug probes; `-O2` fall-through | `a61731f8:706` (#23), `f1af0285:798`, `f1af0285:379`, `f1af0285:1543` | Shrinks across BES#2; BES#91 build 1,934,364 B | Yes — 31.7 KB margin, warning band | I1, I4 |
| 5 | No owner and not in pairing, yet phones can still Classic-connect | `lxy_pairing_should_reject_classic()` written but never wired to ACL path; no-owner state left `CONNECTABLE_ONLY` | `f1af0285:64`, `f1af0285:67` | BES branch Aug 5 (`[BT-PAIR-GUARD]` ACL hook, `NOT_ACCESSIBLE`), folded into `1052d22907` | Yes — R8 / D-EXPIRY "fully locked" | E2, F1 |
| 6 | Glasses still visible in BLE scans when radio should be hidden (MTK not ready, no window) | Debug leftover `lxy_pairing_radio_exposed() \|\| true`; ADV not torn down on radio hide; `SCAN_ANY` | `f1af0285:80` | BES branch Aug 5 (`ble_adv_is_allowed` gates on `radio_exposed`) | Yes — `NOT_EXPOSED` state | NEW-1, E1 |
| 7 | Phone/app disconnect makes glasses auto-enter pairing (LED + code) | Vendor flags `enter_pairing_on_mobile_disconnect` and `enter_pairing_on_reconnect_mobile_failed` left true | `f1af0285:54` | BES branch Aug 5 (`app_ibrt_customif_ui.cpp`) | Yes — R1/R3: absent bonded owner never opens pairing | C3, A6, E3 |
| 8 | Five-tap while already in pairing only re-speaks the code; old phone keeps the only BLE slot (`arrive at max connection`, `[ADV] not allowed`) | Re-entry shortcut skipped disconnect; `BLE_CONNECTION_MAX=1`; ADV refresh raced async slot free | `f1af0285:127`, `f1af0285:424` | BES `0d607dcad8` (every entry runs `mode_enter` + delayed ADV refresh) | Yes — R4 "re-entry restarts the window" | B6, D3, C1 |
| 9 | After five-tap, Phone A immediately re-pairs/reconnects and blocks Phone B | PAIRING admitted any first central and BES did not remember the evicted owner; app had no stand-down | `f1af0285:835` (Aug 12 report) | MOS `7a85a65ec2` (`entering_pairing_mode` yield) + BES `ba3daf3260` (bonds deleted on entry) | Yes — R4 notify-then-disconnect | D2, D4, C1 |
| 10 | Five-tap shows no blue LED and nothing in UART ("not entering pairing") | Disconnect/teardown moved ahead of LED start; `RAMPAGECLICK` TRACE stripped for size | `f1af0285:366`, `f1af0285:379` | BES branch Aug 5–6 (LED-first enter) | Yes — LED must start on entry regardless of teardown | F5, B1, C1 |
| 11 | v1 click counter never passes 2 presses; window expires | BES HAL never emits repeated CLICK; it classifies DOUBLE/TRIPLE/RAMPAGE clicks | `8d049e58:418`, `8d049e58:425` | BES `37f8bd8096` | Yes in new form — three-press counting must sum multiclick events | B1, B2, B3 |
| 12 | Presses arrive as separate `sr_keyevt` click/double/triple events; RAMPAGECLICK needs <~400 ms spacing; same press can be counted twice | Two press encodings (HAL multiclick + `sr_keyevt`); timing-sensitive coalescing | `f1af0285:379`, `416112d2:411` | Three-press window in BES#91 (`a3d0344563`) | Yes | B3, B4, B5 |
| 13 | Pairing window closes ~700 ms after entry; old phone refills the BLE slot | HAL emits a trailing CLICK ~400 ms after the gesture → `lxy_pairing_cancel_if_active()` single-click cancel | `f1af0285:1408` | BES branch Aug 13 (ignore cancel for 2 s after entry) | Yes — R7 single-click cancel still exists | B11, NEW-2 |
| 14 | Long-press power-off stops working after pairing FW | `CFG_SW_KEY_LLPRESS_THRESH_MS=10000` + removed LONGLONGPRESS; LXY LONGPRESS path (UART → Android → 600 ms timer) fragile | `8d049e58:436`, `8d049e58:506` | BES `47e3781fb4`, `a4226ef072` (`app_bt_key_shutdown` fallback) | Yes — R2 "~2 s power-off unchanged" | B9, K1–K5 |
| 15 | Power long-press handled inconsistently | Duplicate PWR LONGPRESS registration (vendor + LXY custom) in the key table | `f1af0285:1556` | Unknown (identified only) | Yes | B9 |
| 16 | Real owner's BLE reconnect after glasses power cycle rejected in a loop (GATT 19 storm) while Classic audio returns | `should_reject_connection` raw-matched NV identity; phone uses rotating RPA | `f1af0285:568`, `f1af0285:580` | BES `4f0a7c6a67` (match by RPA / Classic ACL) | Yes — R8 "RPA owners resolve through NV identity" | E7, E3 |
| 17 | Owner reconnect after phone-side disconnect loops on GATT 19 | App tore down Classic A2DP/HFP before BLE connect, removing the only admit path for RPA phones; `isReconnecting` cleared before the check | `f1af0285:804`, `f1af0285:809`; MOS#3224 Bugbot "Owner connect tears Classic ACL" | BES defer-LTK (Aug 13) + MOS `a9c4e60e3e` | Yes | E3, E7, G3 |
| 18 | Audit #10: owner locked out after BLE address rotation | RPA stored as permanent owner identity instead of IRK-resolved identity | `5a64b3f2` (#10), `f1af0285:1248` | BES `6aa0511068` / `ba3daf3260` (identity via NV IRK) | Yes | E7 |
| 19 | Owner Galaxy S22+ gets BLE-only session after reboot; every Classic ACL rejected | `load_owner_from_nv` adopted a stale Classic NV record as owner; self-heal required Classic addr == BLE owner addr (false under BLE privacy) | `f1af0285:1025`, `f1af0285:1032` | BES branch Aug 13 (prefer record matching BLE owner) | Yes — esp. flag-off → flag-on upgrades with leftover records | E3, A3, NEW-12 |
| 20 | First pair: BLE works but Classic ACL always rejected (`state=1`) | First-time finalize committed on BLE bond while provisional Classic was still empty → `g_owner_classic_valid=false` | `5c480d37:721` | BES branch Aug 12 (adopt CTKD Classic after commit; now `g_classic_assoc_open`) | Yes — R6 "keep Classic association open" | D1, D9, G1 |
| 21 | During window, Samsung's Classic killed by `[BT-PAIR-GUARD]` while BLE admitted; A2DP never comes up | Pairing ran a denylist against the "suspended" previous owner; Samsung Classic public addr ≠ BLE RPA | `f1af0285:1200`, `f1af0285:1238` | BES `6aa0511068` (suspend model dropped) | Partly — suspend model gone; R5 single-slot Classic lock remains | D1, E2, NEW-3 |
| 22 | Classic connecting before BLE closes the pairing window (audit Critical #3); Classic audio up treated as "session live" | `on_phone_session_up` / `classic_audio_up` ran full exit without a BLE candidate | `a61731f8:752`, `f1af0285:1471` | BES `ba3daf3260` (commit only on BLE bond; Classic-first slot-locked) | Yes — iOS Settings-first path | NEW-3, D1 |
| 23 | App Unpair leaves glasses owned; next phone stuck in OWNER_ONLY | Unpair only `removeBond`'d the phone; `unpair` write queued without ACK then GATT torn down | `f1af0285:1238`; MOS#3224 Bugbot "Unpair command dropped on disconnect" | BES `6aa0511068`; MOS `9b4d54cc7c` (400 ms flush) | Yes — R10 | NEW-4, E5 |
| 24 | iOS Unpair never destroys the manager; `unpair` write cancelled | Delayed flush captured `MentraLive` weakly; `DeviceManager.forget()` nilled `sgc` | MOS#3224 Bugbot "iOS unpair flush drops MentraLive" | MOS `6d2019857a` | Yes | NEW-4, D6 |
| 25 | After Unpair, Samsung Settings still lists Mentra Live as paired | `removeBond` called while GATT still up; refused during CTKD bonding | `f1af0285:1172` | MOS Aug 13 (GATT first, `removeBond` + 700 ms retry) | Yes | D9, NEW-4 |
| 26 | Classic pairing "takes 30 s"; first Samsung pairing dialog cancels | System pairing dialog held ~30 s and app called `removeBond` mid-CTKD | `f1af0285:480` | MOS `a524c91a7c` | Yes | D9 |
| 27 | `forget()` can race into BOND_BONDING and tear down during system pairing dialog | Bonding check not atomic with teardown | MOS#3224 cubic `DeviceManager.kt:2112` | MOS `e018a76063` | Yes | D9 |
| 28 | Pairing loading screen hangs: Android sees `Mentra_Live_E511` but never GATT-connects | Name-match auto-connect only when `isReconnecting`; `connectById` cleared it | `f1af0285:433` | MOS Aug 6 (`explicitConnectByName`) | Yes | D1 |
| 29 | Named connect bypassed the pairing-discoverable filter (spoof path), then a follow-up blocked saved-device reconnect | Explicit-connect exception skipped the pairing-mode check | MOS#3224 cubic `MentraLive.kt:1133`, Bugbot "Named connect filter regression" | MOS `e018a76063` (reconnect path keeps bypass; explicit connect does not) | Yes | D1, E1, E3 |
| 30 | Pairing success screen waits ~9 s extra on Android | `fullyBooted` gated on CTKD `audioConnected`; iOS used `glasses_ready` only | `f1af0285:686`, `f1af0285:701` | MOS Aug 12 (`MentraLive.kt`) | Yes | D1, G1 |
| 31 | BLE + CTKD bonded but A2DP/HFP never attach (`a2dp con: 0, hfp conn: 0`) | Bond ≠ profile connect; app never called `connectA2dpProfile()` after BOND_BONDED | `f1af0285:399`, `5c480d37:721` | MOS Aug 12 | Yes | D9, G1 |
| 32 | Phone A UI still says "Connected" after glasses enter pairing | Android `closeGattQuietly` nulled GATT before callback; iOS cancel race; yield didn't publish DISCONNECTED | `f1af0285:971`, `f1af0285:975` | MOS `7a85a65ec2` | Yes | D4, C1 |
| 33 | Yielded owner re-attaches during window (A2DP retry, stale `glasses_ready`, queued `didConnect`, overlapping probe loops) | Yield state not fenced against queued callbacks/retries | MOS#3224 cubic `MentraLive.swift:1832/1867`, Bugbot "Pairing yield probes leak on restart" | MOS `a9c4e60e3e`, `9b4d54cc7c` (probe loop removed) | Partly — probe gone; stand-down fencing remains | D4, C1, B6 |
| 34 | Second phone can't see glasses after five-tap because yielded owner still holds A2DP/HFP | Yield closed GATT but left Classic profiles up | MOS#3224 cubic (open reclaim invisible) | MOS `a9c4e60e3e` | Yes | C1, D3 |
| 35 | Normal RF timeout during reclaim wipes saved owner and emits `owner_replaced` | GATT status 8 treated as auth/not-owner | MOS#3224 Bugbot "Timeout treated as owner loss" | MOS `a9c4e60e3e` | Yes — owner-lost card must not fire on RF loss | NEW-5, D4 |
| 36 | Late iOS auth error from an older attempt forgets the device that just reconnected; error matched by localized string | Callbacks not bound to the active peripheral/attempt | MOS#3224 cubic `MentraLive.swift:1017/1018/991` | MOS `9b4d54cc7c`, `6d2019857a` | Yes | D4, D5 |
| 37 | Pair Glasses scan "from scratch" reconnects the previously saved Mentra Live; stale saved name bypasses pairing filter (iOS `PREFS_DEVICE_NAME` not cleared on forget) | Saved-name reconnect path active inside discovery scan | `5d0c3677:1542`, `5d0c3677:1545`; MOS#3224 Bugbot "Stale name bypasses pairing filter", "iOS forget bypasses pairing filter" | MOS `dbaab7e5c3`, `f8d30e4b4b` | Yes | D5, E1 |
| 38 | After opening and backing out of Pair Glasses, GATT drops never auto-reconnect | `manualDiscoveryActive` set by scan, cleared only by `connectById`/`forget` | MOS#3224 Bugbot "Pairing scan disables later reconnect" | MOS `9b4d54cc7c` | Yes | NEW-6, E3 |
| 39 | Abandoned pair leaves pending GATT target; next reconnect goes to wrong glasses or default promoted early | `pending_device_name/address` not cleared on disconnect/abandon, then over-cleared by internal disconnect | MOS#3224 Bugbot "Abandoned pair corrupts saved GATT target", cubic `DeviceManager.swift:943/1764` | MOS `9b4d54cc7c`, `6d2019857a` | Yes | NEW-6, D5 |
| 40 | Forgetting another device (or non-Live) unbonds every Mentra Live Classic bond / a G1 | Live unbond helper ran unconditionally with wrong address | MOS#3224 Bugbot "Forget unbonds unrelated Live bonds" | MOS `a9c4e60e3e`, `9b4d54cc7c` | Yes (low) | D6 |
| 41 | New Mentra App can't find old-firmware glasses (old app still can) | Legacy ADV XOR'd Classic MAC bytes parsed as pairing trailer → `securePairingCapable=true, pairingMode=false` → hidden | `f1af0285:1586`, `f1af0285:1587`, `5d0c3677:1550` | MOS `de7ea7ac9a` (version/capability heuristic); spec v2 `MP` marker | Yes — heuristic still ambiguous until marker required | H2 |
| 42 | Scan results lose `pairingMode` / `pairingCode` / `securePairingCapable` (no code, no legacy label) | `Device.fromMap` / iOS `init(values:)` don't read the fields | MOS#3224 Bugbot "Pairing fields dropped on deserialize", cubic; `4a1a9f1e:6` | MOS#3224 (Aug 12–14) | Yes | E1, H2 |
| 43 | iOS reads pairing flag at wrong byte / trusts any manufacturer payload | Index includes company ID on iOS but not Android; no `0xB822` check | MOS#3224 Bugbot "iOS pairing flag byte index", cubic `MentraLive.swift:1229/1340` | MOS#3224 (`parseSecurePairingTrailer`) | Yes | E1, H2 |
| 44 | Loading screen stuck forever when `pairing_info` never arrives; later the 5 s fallback armed before secure capability was known | Success gated on `pairing_info`; fallback not gated on `securePairingCapable` | MOS#3224 Bugbot "Stuck if pairing_info missing", security review `loading.tsx:142` | MOS `e018a76063` | Yes | H2, D1 |
| 45 | Legacy `pairing_info` without `secure_pairing_capable` treated as secure | Parser defaulted missing field to true | MOS#3224 cubic (Android + iOS) | MOS#3224 (Aug 5) | Yes | H2 |
| 46 | Single-unit auto-connect spins forever after permission deny; 15 s timeout hides found devices; Try Again pops two screens | `connectingRef` not reset; timeout ignored existing results; double `goBack` | MOS#3224 Bugbot/cubic (`scan.tsx:185/308/324/328`) | MOS `dbaab7e5c3`, `e018a76063` | Yes (app UX) | NEW-7 |
| 47 | Prep says "press 5×" while no-glasses hint says "hold both buttons 10 s" | Copy not updated with gesture change | MOS#3224 Bugbot "Conflicting pairing gesture copy", cubic `en.ts:146` | MOS#3224; MOS#4567 rewrites copy for three-press | Yes — gesture changed again (3 presses) | NEW-8, J1 |
| 48 | Agent debug HTTP ingest (`127.0.0.1:7905`, `#region agent log`) shipped in pairing/scan code | Leftover debugging instrumentation | `a61731f8:706` (local #7); MOS#3224 Bugbot "Accidental debug ingest left in" | MOS `a9c4e60e3e` | Yes (process) | NEW-9 |
| 49 | Pairing voice prompts silent (`length=0` for `AUD_ID_NUM_*`, `AUD_ID_ANC_PROMPT`) | Placeholder prompt clips empty in BES image | `f1af0285:402`, `f1af0285:424` | BES `fe9c5f3a0c` (intro) + MOS `54265533b5` (ASG `hm_spkcode`) | Yes | J1, F4 |
| 50 | Spoken code glitches on restart; pairing code logged in plaintext; failed I2S playback reported as success | Shared `pairing_code.wav` truncated while playing; INFO logs; `playFile` returns void | MOS#3224 Bugbot "Pairing cache overwritten during playback", cubic `PairingCodeSpeaker.java:25/42`, `I2SAudioController.java:147` | Not marked fixed in thread | Yes — re-entry re-speaks the code | F4, B6, J1, NEW-9 |
| 51 | Blue LED keeps blinking after phone connects / while Classic attaches; LED lost when MTK claims LEDs | Indicators stopped only at bond/finalize; no LED reclaim from MTK | `f1af0285:528`, `f1af0285:402` | BES `4f0a7c6a67` | Yes — R6 stop indicators on commit | F5 |
| 52 | Accept list never populated, so owner reconnect relied on open ADV; adv could stay off after a failed start | Accept-list setup functions never called; `isStartAdvFailbf` cleared only on disconnect | `f1af0285:147` (audit) | BES `1052d22907` / `0d607dcad8` | Yes — R8 accept-list ADV | E1, E3, F6 |
| 53 | Window timeout with no owner leaves glasses in OWNER_ONLY "dead-end"; first-time pair rejected until five-tap | `window_rollback` fell back to OWNER_ONLY with no owner | `f1af0285:1143` (H1) | Now intended behavior (BES `ba3daf3260`, D-EXPIRY); R3 auto-pair on next boot | No as bug — now spec; test the spec | F1, A5 |
| 54 | Three presses open the window before MTK is up (no "not ready" prompt) | No `lxy_uart_android_is_ready()` gate on entry | BES#91 summary, `416112d2:136` | BES#91 `a3d0344563` | Yes — D-READY | A1, A2, A3 |
| 55 | iPhone upgraded from flag-off firmware loses Mentra BLE (Classic-only owner, BLE rejected) | Flag-off firmware never requested SMP, so no BLE bond; owner-only gate rejects its BLE address | BES#91 summary, `416112d2:99`–`416112d2:138` | BES#91 `a3d0344563` (R14 adoption) | Yes | R14-1, R14-2, R14-3 |
| 56 | Adoption never completes when BLE address equals the Classic address | Peer classified OWNER, so `g_adopt_conidx` never set and SMP refused | BES#91 Bugbot "Adoption skips Classic-matching BLE peers" + Codex [P2] | BES#91 `37a5c03ce7` | Yes | R14-2, NEW-10 |
| 57 | Stalled adoption candidate holds the only BLE slot forever | Reap callback read generation from `p1` but timer delivers it as `id`; reap also armed only in PAIRING | BES#91 Bugbot "Adopt reap timer never fires" + Codex [P2] ×2 | BES#91 `37a5c03ce7`, `2160322800` | Yes | F7, D3, NEW-11 |
| 58 | Cancelled/failed adoption SMP deletes the Classic owner → forced physical re-pair | `GAPC_PAIRING_FAILED` → `on_bond_deleted(solvedBdAddr)` → `clear_owner` | BES#91 Codex [P2] `m8_pairing.cpp:1766` | BES#91 `17dcb05ab4` | Yes | R14-3, NEW-11 |
| 59 | Failed adoption leaves a live BLE link holding the slot | Candidate cleared and reap stopped without disconnect | BES#91 Bugbot "Failed adopt SMP drops retry slot" + Codex [P2] | BES#91 `0ba3dc99ae` | Yes | NEW-11, D3 |
| 60 | Stood-down phone (owner lost) reconnects endlessly | Foreground `decideReconnect` still saw a default device; iOS `connectById` rebuilt `centralManager` after `destroy()` | MOS#4567 Bugbot "Owner-loss still auto-reconnects" | MOS#4567 (`ownerLost` guard, `isKilled` check) | Yes | D4, D8, G5 |
| 61 | Android Bluetooth OFF/ON reconnects to glasses another phone owns | BT-on path rebuilt `MentraLive` from saved identity; new instance lacked stand-down state | MOS#4567 Codex P2 `MentraLive.kt:2023` | MOS#4567 `e0a5a75f93` | Yes | G3, D4 |
| 62 | Owner-lost flag never clears for SDK-only hosts after forget/re-pair | Only the engine cleared `mentra_live_owner_lost` | MOS#4567 Codex P2 `DeviceManager.kt:2343` | MOS#4567 `28d5f42529` | Yes | D6, D7 |
| 63 | Successful re-pair undone: owner-lost `true` written back after native clear | Key not `nativeAuthoritative`; JS on-connect settings replay overwrote it | MOS#4567 Bugbot "Owner-lost flag can be overwritten" | MOS#4567 `462cb956af` (not in published APK `28d5f42`) | Yes | D7, D8 |
| 64 | Old Mentra App + new firmware: old phone never stands down and parks on the BLE slot; gets Classic audio but BLE rejected after commit | Old app ignores `entering_pairing_mode`; new FW refuses SMP outside window | `9bb159bf:1500`, `f1af0285:1467`, `f1af0285:1477` | Declared unsupported (MOS#3224 / BES#2 matrix) | Yes — expected-behavior documentation | H1 |
| 65 | "Connected" plays on Classic before MTK has booted (OS-1614 baseline complaint) | Classic exposed before MTK ready; prompts tied to link events | `8d049e58:8` | BES#2 (radio gate + Classic-aggregate prompts) | Yes — R11 + radio gate | G1, NEW-1 |
| 66 | iOS re-emits a unit as `pairingMode=true` after its window ended | `discoveredAdvPairing` cache survived across scans | MOS#3224 cubic `MentraLive.swift:5578` | MOS `9b4d54cc7c` | Yes | F1, F6 |
| 67 | Already-GATT-connected unit emitted into Pair Glasses scan as `pairingMode=true, securePairingCapable=false` (would auto-connect as legacy) | `emitConnectedDeviceForPairingScan()` hardcodes flags | MOS#3224 Bugbot "Connected glasses skip pairing-mode gate" + cubic | Dismissed as intentional (Design A) | Unverified under Rule Alpha — owner should be standing down | E1, C1 |
| 68 | Unpair during CTKD bonding refused or half-applied | Settings unpair path bailed while bonding | `f1af0285:1172`, MOS#3224 cubic `DeviceSettingsSection.tsx` | MOS Aug 13, `e018a76063` | Yes | D9, NEW-4 |

## Obsolete

These bugs belong to removed designs. They do not need regression cases, but any
reappearance of the code paths is itself a regression against the spec's
"Forbidden designs" list.

- **Five-tap / 20-click gesture family.** Five-tap (`RAMPAGECLICK`) and the 20-click
  factory reset (BES `061e0a6aeb`, `37f8bd8096`), the 10 s power+camera GROUPKEY
  (`67fcb981b1`), and the LLPRESS override. The gesture is now three presses (R2). Row 11
  and row 13 carry over only as press-counting and cancel-guard risks.
- **Provisional transfer / Design B.** The rollback cleared `g_pending_conidx` before
  disconnecting (`d72f271c:16`). Five-tap wiped bonds before it computed
  `had_previous_bond`, so the transfer was bypassed (`a61731f8:706` Critical #1). The
  finalize lost-response replay cache was overwritten with `g_transfer_id=0`
  (`f1af0285:151`). `abortPairingTransfer` hung for 15 s, and `pairing_finalize`/`abort`
  were not forwarded to ASG (`f1af0285:147`). Stale acks resolved the wrong transfer
  promise, `pairing_transfer_status_result` was unregistered, a failed transfer cleared
  the active id, and back/cancel skipped the abort or aborted after finalize (MOS#3224
  Bugbot/cubic). The `transfer_id` was not validated in `m8_ble.cpp` (BES#2 security
  review). All of this was removed in MOS `a6291fbb19` and BES `ba3daf3260`.
- **Session-up commit (headphone model).** BES `cbb0c7fe84` committed ownership on
  Mentra session up. That is now forbidden ("Commit ownership on `phone_ready`, Mentra
  session-up, or Classic audio").
- **Suspended-owner preservation.** The owner was snapshotted on entry and admitted
  during the window (`f1af0285:1533`, BES `6aa0511068`). This is replaced by R4's
  destructive entry.
- **Media wipe.** The capture barrier was never cleared. `children == null` reported
  success. An empty gallery skipped the wipe prompt. A late `pairing_info` skipped the
  wipe. The barrier was armed too late, and the photo-upload and video paths were
  ungated. Deferred JPEG writes could land after the wipe was verified. Warm-up cancel
  left `isWarmingUp` stuck. The wipe could exceed the 15 s wait, and
  `CountDownLatch.await()` blocked an Expo thread. The `ENABLE_PAIRING_MEDIA_WIPE`
  constant was folded at compile time (MOS#3224 Bugbot/cubic, `5c480d37:849`). Philippe
  asked to remove automatic wipe, and it was removed in MOS `a6291fbb19`. The spec now
  says "Media is never wiped by pairing, adoption, or ownership change."
- **Audit H1 as a bug (row 53).** A no-owner lockout after the window expires is now
  D-EXPIRY. Keep F1, which tests it as intended behavior.

## NEW cases

| ID | Case | Precise steps | Expected signal |
|---|---|---|---|
| NEW-1 | Radio hidden until MTK ready | 1. Hold MTK off or boot with Android delayed (`adb reboot`, then scan immediately). 2. Run nRF Connect plus a second phone's Bluetooth Settings scan from power-on until the first MTK→BES UART frame. 3. Repeat with a BES-only reboot. | No `Mentra_Live_*` ADV and no Classic inquiry or page response before the first valid UART frame. The BES `lxy pair:` exposure line appears only after `lxy_uart_android_is_ready()`. No "Connected" prompt before ready. |
| NEW-2 | Trailing click does not cancel a fresh window | 1. In `OWNER_ONLY`, do 3 presses and open the window. 2. Within 2 s, give one extra single click. 3. Wait 5 s. 4. Give one single click (>2 s after entry). | Step 2 leaves the window open: LED still at 400 ms, code repeats, no `hm_pairexit`. Step 4 closes the window, `hm_pairexit` fires exactly once, and ASG says "Pairing mode ended." once. |
| NEW-3 | iOS Classic-first does not commit or close the window | 1. Use iPhone B with no bond, and open the window. 2. Pair `Mentra_Live_XXXX` in iOS Settings → Bluetooth first. 3. Wait 30 s. 4. Have iPhone C attempt a Classic connect. 5. Open the Mentra App on B and connect. | After step 3 the window is still open (held timer, code repeats) and there is no owner commit line. Step 4 is rejected (single-slot lock). Step 5 triggers glasses security request → SMP → owner commit, then "Connected" once. |
| NEW-4 | App Unpair clears the glasses owner end-to-end | 1. Owner A connected (Android, then iOS). 2. Run Settings → Unpair in the Mentra App. 3. Check the phone's Bluetooth Settings. 4. Try reconnecting A via the app. 5. Reboot the glasses. | The BES UART shows the `unpair` command received and the owner cleared. Pairing does not open at step 2. On Android, Mentra Live is gone from Bluetooth Settings within ~1 s. On iOS, the app tells you to forget it in Settings. Step 4 is rejected. Step 5 opens the R3 auto-pair window exactly once. |
| NEW-5 | RF loss is not owner loss | 1. Owner A connected. 2. Shield or walk out of range until GATT drops with timeout (status 8/133). 3. Return. | A auto-reconnects with zero action. No `owner_replaced` is emitted, no "Paired to another phone" card appears, and `mentra_live_owner_lost` stays false. |
| NEW-6 | Abandoned Pair Glasses scan leaves reconnect intact | 1. Owner A connected. 2. Open Pair Glasses and wait for a scan. 3. Back out without selecting. 4. Power-cycle the glasses. 5. Separately, start a pair to a second unit, cancel at loading, then power-cycle the original. | In both cases the original glasses auto-reconnect. There is no connect to the abandoned target, and `pending_device_*` is empty afterward (logcat). `manualDiscoveryActive` is false after `stopScan`. |
| NEW-7 | Scan UI recovers from permission denial | 1. Revoke location/mic. 2. Open Pair Glasses with exactly one pairable unit (auto-connect) and deny the prompt. 3. Repeat with two pairable units and wait >15 s. 4. Tap Try Again on iOS. | Step 2 shows the retry controls, not an infinite spinner. Step 3 keeps the picker with codes, and no "No glasses found" appears while results exist. Step 4 goes back exactly one screen. |
| NEW-8 | Copy matches the three-press gesture | With `EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING=true`, open prep, the scan no-results hint, the troubleshooting modal, and the owner-lost card, in English plus one other locale. | Every gesture string says three presses. No "5 times", "five-tap", or "hold … 10 seconds" text remains. Non-English locales fall back without showing raw keys. |
| NEW-9 | Release build hygiene | Grep the release APK/IPA JS bundle, Kotlin/Swift sources, and the BES ELF strings. | No `127.0.0.1:7905`, `#region agent log`, `DEBUG_F1AF02`/`D_F1AF02`, or `radio_exposed() \|\| true`. The pairing code never appears in logcat at INFO or above. The OTA size gate passes. |
| NEW-10 | R14 adoption when BLE address equals Classic address | 1. Host test: Classic-only owner, then a BLE connect from the same public address → candidate selected → SMP requested → bond → identity committed. 2. Hardware: a phone with a public BLE address on flag-off FW → OTA to flag-on. | The adoption candidate is set and the glasses send the security request. After the bond, the owner has a BLE identity, ADV returns to the accept list, and `legacy_adopt_open` is false. |
| NEW-11 | R14 adoption stall and failure recovery | 1. Classic-only owner with its ACL up. 2. Candidate BLE connects but cancels or ignores SMP while keeping GATT. 3. Wait 60 s (stall), or reject SMP (failure). 4. Owner retries the Mentra App connect. 5. Inject a stale timer generation. | On failure the candidate disconnects immediately. On a stall it is reaped at 60 s, so the slot is freed. The Classic owner and audio are retained (no `clear_owner`). The step 4 retry adopts. The stale timer does not drop the retry. |
| NEW-12 | Multiple legacy Classic records at flag-off → flag-on upgrade | 1. On flag-off FW, pair phone X (Classic), then phone Y (owner, Samsung with BLE privacy). 2. OTA to flag-on. 3. Reboot. 4. Have Y reconnect, then X attempt a reconnect. | Y gets both Classic and BLE, with no `Rejecting Classic ACL` for Y. X is rejected at Classic ACL and BLE. The owner is chosen from the record that matches the BLE identity, never by NV recency alone. |
