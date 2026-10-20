DRAFT - not posted. Paste by hand. Nothing here has been posted to Linear.

================================================================================
OS-1905 — Mentra Live: one-step iOS BLE + Bluetooth Classic pairing via CTKD
DRAFT - not posted
================================================================================

The premise that SMP is never started is stale in 3.3. The BLE bond completes, and CTKD is compiled in (CTKD_ENABLE ?= 1). After GAPC_PAIRING_SUCCEED, clac_linkKey in nvrecord_ble.c derives a Classic link key and stores it under the peer's BLE address via ddbif_add_record. The gap is the Classic stage after that bond, not a missing SMP exchange.

One-step iOS pairing is not claimed. The Mentra App still ends on the Pair Audio (Open Settings) screen if Classic profiles are not detected within the 30 s settle window (IOS_CLASSIC_SETTLE_MS).

Three hypotheses. None is proven:

- H1, iOS is not initiating Classic. Candidate fix is app-only: an opt-in CBConnectPeripheralOptionEnableTransportBridgingKey, default off pending a test. TBD (pending Run A/Run B trace).
- H2, the CTKD key is stored or associated under the wrong address, or Classic authentication fails while a derived key exists. TBD (pending Run A/Run B trace).
- H3, Classic works but the app misdetects it, or the 30 s window is too short. The app is adding a visible "Connecting audio" state and a three-state audio readiness model (Classic profiles connected, audio routed, and the legacy combined flag). TBD (pending Run A/Run B trace).

Hard gate on firmware: no key re-keying unless the baseline trace proves H2 and Run B shows transport bridging does not fix it. If only H1 or H3 holds, the firmware stays unchanged apart from the key-logging gate. Production DUMP8 traces of the LTK, IRK, and link key are being gated off behind MENTRA_KEY_LOG. That gate is required here and does not wait on H2.

Acceptance items still open. None of these is met, and landing on Pair Audio is a fail for the CTKD cases, not a pass:

- Fresh iPhone and factory-reset glasses: one action in the Mentra App, at most one system prompt. TBD (pending Run A/Run B trace).
- BLE stays bonded and encrypted across an app restart and a glasses reboot. TBD (pending Run A/Run B trace).
- Classic is bonded through CTKD, and A2DP and HFP work with no second Settings pairing. Not true today. TBD (pending Run A/Run B trace).
- iOS Settings shows one coherent Mentra Live relationship. TBD (pending Run A/Run B trace).
- An existing bond reconnects with no new pairing prompt. TBD (pending Run A/Run B trace).
- Transfer to a second phone; the previous phone cannot reconnect over BLE or Classic. TBD (pending Run A/Run B trace).
- Factory reset clears both BLE and BR/EDR credentials. TBD (pending Run A/Run B trace).
- Android pairing and reconnect stay as they are. TBD (pending Run A/Run B trace).
- Checked on current iOS, one older supported iOS, and current Android. TBD (pending Run A/Run B trace).
- A sanitized BES trace shows security request, LE Secure Connections bond, CT2 and key distribution, the BR/EDR link-key record, and the Classic profile connection, with no key bytes. Bond and key derivation are in the 3.3 source; the Classic profile step is TBD (pending Run A/Run B trace).
- A focused regression for LE-to-BR/EDR key creation and record persistence. Not done. Identity and key-record firmware stays behind the H2 gate.

================================================================================
OS-2116 — Test and qualify Mentra Live pairing mode and CTKD
DRAFT - not posted
================================================================================

This work can produce evidence only for the rows below. Status stays NOT RUN until physical-device evidence is attached. A plan, a build, a simulator run, or this draft is not a pass. Do not mark any row PASS from these notes.

- C01. Fresh pair started only in the Mentra App. Do not pair audio by hand in Settings. Play music and place a real call. Required: at most one system prompt, an LE Secure Connections bond, a CTKD Classic record for the same phone, working A2DP and HFP, and no second pairing action. TBD (pending Run A/Run B trace).
- C02. Relaunch the app, reboot the glasses, reboot the phone, reconnect, and repeat music and the call. Both transport records persist and no new prompt appears. A connected screen alone is not evidence. TBD (pending Run A/Run B trace).
- T02. With A nearby, open pairing and pair B. Repeat with A absent. Reboot, then try A on both transports and B with audio. Exactly one owner remains, A's glasses-side BLE and Classic keys are gone, and B still works. The "known media remains" check follows the no-wipe baseline and conflicts with OS-2055; do not score it until that product decision. Evidence of the takeover itself is TBD (pending Run A/Run B trace). Media result: TBD (product decision).
- T06. Alternate A to B to A for three complete round trips, reboot between transfers, use app Unpair, and separately factory-reset and pair again. One owner after each success; obsolete glasses-side credentials evicted; factory reset clears BLE and Classic. TBD (pending Run A/Run B trace).
- U05. Legacy Classic-only iPhone owner, phone-driven update, BLE adoption while that owner's Classic link is up. Also the failed-SMP, no-Classic-ACL, two-candidate, and stale-timer checks. The Classic owner is kept on a failed SMP, and media remains. TBD (pending Run A/Run B trace).

No other OS-2116 case is in scope for this evidence. The ticket status remains NOT RUN.

================================================================================
OS-2055 — Ship revised Mentra Live pairing mode and ownership transfer for 3.3
DRAFT - not posted
================================================================================

Two recorded spec conflicts need a product decision. This CTKD work does not choose either side, and neither side should be marked passing until the decision is written down and the specs match it.

1. Owner at the start of pairing. The OS-2116 baseline says opening pairing removes the previous owner's BLE and Classic credentials immediately, and cancel or timeout leaves the glasses unowned and locked. OS-2055, and the current branch with ownership transfer on, retain the old owner until the new phone confirms. A failed, cancelled, or timed-out attempt before that confirm keeps the old owner. TBD (product decision).

2. Media on transfer. OS-2055 says a successful ownership change tells ASG Client to wipe the previous owner's media. The OS-2116 baseline says pairing, adoption, and ownership change never delete media. TBD (product decision).

Which of H1, H2, and H3 explains the iOS Pair Audio fallback is separate from these two decisions. TBD (pending Run A/Run B trace).
