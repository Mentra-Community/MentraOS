# Gallery Sync Reliability, Performance, and Compatibility Plan

Status: transfer-correctness implementation complete; hotspot/routing work deferred
Audit date: 2026-07-16
Audit baseline: `origin/dev` at `0944dafa28f73b3904cd08016392a1cb53d725aa`
Primary owners: Mentra App gallery sync, `asg_client` camera server, Mentra Live system firmware networking

## Purpose

Make Mentra Live gallery sync durable, recoverable, and fast without breaking released phone apps or released glasses firmware.

This plan covers:

- Photo and video enumeration, download, validation, local persistence, camera-roll export, acknowledgement, and source retention.
- Long-video interruption and byte-level resume.
- Lightweight manifests, thumbnail handling, ordering, selection, and throughput.
- Backward and forward compatibility across mixed phone/glasses versions.
- Hotspot startup, phone routing, observability, and raw network benchmarking.

It deliberately separates transfer correctness from hotspot/radio performance. A fast network must not be required for correctness, and transport correctness must not hide a slow network.

## Related work

- [OS-1679](https://linear.app/mentralabs/issue/OS-1679/dimenso-benchmarking-video-transfer-speed-via-wifi)
- [OS-394](https://linear.app/mentralabs/issue/OS-394/improve-mentra-live-wifi-gallery-import-speed-and-reliability)
- [OS-1011](https://linear.app/mentralabs/issue/OS-1011/fix-mentra-live-gallery-sync-issues)
- [OS-1177](https://linear.app/mentralabs/issue/OS-1177/gallery-sync-fails-with-decoding-errors)
- [OS-1384](https://linear.app/mentralabs/issue/OS-1384/long-video-transfers-from-glasses-to-phone-fail-and-become-un-redownloadable-need-resumable-transfer)
- [OS-1472](https://linear.app/mentralabs/issue/OS-1472/gallery-sync-shows-in-mentra-app-but-not-saved-to-phone-camera-roll)
- [OS-1087](https://linear.app/mentralabs/issue/OS-1087/mentra-live-switch-hotspot-to-be-5ghz)

## Audit boundaries and confidence

The conclusions in this document are based on a second static pass through the current phone and glasses code, exact bundled dependency source where relevant, and current Linear issue context.

The following limitations remain:

- Sentry production events were not queried because `SENTRY_AUTH_TOKEN` was unavailable.
- The ADB-connected Mentra Live was intentionally not accessed because another agent owned it.
- No packet capture or raw radio benchmark was performed.

The code defects below are confirmed. Their relative contribution to the field failure population cannot be assigned without Sentry correlation and device fault injection.

One earlier suspicion was retracted: NanoHTTPD's five-minute accepted-socket timeout is an input/read timeout, not a total outgoing transfer deadline. It should not be treated as the cause of a download dying after five minutes.

## Non-negotiable safety invariant

> Never acknowledge, trash, or physically delete a source capture unless every destination receipt required by the user's settings has been durably committed.

When automatic camera-roll export is enabled, the required receipts are:

1. A verified Mentra App file committed under a relative, portable path.
2. A camera-roll asset identifier or URI proving export completed.

When automatic camera-roll export is disabled, the verified and indexed Mentra App file may satisfy the destination requirement. Source removal must still use recoverable trash before garbage collection.

## Confirmed defects

### 1. Camera-roll failure does not stop glasses deletion

`mediaProcessingQueue` records `saveToLibrary()` failure but continues through metadata handling and the deletion path. Permission failures and native Photos/MediaStore failures can therefore remove the source from the glasses without a camera-roll copy.

An unmerged commit, `db72411db7`, changes this failure into a throw. That is an appropriate emergency guard but not the complete durable design: the local file should remain indexed as `EXPORT_PENDING`, and export should be retried without downloading again.

### 2. Resume is not byte resume and is effectively disconnected

The current downloader sends no `Range` request, requires status 200, and downloads from byte zero. The saved queue contains filenames and an item index, not byte offsets, source generations, hashes, or verified-file receipts. `resumeSync()` restarts `startSync()`, has no discovered UI caller, and the actual download path does not use the saved queue to skip verified transfers.

### 3. iOS has a hard ten-minute whole-resource deadline

The app passes `backgroundTimeout: 600000` to RNFS. The installed iOS implementation maps this to `URLSessionConfiguration.timeoutIntervalForResource`, which bounds the entire resource transfer. A slow 20-minute recording can fail simply because it has not completed within ten minutes.

### 4. A retry can destroy a valid local copy

The final gallery path is used as the active download destination.

- Android RNFS opens that path with a truncating `FileOutputStream`.
- iOS uses a temporary download location, but the app's catch path unlinks the destination.

Retries must use a distinct `.partial` or generation-specific segment path and must never touch an existing verified final file until atomic replacement is ready.

### 5. Download HTTP framing is invalid

The server manually sends `Content-Length` and constructs a NanoHTTPD chunked response. NanoHTTPD then also sends `Transfer-Encoding: chunked`. HTTP forbids both framing modes in one response.

The violation is definite. Its production incident share still needs client-error and packet-trace correlation.

### 6. Manifest generation is expensive and duplicated

The phone requests inline thumbnails. The glasses synchronously generate/read thumbnails, base64-encode them, and extract video duration before returning the manifest. The response carries both legacy `changed_files` and capture-oriented `captures`, duplicating primary thumbnail data. The phone logs the parsed payload and persists thumbnail-heavy objects in the sync queue.

The request has a hard 30-second timeout. A large gallery can therefore fail before the first media transfer begins.

### 7. Transfer ordering and concurrency amplify latency

The current capture path processes captures and their files sequentially. The legacy path has a concurrency limit of one plus an inter-file delay. Oldest-first ordering makes users wait through unrelated backlog before seeing the newest capture.

### 8. Gallery path persistence reintroduces absolute paths

Reading downloaded-file metadata reconstructs relative paths as absolute. Saving a later item rewrites the entire collection while only relativizing the new entry, so older entries become absolute again. iOS container paths can change, after which the gallery treats those entries as missing and removes metadata.

A pending branch prevents part of the future rewrite cycle but does not fully recover already-stale absolute paths.

### 9. Camera-roll export has no idempotency receipt

The native export methods already return an iOS Photos identifier or Android MediaStore URI. The JavaScript wrapper discards it and returns a boolean. After an ambiguous failure, retrying export can create duplicate assets because the application cannot prove which export already completed.

### 10. Validation is too weak for irreversible deletion

Validation relies on exact size, basic file signatures, and permissive processed-size comparisons. It lacks a source hash, stable source generation/ETag, and strong media structure validation. Size plus magic bytes is not proof that a large MP4 is complete and decodable.

### 11. Completion and queue semantics can discard failed work

The queue does not model transfer, verification, export, and acknowledgement independently. Progress can advance before asynchronous media processing finishes, and completion cleanup can clear the saved queue despite failures. A timestamp watermark cannot substitute for per-capture durable receipts.

### 12. Server deletion is not transactional

The delete request body is read with a single `read()` instead of a complete-body loop. Child deletion results are ignored, directory deletion is used to infer success, and the phone does not honor the returned `deleted` and `failed` arrays reliably.

### 13. The old storage and queue schemas should not be mutated in place

Changing the meaning or required shape of existing keys risks app downgrade failures and partial migration states. The durable transfer ledger must be versioned separately, with optional additive metadata on legacy records.

## Compatibility strategy

Full resumability is available only when both sides support it, but safety can improve independently on either side.

| Phone | Glasses | Supported behavior |
| --- | --- | --- |
| New | New | Full byte resume, hashes, lightweight manifest, export receipts, idempotent acknowledgement, recoverable trash |
| New | Old | Safe `.partial` handling, durable local/export states, whole-file retry, and conservative legacy deletion; no true byte resume or server hash/trash guarantee |
| Old | New | Existing endpoint schemas remain valid; corrected framing and transparent server-side trash protect old clients; no client-side resume |
| Old | Old | Existing behavior remains unchanged |

### Compatibility rules

1. Freeze `/api/sync` at `api_version: 2`.
   - Current phone code tests for version 2 exactly.
   - Returning 3 on the existing endpoint can trigger legacy fallback and lose capture grouping or sidecar behavior.
2. Preserve the existing v2 response shape, duplicate legacy fields, ordering, and unpaginated behavior for released clients.
3. Add a separate `/api/v3/capabilities` and `/api/v3/manifest`, or equivalent new routes.
4. Treat absent capabilities or HTTP 404 as an old server and fall back safely.
5. Preserve `/api/download` as a fixed-length status 200 response when no `Range` header is sent.
6. Add standards-compliant 206/`Content-Range`/ETag behavior only when a valid `Range` header is present.
7. If a new phone sends `Range` to an old server and receives status 200, reset the partial file. Never append a full response to an existing partial.
8. Validate that a 206 range begins at the requested offset before appending.
9. Keep old delete request and response schemas, but implement deletion internally as an atomic move to hidden trash.
10. Keep trash outside every old and new live-manifest namespace.
11. Add optional hashes, durations, generations, and capabilities. Old JSON clients can ignore unknown fields.
12. Gate concurrency on an advertised server limit. Default to one transfer against old servers.
13. Use a new versioned transfer-ledger storage key so old application versions can still read their existing metadata after downgrade.

## Durable transfer model

Each capture is tracked by a stable capture ID. Legacy flat media without a capture ID uses a composite identity such as package, filename, size, and modified timestamp.

```text
DISCOVERED
  -> TRANSFERRING
  -> VERIFIED
  -> INDEXED
  -> EXPORT_PENDING
  -> EXPORTED
  -> ACK_PENDING
  -> TRASHED
  -> GARBAGE_COLLECTED
```

Each state transition is persisted atomically. Failure leaves the capture in the last recoverable state.

Suggested ledger fields:

- Ledger schema version.
- Capture identity and source filename set.
- Source generation/ETag.
- Expected sizes and optional hashes.
- Partial paths and durable byte offsets.
- Verified final relative paths.
- Verification method and timestamp.
- Camera-roll export requirement.
- Camera-roll asset identifier/URI.
- Acknowledgement ID and status.
- Retry count, last error class, and next retry time.
- Server capability snapshot.

## Filesystem rules

1. The final gallery path is never an active network destination.
2. Download to `.partial.<generation>` or immutable segments.
3. Persist offsets periodically rather than only at file completion.
4. Validate size, range total, source generation, hash, and media structure.
5. Flush the completed temporary file before committing it.
6. Atomically rename into the final path.
7. Persist only a relative final path.
8. Commit metadata and the verified ledger transition atomically or in a recoverable two-phase sequence.
9. Preserve an older valid final file until the replacement is completely verified.

## Resumable protocol

### Capability discovery

The new phone asks for capabilities before requesting a v3 manifest. Useful fields include:

- Transfer protocol version.
- Range support.
- Hash algorithms.
- Manifest version and page limit.
- Maximum recommended photo/video concurrency.
- Trash and restore support.
- Hotspot/network telemetry support.

### Download algorithm

1. Locate a partial file and ledger entry for the same capture and ETag.
2. Send `Range: bytes=<durableOffset>-` and `If-Range: <etag>`.
3. On 206, require `Content-Range` to start at the requested offset and append through a non-truncating native writer.
4. On 200, reset the partial because the server is old, ignored the range, or the source changed.
5. On 416, compare the declared total against the partial size and verify before considering it complete.
6. If ETag/source generation changes, discard the old partial and restart safely.
7. Persist progress every bounded time/byte interval.
8. Retry transient failures with exponential backoff, jitter, and hotspot reconnection.
9. Verify and atomically commit.
10. Retry export and acknowledgement from the ledger without downloading again.

RNFS is not sufficient for a durable Android append path. Implement a small native transfer module using a non-truncating file API and explicit network binding, or download immutable segments and assemble them after verification.

## Export receipts and idempotency

1. Return the native iOS Photos local identifier or Android MediaStore URI to JavaScript.
2. Persist it as the export receipt before acknowledgement.
3. Use capture ID, intended display name, size/hash, and stored receipt to decide whether export is already complete.
4. If the native operation is ambiguous, reconcile with the media library before inserting another asset.
5. Give native export operations bounded timeouts and cancellation/error reporting; avoid indefinite semaphore waits.

## Manifest v3

The v3 manifest should contain lightweight, precomputed metadata:

- Capture ID.
- Capture timestamp.
- File names and media roles.
- Size.
- Stable source generation/ETag.
- Duration.
- SHA-256 or another negotiated hash.
- Optional thumbnail resource URL or thumbnail generation token.

It should not inline base64 thumbnail data by default.

Additional requirements:

- Cursor pagination using timestamp plus capture ID/generation, not timestamp alone.
- Newest-first retrieval.
- Explicit selected-capture retrieval.
- Lazy thumbnail endpoints with cache validators.
- Precompute duration/hash at capture finalization.
- Batch acknowledgement.
- Do not use a global timestamp watermark as proof of per-capture completion.

## Source acknowledgement and recoverable trash

1. Add an idempotent v3 acknowledgement endpoint keyed by capture ID and acknowledgement ID.
2. Acknowledgement atomically moves the complete capture package into hidden trash.
3. Make the legacy delete endpoint perform the same internal move while preserving its current schema.
4. Exclude trash from counts, manifests, thumbnail scans, and legacy prefix matching.
5. Retain trash for at least seven days by default.
6. Garbage-collect by age and storage high-water mark.
7. Expose trash list and restore to new clients.
8. Log every acknowledgement, trash move, restore, and garbage-collection reason.

## Implementation phases

### Phase 0: immediate phone data-safety release

Works against all existing glasses versions.

- Use separate partial paths; never overwrite a verified final file during transfer.
- Persist/index the verified local file before camera-roll export.
- Convert export failure into `EXPORT_PENDING` and never delete the source.
- Preserve native asset identifiers/URIs.
- Honor actual delete results.
- Do not report complete or clear work while transfer, export, or acknowledgement is pending.
- Introduce the versioned ledger and migrate the current queue conservatively.
- Raise the iOS whole-resource deadline as a short-term mitigation until resume ships.
- Stop persisting/logging inline thumbnail base64.
- Request thumbnails only when needed by the current UI.
- Run the relative-path migration before stale-file cleanup.
- Quarantine unresolved metadata instead of deleting it on the first missing-path check.

### Phase 1: backward-compatible glasses safety release

- Correct HTTP framing with fixed-length status 200 downloads.
- Add optional Range/ETag/206/416 support.
- Add capability discovery.
- Precompute and persist size, duration, generation, and hashes at capture finalization.
- Make legacy deletion an atomic trash move.
- Add idempotent acknowledgement, trash listing, restore, and retention GC.
- Read request bodies fully and report per-capture results accurately.
- Preserve all released endpoint schemas.

### Phase 2: new phone v3 transfer client

- Implement the native resumable transfer module or immutable segment transport.
- Persist byte offsets and generations.
- Implement safe old-server status-200 fallback.
- Add bounded retry, reconnection, validation, atomic commit, export receipt, and acknowledgement state transitions.
- Resume transfer/export/acknowledgement from ledger state after app termination or reboot.

### Phase 3: end-to-end performance

- Add v3 lightweight manifests and pagination.
- Support newest-first and selected captures.
- Fetch thumbnails lazily.
- Batch acknowledgements and other small operations.
- Add capability-gated adaptive concurrency.
- Remove avoidable per-file delays.
- Measure time to first selectable item separately from full-sync duration.

### Phase 4: hotspot and routing

Treat this as a separate workstream from transfer correctness.

- Preserve released SSID behavior and `192.168.43.1` compatibility unless a capability-negotiated replacement is introduced.
- Determine whether the Mentra Live DHCP server advertises an unwanted default route or DNS server.
- If firmware supports it, provide a local-only AP profile that advertises the on-link subnet without claiming internet reachability.
- On Android phones, retain the `Network` returned for the Mentra hotspot and bind only gallery HTTP sockets to it. Do not bind the entire process.
- On iOS, validate `NEHotspotConfiguration` behavior and on-link routing independently. Do not assume Android's per-network socket model exists on iOS.
- Log band, channel, frequency, RSSI, negotiated link speed, client IP/prefix, gateway, DNS, active/default network, interface, and route decision.
- Benchmark raw HTTP independently from manifest, validation, hashing, export, and rendering.
- Keep hotspot shutdown ownership explicit and idempotent.

The current `asg_client` only asks the firmware-owned SystemUI/tethering stack to start or stop the AP. It cannot currently choose DHCP options, gateway advertisement, or NAT behavior. App-only work can improve phone-side routing and observability; changing the AP's DHCP/router behavior requires a firmware change or a new firmware API exposed to `asg_client`.

#### Current hotspot/routing findings

- Mentra Live `asg_client` sends the vendor SystemUI an `ap_start` broadcast and later observes the AP interface. It does not construct the Soft AP or DHCP configuration itself.
- The current glasses API calls the AP address `hotspot_gateway_ip` and hardcodes `192.168.43.1`. For compatibility, keep that field, but add an explicit `local_server_ip` in a future capability/version because the glasses should be the local HTTP server without necessarily being the phone's default router.
- Android 11 AOSP's `IpServer` uses a shared DHCP path for tethered and local-only serving modes and supplies the AP address as both the default router and DNS server. Mentra Live's vendor fork may differ, but merely switching to an API named `LocalOnlyHotspot` is therefore not proof that iOS will preserve cellular as its default route. Inspect the actual Mentra Live DHCP offer and test iOS routing.
- Android phone builds use `react-native-wifi-reborn` 4.13.6. On Android 10+, its `WifiNetworkSpecifier` request correctly removes the Internet capability, but its `onAvailable` callback then binds the entire Mentra App process to that network. All subsequently created sockets and DNS queries therefore use the no-Internet hotspot until the network is lost or explicitly unbound.
- Fix Android by retaining the returned `Network`, leaving the process unbound, and constructing the gallery HTTP/downloader client with that network's `SocketFactory` or individually bound sockets. Cloud and unrelated app traffic then continue on the system default, normally cellular.
- The existing JavaScript `fetch` and RNFS paths cannot receive an Android `Network`/`SocketFactory`. The scoped-routing fix should be part of the native resumable transfer module rather than another global network toggle.
- On iOS, `react-native-wifi-reborn` uses `NEHotspotConfiguration` with `joinOnce = false`. iOS has no direct equivalent to Android's app-visible `Network` object for binding an ordinary `URLSession` to the selected local WiFi network.
- For iOS, the preferred architecture is for the accessory network not to claim the default route. The directly connected subnet route then reaches `192.168.43.1` over WiFi while Internet traffic can remain on cellular.
- Setting `joinOnce = true` can prevent a persistent hotspot profile, but it also disconnects when the app backgrounds for more than roughly 15 seconds, sleeps, quits, or crashes. It is not a substitute for correct DHCP behavior and can conflict with long/background transfers.
- If firmware cannot stop claiming the default route, iOS app-only workarounds require explicitly routing Internet sessions over cellular or Multipath TCP where applicable. Those workarounds do not fix other apps on the phone and are not the preferred product solution.

#### Phase 4 work split

1. Phone-only Android work:
   - Replace/fork the current hotspot connection helper so it never calls process-wide `bindProcessToNetwork`.
   - Keep the `NetworkCallback` and hotspot `Network` alive for the gallery session.
   - Bind only health, manifest, thumbnail, download, acknowledgement, and benchmark sockets to it.
   - Explicitly release the callback/network at completion and cancellation.
2. Glasses application spike on stock firmware:
   - Determine whether the existing vendor APIs can start a local-only scope while preserving the reported SSID/password and `192.168.43.1`.
   - Capture the DHCP offer and route behavior. Do not infer behavior from the API name.
3. Firmware work if the stock platform cannot provide the required DHCP behavior:
   - Add a vendor SystemUI/tethering command for a gallery local-only profile, analogous to the existing 5 GHz control.
   - Keep the AP interface/server address `192.168.43.1/24` for old clients.
   - Do not advertise the glasses as a default Internet router or unusable DNS server for this profile.
   - Preserve the existing legacy hotspot mode as a fallback selected by capability/version.
4. iOS work:
   - Continue using the supported hotspot-configuration entitlement and explicit user join flow.
   - Validate local HTTP plus simultaneous cellular Internet on every supported iOS version.
   - Decide between persistent configuration with explicit removal and `joinOnce` based on foreground/background product requirements.
   - Use a firmware fix, not broad cellular-binding workarounds, as the primary route solution.

### Phase 5: recovery and operations

- Add a user-visible retry/export-pending state.
- Add trash restore UI.
- Add storage-pressure warnings and deterministic GC telemetry.
- Add structured incident fields for every transfer state transition.
- Consider USB or cloud recovery paths for captures that cannot be retrieved over WiFi.

## Relative-path migration

The migration must run before gallery cleanup and be idempotent.

1. Leave valid relative paths unchanged.
2. Convert files under the current document directory to relative paths.
3. For an old iOS container path, extract the suffix after `/Documents/` and test it under the current document directory.
4. If necessary, locate the expected `MentraPhotos/...` suffix under the current root.
5. Verify file identity using size and available hash before relinking.
6. Rewrite recovered entries as relative.
7. Quarantine unresolved records for later reconciliation rather than deleting them immediately.
8. Test repeated migration, app upgrade, app downgrade, and missing-file behavior.

## Observability

Every transfer attempt should carry stable correlation fields:

- Sync session ID.
- Capture ID.
- Phone app version/platform/OS/device.
- Glasses app and MTK firmware versions.
- Protocol/capability versions.
- Hotspot startup and join durations.
- Manifest count, byte size, generation time, and parse time.
- Download offset, requested range, response status, ETag, expected/received bytes, and retry class.
- Raw throughput sampled over bounded windows.
- Validation result and duration.
- Filesystem commit result.
- Export result and native asset receipt presence.
- Acknowledgement/trash result.
- Current network interface, route, band, channel/frequency, RSSI, and link speed when available.

Never log hotspot passwords, camera-roll identifiers in plaintext telemetry, full manifests, thumbnail base64, or media contents.

## Verification matrix

### Version compatibility

- Released old phone against new glasses.
- New phone against at least two or three released glasses firmware versions.
- New phone and new glasses.
- Upgrade from legacy storage/queue state.
- Downgrade after the new ledger has been created.

### Data sets

- One photo.
- One short video.
- Mixed photos, videos, and sidecars.
- More than 100 captures.
- A large video.
- A roughly 20-minute video.
- Selected newest capture with a large older backlog.

### Fault injection

- Disconnect at 10%, 50%, and 90%.
- WiFi flap.
- Bluetooth disconnect while hotspot is running.
- App background and foreground.
- App force-kill.
- Phone reboot.
- Glasses reboot.
- Phone storage full.
- Glasses storage full.
- Camera-roll permission denied.
- Native Photos/MediaStore export error.
- Export operation completes but response is lost.
- Source changes ETag during retry.
- Corrupt source.
- Corrupt partial file.
- Old server ignores Range and returns 200.
- Server returns invalid or mismatched `Content-Range`.
- Delete request body arrives in multiple reads.
- Trash storage crosses the high-water mark.

### Hotspot/platform matrix

- Current supported iOS versions and representative iPhones.
- Current supported Android versions and representative Samsung/Pixel devices.
- Cellular available versus unavailable.
- Phone initially on another WiFi network versus cellular only.
- 2.4 GHz fallback versus 5 GHz hotspot.
- Weak RSSI and interference.
- Screen lock/background where supported.
- Verify internet requests continue over cellular while gallery sockets use the hotspot.

## Release gates

- No physical source deletion before the destination-receipt invariant is satisfied.
- Every injected interruption remains recoverable.
- A resumed transfer requests only missing bytes, aside from bounded validation/protocol overhead.
- Retry never truncates or deletes an existing verified file.
- Export retry does not create duplicate camera-roll assets.
- No absolute iOS container paths remain after migration.
- Failed items remain visible and retryable after app restart.
- Old clients continue parsing and using every legacy endpoint.
- New clients safely handle old servers returning 200 to a Range request.
- Large manifests do not spend the majority of time generating inline thumbnails.
- A 20-minute video either completes in one attempt or resumes to completion after interruption.
- Raw hotspot throughput and full-pipeline throughput are reported separately.

## Proposed performance measurements

Measure at least:

- Hotspot command to AP ready.
- AP ready to phone associated.
- Association to health endpoint reachable.
- Manifest server generation time, response bytes, transfer time, and client parse time.
- Time to first thumbnail.
- Time to first selected/latest media download start.
- Raw sustained download throughput for a preexisting large file.
- Hash/validation time.
- Atomic commit time.
- Camera-roll export time.
- Acknowledgement/trash time.
- End-to-end time for one photo, mixed backlog, 100+ captures, and 20-minute video.

Do not infer radio performance from end-to-end sync time. Benchmark the raw download endpoint with manifest generation and export excluded.

## Open questions

- What exact Sentry issues and error domains dominate current failed long transfers?
- What DHCP router and DNS options does current Mentra Live firmware advertise?
- Does current MTK firmware support a true local-only Soft AP profile, or must vendor SystemUI/tethering be extended?
- What is the cleanest native-module boundary for retaining Android's hotspot `Network` and sharing its scoped `SocketFactory` with manifest and resumable-download clients?
- How does each supported iOS version route on-link hotspot traffic while keeping cellular as the internet path?
- What raw TCP/HTTP throughput is achieved on current 5 GHz firmware at controlled RSSI?
- What trash retention period is acceptable for glasses storage constraints?
- Should automatic export failure surface as a persistent gallery item, a notification, or both?

## Immediate implementation order

1. Ship phone-side source-deletion barrier and `.partial` safety.
2. Ship server-side transparent trash and correct HTTP framing.
3. Ship relative-path recovery before metadata cleanup.
4. Introduce the versioned transfer ledger and export receipts.
5. Add Range/hash/capability support to glasses.
6. Ship the native resumable phone client.
7. Replace the heavyweight manifest and add selection/pagination.
8. Implement and benchmark the platform-specific hotspot/routing work.
9. Add recovery UI and storage-pressure GC.
