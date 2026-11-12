---
status: active
owner: nicolo
---

# OS-1988 BES crash persistence: frozen contract

This spec fixes the BES, glasses (ASG client), phone and Cloud interfaces for
persisting BES crash logs across reboots (Linear OS-1988). BES firmware lives in
the `mentra-live-bes` repository.

Hex values are lowercase. Integers in JSON are numbers unless stated otherwise.

## 1. Identifiers

| Name | Form | Meaning |
|---|---|---|
| `boot_id` | 16 hex chars (64 bits), never all zero | One BES boot. New value on every reset of every class. |
| `dump_id` | `<seq 8 hex>-<crc 8 hex>` | One saved crash capture: the saved-dump sequence plus the CRC32 of its transmitted bytes (section 3). |
| `incidentKey` | `<serial>-dump-<dump_id>` or `<serial>-reset-<boot_id>` | One reported event. The reset form uses the `boot_id` of the boot that observed the unexpected reset. |

- `<serial>` is `SysProp.getDeviceSerial(context)` (already normalized: empty for
  unprovisioned values such as `0123456789ABCDEF`). When it is empty, use
  `anon` followed by 16 hex chars from a random value generated once and stored
  in `files/bes_incident/device_id` (atomic write; never regenerated while the
  file exists). Unit 2 in the lab has the placeholder serial and exercises this.
- `incidentKey` matches `^[A-Za-z0-9._:-]{1,128}$`. Anything else in the serial
  is replaced with `_`.
- CRC32 everywhere is IEEE 802.3 (zlib `crc32`, Java `java.util.zip.CRC32`).

### Attribution

Using the previous BES `boot_id` that ASG actually observed (persisted in
`files/bes_incident/last_boot`):

- `match`: the dump's crashed `boot_id` equals that previous boot.
- `older`: ASG saw the previous boot, and the dump's crashed `boot_id` differs.
  The dump is its own incident. A newer unexpected reset with no dump of its own
  is a separate no-dump incident.
- `unknown`: no previous `boot_id` (first connect, ASG data cleared, missed
  boots), or the dump has no `boot_id` (legacy dump). One incident for the dump,
  and no confidently classified no-dump incident for the same transition.

## 2. BES to ASG: `sr_syvr` additions

Only firmware that implements this whole contract advertises the capability.

```json
{
  "wire_caps": { "...": 1, "crash_pull": 1, "rlog_sub": 1 },
  "crash": {
    "v": 1,
    "boot_id": "9f3a0c1b2d4e5f60",
    "reset_hw": 0,
    "reset_sw": 0,
    "dump_id": "0000002a-1f2e3d4c",
    "dump_seq": 42,
    "dump_len": 23456,
    "dump_boot_id": "1a2b3c4d5e6f7081"
  }
}
```

- `boot_id`, `reset_hw`, `reset_sw` describe the **current** boot and are always
  present when `crash_pull` is 1.
- `dump_id`, `dump_seq`, `dump_len` are present only when a valid saved dump
  exists. `dump_len` is the full transmitted length in bytes (section 3), before
  any truncation. `dump_boot_id` is the crashed boot's `boot_id` from the dump's
  `[CRASH-CONTEXT]`, or absent for a legacy dump.
- BES computes `dump_id` once at boot and caches it; `sr_syvr` must not read
  flash.
- Reset codes: raw values. The classification table lives in
  `mentra-live-bes/docs/crash-timestamps.md` (phase 2 output).

## 3. Dump retrieval (`cs_log`)

Request (MTK to BES), the existing command with an optional identity:

```json
{"C":"cs_log","V":1,"B":"{\"action\":0,\"dump_id\":\"0000002a-1f2e3d4c\"}"}
```

`B` is always a JSON **string** on the MTK-to-BES UART (the BES command parser reads
`B` through `valuestring`; an object `B` is dropped). The same holds for
`mh_rlog`, `mh_rlog_ack`, `mh_rlog_sub`, and every other MTK-to-BES command in this
contract: `B` is the string form of the JSON body shown.

