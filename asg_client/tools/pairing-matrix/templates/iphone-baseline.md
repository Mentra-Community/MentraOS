# iPhone pair capture: Run A (baseline) and Run B (bridging on)

One fresh iPhone pair, one timeline. Copy this file to
`asg_client/tools/pairing-matrix/runs/<run>/iphone-<A|B>.md` and fill it in there.
Run A is the baseline. Run B repeats it exactly with iOS transport bridging on
(`CBConnectPeripheralOptionEnableTransportBridgingKey`). Change nothing else.

## Trace rule (read first)

The raw BES capture can contain LTK, IRK and link-key bytes. It stays local under
`asg_client/tools/pairing-matrix/runs/<run>/` and is **never attached or pasted
anywhere**: not a PR, Linear, Slack, a chat or a model prompt. `runs/` is untracked
but **not** git-ignored (only `*.log` is), so never `git add .` or `git add` the
`pairing-matrix` directory; add by explicit path. The glasses `logcat` also
carries BES lines, so treat `glasses.log` as raw too. Only output of the sanitizer
is shareable:

```bash
python3 asg_client/tools/pairing-matrix/sanitize/sanitize_bes_trace.py raw.txt -o clean.txt --check
```

Share `clean.txt` only if `--check` passed. Read it once first. Addresses stay
visible on purpose, so post it only where those addresses are already present.

## Fixtures

| Field | Run A | Run B |
|---|---|---|
| Date, operator | | |
| iPhone model, iOS version | | |
| Glasses serial, BLE name/MAC | | |
| Mentra App build, git SHA | | |
| BES version (expect 17.26.7.28) | | |
| ASG client version | | |
| Flag values (list each, with default) | | |
| Transport bridging flag | off | on |
| Host clock source and offset to glasses/iPhone | | |

Run B must use the same iPhone, same glasses, same BES image, same reset state as Run A.

## Reset recipe (before every run)

- [ ] iOS Settings > Bluetooth: forget the Mentra Live entry (tap (i), Forget). Confirm it is gone from My Devices.
- [ ] Mentra App: forget/unpair the glasses, sign state as in Run A.
- [ ] Glasses: factory reset, or confirmed unpaired state.
- [ ] Verify there is no owner: advertising shows pairing mode, and the glasses report no owner (`pmx.py adv` from `asg_client/tools/pairing-matrix`, or the app's pairing_info).
- [ ] iPhone Bluetooth toggled off and on once; no other Mentra Live bonded to it.
- [ ] Note the reset time and what was reset.

## Capture (start all four before the first tap, stop after the Pair Audio decision or 3 min)

Note the wall-clock start of each. Glasses `adb` in this lab goes through the unit
wrapper only (see the device routing block at the top of `pmx.py`); never use a
bare `adb -s`.

1. **Raw BES trace (local only).** The pairing-matrix tooling does not open the BES
   UART itself. It reads the BES ring through the MTK, as `pmx.bes_trace()` does
   (needs the debug ASG APK):
   ```bash
   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE -p com.mentra.asg_client \
     --ez enabled true --ei interval_ms 3000
   adb logcat -c; adb logcat -v time | tee runs/<run>/<A|B>/glasses.log
   ```
   `LogTap` in `pmx.py` does the same streaming. BES lines appear as
   `layer=bes_trace_log` or `sr_log` chunks, rebuilt by `pmx.bes_ring_lines()`. A
   true UART tap or `python3 tools/bes_ble_logs.py --mac <MAC> --output captures/<name>`
   in the BES repo is an alternative; either way the file stays local. Stop with
   `--ez enabled false` at the end.
2. **Glasses logcat for `hm_pairlog`** (separate file, same `logcat -v time`):
   ```bash
   adb logcat -v time | rg hm_pairlog | tee runs/<run>/<A|B>/hm_pairlog.txt
   ```
3. **iOS device log** (iPhone on USB, find `UDID` with `xcrun devicectl list devices`):
   ```bash
   xcrun devicectl device process launch --device "$UDID" --console \
     com.mentra.mentra 2>&1 | rg 'PAIRFLOW|AudioReadiness' | tee runs/<run>/<A|B>/ios.txt
   ```
   `--console` shows stdout and stderr only. The `AudioReadiness` lines come from
   `os.Logger` (subsystem `com.mentra.bluetooth-sdk`), so also keep Console.app open
   on the iPhone with the filter `PAIRFLOW OR AudioReadiness` and save the
   selection. Check that no `<private>` placeholders hide the route names.
4. **Screen recording or photos** of the app screens, for the Pair Audio row.

## Timeline (fill with one clock; use host time, note each source's offset)

| Event | Source | Time (hh:mm:ss.mmm) | Detail |
|---|---|---|---|
| Pair started in app | iOS `PAIRFLOW` | | |
| BLE bond complete | BES / hm_pairlog | | |
| CTKD link key derived | BES | | Address it was stored under: ____ ; address type: public / random ____ |
| BLE identity address of the phone (bond) | BES | | ____ |
| First Classic ACL connection | BES | | Peer address: ____ ; same as BLE identity: yes / no |
| Link key request | BES | | answered with key / negative-replied / none ; key address ____ |
| Authentication result | BES | | success / fail, status ____ |
| A2DP connected | BES / iOS | | |
| HFP connected | BES / iOS | | |
| First `PAIRFLOW: pair_audio decision=` | iOS | | decision: ____ (`advance_*` / `wait_no_route`) |
| Pair Audio screen shown | screen | | yes / no, time ____ |
| AVAudioSession category | iOS `AudioReadiness` | | ____ |
| AVAudioSession `availableInputs` | iOS `AudioReadiness` | | ____ (or `inputsNil=true`) |
| Active output at decision | iOS | | ____ |
| Glasses `hm_pairlog` "connected" | glasses logcat | | |

Also record: seconds from BLE bond to first Classic ACL; whether the 30 s wait
(`IOS_CLASSIC_SETTLE_MS`) expired before profiles came up; any iOS system pairing
prompts (count and time); the final entry shown under iOS Settings > Bluetooth.

## Decision rubric (parent decides; this run only supplies the facts)

- **H1, iOS never initiates Classic.** Run B (bridging on) brings the Classic
  profiles up promptly where Run A did not, with the same BES key state.
- **H2, the key or the auth is wrong.** The trace shows the CTKD key stored under a
  different address than the Classic peer, or the link key request fails or is
  negative-replied while a derived key exists, and bridging does not fix it.
  Firmware work (W4) starts only on this.
- **H3, Classic works but the app misdetects it or waits too short.** The profiles
  connect in Run A, but `pair_audio decision` stayed `wait_no_route`, or came late
  (after the 30 s settle).
- Several can hold. Ship the app-only fixes that apply.

## Result

- Rubric reading for this run (H1 / H2 / H3 / none, one line each with the table rows that support it):
- Anything missing or uncertain:
- Sanitized file path and `--check` result:
- Raw files kept at (local path), and confirmation none were shared:
