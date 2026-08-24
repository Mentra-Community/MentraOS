# OS-1615 — Mentra Live Secure Pairing and Ownership Transfer

**Linear:** [OS-1615](https://linear.app/mentralabs/issue/OS-1615)  
**Status:** Rule Alpha / Design A (open reclaim) is live. Design B wipe/finalize/abort is retired.  
**Repos:** MentraOS (mobile + asg_client + Bluetooth SDK), mentra-live-bes (BES firmware)

This document is the authoritative end-to-end design for Mentra Live pairing. Five-tap clears prior owner/bonds; the first successful pair wins. `pairing_info` is a readiness signal only — do not gate UI or commands on `had_previous_bond`. Design B media wipe, pairing finalize/abort, and pairing-transfer status APIs must not be re-armed.

---

## 1. Security invariants

1. Outside an explicit physical pairing window, an unknown peer cannot establish a BLE or Classic connection.
2. A provisional owner never replaces or deletes the committed owner before successful finalization.
3. At most one provisional ownership transaction exists at a time.
4. At most one candidate device participates in that transaction.
5. ~~Wipe success is correlated to the active transaction and is verified, not merely reported.~~ Retired: Design B wipe/confirm is not part of live pairing.
6. Duplicate commands cannot repeat destructive effects.
7. Reboot yields either the old committed owner or a fully committed new owner — never an ownerless intermediate once finalize has begun.
8. **No timeout alone opens pairing.**
9. A stale mobile event cannot mutate the current pairing generation.
10. Unsupported firmware fails explicitly rather than silently degrading security.

---

## 2. Owner identity model

```text
OwnerRecord
  owner_id                 // durable opaque id
  ble_identity_address?    // public/static identity, not current RPA
  ble_irk?
  classic_bd_addr?
  key_origin               // ble_only | classic_only | ctkd | independent
  association_confidence   // confirmed | heuristic | unknown
  committed_at
  schema_version
```

The controller distinguishes:

1. BLE identity address vs current resolvable private address.
2. Classic BD_ADDR.
3. Keys derived via CTKD vs independently paired keys.
4. Confirmed cross-transport association vs two records that merely appeared close together.
5. “Required transport bond absent because the platform has not requested it yet” vs “security failed.”

**Rejected as unsafe:** treating “first new Classic + first new BLE record in a time window” as a single phone without constraints.

### Cross-transport binding (locked)

1. **Primary:** Authenticated BLE session carries `transfer_id`. Classic is admitted only when BES proves same-device association via CTKD / stack link-key derivation for that session.
2. **Fallback (documented limitation):** If CTKD/stack proof is unavailable:
   - only during active `PAIRING` / `PROVISIONAL_TRANSFER` with `transfer_id` already on BLE;
   - accept at most the first new Classic bond while that BLE provisional link is up;
   - reject further Classic candidates for the transaction;
   - mark `association_confidence = heuristic` and log it.
3. **Accepted limitation:** BD_ADDR spoofing is not closed by a new application-layer challenge protocol.

---

## 3. BES controller states

| State | Behavior |
| --- | --- |
| `BT_INITIALIZED_NOT_EXPOSED` | Stack may exist; BLE advertising and Classic accessibility disabled until MTK readiness |
| `OWNER_ONLY` | Accept list / Classic policy allow committed owner only |
| `PAIRING` | 120s open window; undirected adv; LED 400 ms; voice every 15 s |
| `PROVISIONAL_TRANSFER` | Historical Design B state. Live pairing does not wait for wipe/confirm. |

**UART fail-safe (locked, fail-closed):** No auto-open pairing after N seconds of missing MTK. Remain non-discoverable; five-tap physical gesture may enter pairing; factory/test paths and 20-tap reset retained.

**Radio model (locked):** Prefer `BT_INITIALIZED_NOT_EXPOSED` (exposure gated) over deferring full stack bring-up, unless power constraints force the latter after evidence.

### Pairing entry / exit

- Five rapid power taps enter or restart the 120 s pairing window.
- Twenty power taps still trigger emergency factory reset.
- Auto-enter pairing after MTK readiness when no BLE owner exists.
- Prompt stops on timeout, successful pairing, shutdown, or cancellation.
- Old owner keys retained during pairing; owner reconnects suppressed so the provisional phone can use the link.

---

## 4. BLE security

- Outside pairing: `ADV_ALLOW_SCAN_ANY_CON_WLST` (or stack equivalent); accept list from committed owner via `nv_record_blerec_*`.
- In pairing: undirected open filtering; after first provisional connects, stop accepting further candidates.
- Rejection at controller / link establishment; no post-connect “unknown device” disconnect workaround as the only gate.
- Do **not** delete owner records on transient LTK failures.

### Accept-list operational notes

- Policy changes may require stop-adv → update list → restart; validate on hardware.
- Simultaneous two-phone candidate race is a hardware acceptance test.

---

## 5. Classic security

- `BTIF_BAM_CONNECTABLE_ONLY` outside pairing; `BTIF_BAM_GENERAL_ACCESSIBLE` only while pairing / provisional transfer needs discoverability.
- On `BTIF_BTEVENT_LINK_CONNECT_REQ`, reject unknown peers before ACL with `nv_record_ddbrec_find` + `btif_me_response_acl_conn_req(..., false)`.
- Require authentication and encryption before A2DP/HFP profile admission; 5 s security timer after ACL creation; disconnect on failure.
- Authentication/encryption are **link** properties; profiles ride the ACL.

### Audio Connected / Disconnected

Emit Connected when a secured ACL belongs to an admitted owner **and** the required profile set for the platform is connected (not necessarily both A2DP and HFP if the phone never opens the second). Debounce flaps.

---

## 6. Ownership transaction (crash-consistent)

Persist: 64-bit `transfer_id`, committed addresses, provisional addresses, transaction state/phase.

### Finalize phases

1. Persist `FINALIZE_INTENT` (transfer_id, peers, wipe correlation).
2. Persist new committed `OwnerRecord`.
3. Mark `NEW_OWNER_COMMITTED`.
4. Reconfigure accept/access policies.
5. Delete old BLE and Classic records.
6. Mark `COMPLETE`.
7. Retain terminal result for a bounded period (and across at least one reboot) for duplicate-command replay.

### Rollback ordering (bug fix)

Disconnect provisional BLE link **before** clearing provisional connection index / state.

### Finalize preconditions

transfer_id match, sending BLE connection, verified wipe success, required transport bonds; then commit new owner and remove old records.

### Abort paths

Abort command, provisional link loss, timeout, reboot before `FINALIZE_INTENT` → remove provisional, restore old owner. After `NEW_OWNER_COMMITTED`, boot recovery finishes new-owner path rather than restoring the previous owner into an ownerless intermediate.

### First-time pairing

Commit automatically when required bonds exist per platform anti-deadlock rules: never wait forever on a transport the platform has not requested.

### Migration

- Exactly one credible BLE/Classic pair → commit as owner.
- Ambiguous multi-bond history → retain records; require five-tap pairing for a new committed owner.
- Do not silently pick “most recent” when transports disagree.

### Wipe / ownership non-atomicity

Retired. MentraOS must not send `wipe_media`, `pairing_finalize`, `pairing_abort`, or `pairing_transfer_status`. Media is not wiped as a pairing precondition.

---

## 7. Pairing code and advertisement

| Property | Locked value |
| --- | --- |
| Role | Device disambiguation only — not an auth secret |
| Encoding | `uint16` LE; display = uppercase hex, 4 chars; spoken = 0–9/A–F |
| Adv | Mentra manufacturer `0xB822`: existing pairing flag byte + versioned trailer (capability + code) |
| Vs transfer_id | Distinct; code for UX, transfer_id for transaction correlation |

Legacy ads without the Mentra company/flag remain pairable during the compatibility window with clear labeling and mandatory OTA after pair.

---

## 8. Wire protocol

```ts
type TransferId = string // 16-char uppercase hex — never a JS number

type PairingMessageBase = {
  protocol_version: number
  transfer_id: TransferId
  request_id?: string
}

// pairing_info: had_previous_bond, transfer_id, pairing_code,
//               classic_bond_ready, secure_pairing_capable
// pairing_info is a readiness signal only. Do not strip unused fields.
```

Retired Design B commands (do not re-arm): `wipe_media`, `pairing_finalize`, `pairing_abort`, `pairing_transfer_status` and their results.  
Retired SDK methods: `wipeMediaForPairing`, `finalizePairingTransfer`, `abortPairingTransfer`, `getPairingTransferStatus`.

Capability: protocol version + capability bitmask for mixed-version rollout.

---

## 9. Mobile UX (engine.pairing)

- Prep: five taps, flashing LED, spoken code, match code in app.
- Scan: filter secure firmware by pairing mode; saved-device reconnect bypasses filter; legacy labeled and OTA-forced; auto-connect when exactly one eligible; multi-result list shows four-char codes; 15 s timeout only when zero eligible; Try Again restarts in place; generation-based stale-callback protection.
- Loading: `pairing_info` is a readiness signal only. Ignore `had_previous_bond` for UI gating. Do not confirm, wipe, finalize, or abort a pairing transfer. Secure-capable firmware does not use the legacy pairing_info timeout fallback.

---

## 10. ASG media wipe

Retired. Do not register `WipeMediaCommandHandler`, do not arm `PairingTransferCaptureGate`, and do not block capture on a `transfer_id`. Design A open reclaim does not wipe gallery media during pairing.

---

## 11. Timeouts (summary)

| Timer | Value |
| --- | --- |
| Pairing window / prompts | 120 s open; voice every 15 s; LED 400 ms |
| Ownership transfer confirmation | 5 min |
| Classic post-ACL security | 5 s |
| Scan no-results timeout | 15 s |
| Mentra Connected re-arm after phone absent | 10 s |

---

## 12. Residual acceptance (may remain after code ship)

- Final israelov audio assets phrase-verified on device.
- Full physical hardware matrix evidence on Linear.
- Placeholders do not satisfy final audio acceptance.

---

## 13. Delivery

One commit per phase (0 design, 1 controller, 2 BLE, 3 Classic, 4 SDK, 5 mobile UX, 6 wipe, 7 radio/audio). MentraOS PR #3224 and BES PR against main. Dirty primary worktrees untouched; work in isolated worktrees only.