`action != 0` still clears; ASG never sends it. BES never auto-clears a dump.

BES runs the transfer on the phone-command worker, not the RX handler, and
suspends rlog frames and delivery wakes until the `end` packet is sent.

Reply: the existing `sr_log` packets `{"cur":<n>,"body":"<text>"}`, at most 200
packets including header and trailer, each body at most 400 bytes, then the
existing end packet (`cur` 255, body `"end"`).

1. `cur` 0, header packet, body exactly one line:
   `[CRASH-DUMP] v=1 dump_id=<dump_id> len=<bytes> crc=<8 hex>`
   It always names the dump actually being sent. If it differs from the requested
   `dump_id`, ASG discards the transfer and collects the newly named dump instead
   (never marks the requested one collected). With no saved dump, the header is
   `[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000` and `end` follows.
2. `cur` 1..n: dump bytes. The **transmitted byte stream** is the concatenation
   of these bodies after JSON decoding, as UTF-8 bytes. `len` and `crc` cover
   exactly that stream (the full dump). BES sanitizes bytes before sending
   (`0x00`-`0x08`, `0x0B`-`0x1F` except `\n`/`\t`, and invalid UTF-8 become `?`);
   the CRC in `dump_id` is computed over the same sanitized stream.
3. Only when the dump does not fit: one trailer packet, body exactly
   `[CRASH-TRUNCATED] sent=<bytes> total=<bytes> crc=<8 hex of the sent prefix>`.
4. End packet.

ASG validation for `STORED`:
- untruncated: received length == `len` and CRC == `crc`, and both equal the
  values in the discovered `dump_id`/`dump_len`;
- truncated: received length == `sent` and CRC == trailer `crc`, `total` ==
  discovered `dump_len`; the incident is flagged `truncated` and records `dumpPrefixLen` (= `sent`) and `dumpPrefixCrc` (= trailer `crc`) so the stored prefix can be verified later.

## 4. Dump content lines (BES)

Inside the dump text:

- `[CRASH-CONTEXT] v=2 seq=<u32> boot_id=<16 hex> uptime_ms=... unix_ms=... clock=<n> age_ms=... boot_anchor_ms=... reset_hw=0x<hex> reset_sw=0x<8 hex>`
  (v=1 lines from older firmware lack `boot_id`.)
- `[CRASH-TAIL] captured=<bytes> requested=<bytes> truncated=<0|1> torn=<0|1>`
  followed by the frozen TRACE tail bytes, then a line `[CRASH-TAIL-END]`.
  `truncated=1` when the captured bytes are fewer than requested because of the
  budget. `torn=1` only when an unlocked copy could not be shown coherent.
  Abrupt resets have no `[CRASH-TAIL]` at all.

In the live TRACE ring at boot (replaces the old replay of the whole dump):

- `[CRASH-SAVED] dump_id=<dump_id> len=<bytes> boot_id=<crashed boot_id or none>`

## 5. `boot_id` C API (BES)

`apps/xysmart/boot_id.h`, implemented in `apps/xysmart/boot_id.c` (owner
`bes-crash`):

```c
/* Call once, early in boot, before TRACE delivery or sr_syvr can run. */
void m8_boot_id_init(void);
/* Nonzero, constant for this boot. Returns 0 only before init. */
uint64_t m8_boot_id(void);
/* 16 lowercase hex chars plus NUL. */
void m8_boot_id_hex(char out[17]);
```

`bes-delivery` may call these before `boot_id.c` lands; a stub returning a fixed
nonzero value is acceptable on its branch only.

## 6. TRACE delivery additions (`hm_rlog`)

- Every `hm_rlog`, `hm_rlog_ack` and `hm_rlog_ready` adds `"bid":"<boot_id>"`.
- `mh_rlog` / `mh_rlog_ack` may add `"bid"`. If a request's `bid` differs from
  the current boot, BES treats the cursor as belonging to another boot: it
  replies from the oldest retained byte with the current `bid`.
- ASG keys its cursor by `(bid, position)`. A new `bid` resets the cursor and
  writes `[ASG-BES-REBOOT] old_bid=<..> new_bid=<..>` into the store.
  The existing `"g"` generation stays for compatibility but is not an identity.
- Subscription (advertised by `rlog_sub`): `mh_rlog_sub {"on":1|0}` replies
  `hm_rlog_sub {"on":1|0,"bid":"..."}`. `on:0`, a UART link invalidation, or a
  new boot clears the consumer state; BES sends no delivery wakes while not
  subscribed. ASG subscribes when it enables the tail and unsubscribes when it
  disables it.
- Overload lines in the ring: `[REPEAT n=<count> first_ms=<ms> last_ms=<ms>] <line>`
  and `[LOG-LOST] bytes=<exact count> since_ms=<ms>`.

## 7. ASG storage

### Rolling store

`BesTraceStore` freeze API (owner `asg-store`):

```java
/** Copies stored lines with wallMs in [fromWallMs, toWallMs] into destination
 *  (tmp file, fsync, rename), newest kept when over maxBytes. Never removes
 *  anything from the store. */
public synchronized Frozen freeze(File destination, long fromWallMs, long toWallMs, int maxBytes);

public static final class Frozen {
    public final int lines;
    public final long bytes;
    public final long firstWallMs;   // 0 when empty
    public final long lastWallMs;    // 0 when empty
    public final int gaps;           // [ASG-BES-GAP] lines inside the copy
    public final boolean truncated;  // older lines dropped for maxBytes
}
```

The frozen file uses the store's line format
(`wallMs \t generation \t positionHex \t text`).

### Incident bundle

`files/bes_incident/<incidentKey>/`:

- `dump.txt`: the validated transmitted byte stream (when there is a dump);
  `dump.partial` while collecting.
- `trace.txt`: the frozen TRACE (`freeze`).
- `incident.json`, written atomically (tmp, fsync, rename):

```json
{
  "v": 1,
  "incidentKey": "ML395018B-dump-0000002a-1f2e3d4c",
  "kind": "dump",
  "reason": "bes_crash",
  "state": "STORED",
  "attribution": "match",
  "bootId": "9f3a0c1b2d4e5f60",
  "observedBootId": "0badc0de12345678",
  "dumpId": "0000002a-1f2e3d4c",
  "dumpLen": 23456,
  "resetHw": 0,
  "resetSw": 0,
  "crashUnixMs": 1760000000000,
  "flags": {"truncated": false, "torn": false, "tailCaptured": true, "dumpGap": false},
  "coveredFromMs": 1759998200000,
  "coveredToMs": 1760000000000,
  "traceGaps": 0,
  "createdMs": 1760000005000,
  "collectAttempts": 1,
  "reportId": null,
  "artifacts": {
    "glasses_firmware:full": {"sha256": null, "bytes": 0, "attempted": false},
    "glasses_firmware:relay": {"sha256": null, "bytes": 0, "attempted": false}
  },
  "uploaded": false
}
```

- `kind`: `dump` or `reset`. `reason`: `bes_crash` (dump) or
  `bes_unexpected_reset` (no dump).
- `bootId`: the crashed boot (dump) or the boot that ended unexpectedly (reset),
  when known. `observedBootId`: the boot during which ASG detected it.
- `state`: `COLLECTING` -> `STORED` -> `REPORTED` -> `UPLOADED`. `EVICTED` is
  terminal and is never `UPLOADED`.
- An artifact entry's `sha256`/`bytes` are set when that representation is first
  built for upload, together with the body file `upload-full.json` or
  `upload-relay.json` in the bundle. After `attempted` is true, the body file is
  immutable.
- The record is written before the phone is notified.

### Budget and eviction

- Constants in `AsgConstants.java`: incident TRACE cap 1 MiB, dump cap 80 KB,
  incident directory budget 8 MiB, eviction ring 16.
- `files/bes_incident/evictions.json`:
  `{"count": <total>, "recent": [{"incidentKey":..., "reason":..., "bytes":..., "ms":...}]}`
  (latest 16).

### Transfer lock

`BesLogTransferLock` (owner `asg-collector`), a process singleton:

```java
public enum Owner { USER_MH_LOGS, CRASH_CS_LOG, TRACE_TAIL }
public boolean acquire(Owner owner, long timeoutMs) throws InterruptedException;
public void release(Owner owner);
public Owner current(); // null when free
```

`K900CommandHandler` routes `sr_log` to the session of the current owner.
`BesTraceTail` holds `TRACE_TAIL` only for the duration of one read window.

## 8. Glasses and phone messages (BLE JSON)

ASG to phone, sent when an incident becomes `STORED`, and re-sent on every
`phone_ready` while the state is `STORED` or `REPORTED`:

```json
{
  "type": "bes_crash_detected",
  "incidentKey": "ML395018B-dump-0000002a-1f2e3d4c",
  "reason": "bes_crash",
  "state": "STORED",
  "reportId": null,
  "summary": {
    "attribution": "match",
    "dumpId": "0000002a-1f2e3d4c",
    "bootId": "9f3a0c1b2d4e5f60",
    "resetHw": 0, "resetSw": 0,
    "crashUnixMs": 1760000000000,
    "coveredFromMs": 1759998200000, "coveredToMs": 1760000000000,
    "traceGaps": 0,
    "truncated": false, "torn": false, "tailCaptured": true, "dumpGap": false,
    "evictedCount": 0,
    "recentEvictions": []
  }
}
```

Phone to ASG after Cloud returns a `reportId`:

```json
{"type":"bes_crash_reported","incidentKey":"...","reportId":"rep_..."}
```

ASG persists `reportId` and `REPORTED`, then replies:

```json
{"type":"bes_crash_reported_ack","incidentKey":"...","reportId":"rep_...","ok":true}
```

`ok:false` with `"error":"unknown_incident"` when there is no such bundle.

Bluetooth SDK surface (owner `phone-sdk`, consumed by `phone-engine`):

- Event `bes_crash_detected` in `BluetoothSdk.types.ts`, payload type
  `BesCrashDetectedEvent` = the glasses message above, with
  `type: "bes_crash_detected"`, routed like `ota_status` on iOS and Android.
- `sendBesCrashReported(incidentKey: string, reportId: string): Promise<void>` in
  `src/_private/BluetoothSdkModule.ts` (reached by the engine through
  `@mentra/bluetooth-sdk/internal`, like `sendIncidentId`).
The phone's `sendBesCrashReported` resolves on the matching ack (10 s timeout,
rejects on timeout or `ok:false`). Only after the ack does the phone call the
existing `sendIncidentId(reportId)` (`upload_incident_logs`). ASG maps the
`reportId` to the bundle.

## 9. Cloud and artifacts

- `POST /api/client/reports` adds optional `incidentKey` (same regex as above)
  to every report kind. With the key, Cloud returns the existing report for
  `(mentraUserId, incidentKey)` instead of creating one; the response is the same
  shape `{reportId, status}`, plus `deduplicated: true` on that path only.
- `POST /api/client/reports/:reportId/artifacts` (JSON logs body) adds optional
  `retryKey` (`^[A-Za-z0-9._:-]{1,128}$`). With it, Cloud uses the existing
  SHA-256-bound retry path: identical bytes are idempotent, different bytes under
  the same key return 409.
- Artifact keys: `glasses_firmware:full` (Wi-Fi body) and
  `glasses_firmware:relay` (BLE relay body). The artifact `source` stays
  `glasses_firmware`. Dump entries use entry `source: "BES_CRASH"`, TRACE entries
  `source: "BES"`.
- Automatic report trigger: `{type:"automatic", source:"glasses_firmware_crash",
  reason:"bes_crash" | "bes_unexpected_reset"}`, `report.systemPriority`
  `"critical"`.
- `UPLOADED` only on HTTP 2xx (Wi-Fi) or `transfer_complete` with
  `success:true` for this incident's relay file.


## 11. Java seams between the ASG streams (package `com.mentra.asg_client.io.bes.log`)

Both `asg-collector` and `asg-upload` add `BesIncidentUploadAccess.java` with
exactly this content (identical files merge cleanly). `asg-collector`'s
`BesIncidentStore` implements it; `asg-upload` codes against it and uses a small
file-backed fake in its tests.

```java
package com.mentra.asg_client.io.bes.log;

import java.io.File;
import java.util.List;
import org.json.JSONObject;

/** Incident bundle access used by the upload and phone-notification side. Records are
 *  the incident.json objects from the OS-1988 contract. All methods are thread-safe. */
public interface BesIncidentUploadAccess {
    /** Record for the incident whose persisted reportId equals reportId, or null. */
    JSONObject findByReportId(String reportId);

    JSONObject find(String incidentKey);

    File bundleDir(String incidentKey);

    /** Incidents in STORED or REPORTED that are not uploaded, oldest first. */
    List<JSONObject> pendingForPhone();

    /** STORED -> REPORTED with the reportId; idempotent for the same reportId, false for a
     *  different one or an unknown/evicted incident. Persists before returning. */
    boolean markReported(String incidentKey, String reportId);

    /** Records the first-built representation (artifactKey is "glasses_firmware:full" or
     *  "glasses_firmware:relay"): sha256 and byte count, once. A second call with different
     *  values returns false and changes nothing. */
    boolean recordArtifact(String incidentKey, String artifactKey, String sha256, long bytes);

    /** Sets attempted=true for the artifact; its body file is immutable from now on. */
    boolean markAttempted(String incidentKey, String artifactKey);

    /** REPORTED -> UPLOADED, only after Cloud confirmed. Idempotent. */
    boolean markUploaded(String incidentKey);
}
```

`asg-collector` calls `StoredListener.onStored(incidentKey)` when an incident
becomes `STORED` (interface defined in `BesCrashDumpCollector`:
`public interface StoredListener { void onStored(String incidentKey); }`, set with
`BesCrashDumpCollector.get().setStoredListener(...)`). `asg-upload` owns
`BesIncidentNotifier` (`static BesIncidentNotifier get()`,
`void notifyDetected(String incidentKey)`, `void resendPending()`), builds the
`bes_crash_detected` message from the record, and adds exactly one line to
`ServiceInitializer` that registers
`BesCrashDumpCollector.get().setStoredListener(k -> BesIncidentNotifier.get().notifyDetected(k))`.
That one line is the only `ServiceInitializer` edit `asg-upload` makes.

## 12. TRACE delivery details fixed by implementation (bes-delivery)

- The BES drops its subscription whenever it marks the MTK off, so the ASG subscribes
  again on every `sr_syvr` that advertises `rlog_sub`, not only after a link
  invalidation (implemented in `BesTraceTail.onWireCaps`).
- A line longer than one reply is split. The first piece ends with `[CONT>]` and the
  next piece starts with `[<CONT]`; the ASG stores them as text (no joining).
- `hm_rlog` reply text budget is 300 JSON bytes (the `bid` field needs the room).
- `[REPEAT n=<count> ...]`: `n` counts the held-back lines only (the first two
  identical lines pass through untouched). `[LOG-LOST] bytes=<exact> since_ms=<ms>`:
  `since_ms` is the BES uptime timestamp at which the loss began, not a duration.
- `hm_rlog_ready` also carries `lostb`, `rep`, `gup`, `yld`, `cap`, `evm` counters.
- `bes-crash` exposes the weak hook the integrator wires:
  `m8_log_delivery_link_invalidated()` is optional (the work tick detects link loss).
