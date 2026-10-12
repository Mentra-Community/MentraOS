---
status: active
owner: philippe
---

# OTA recovery and network retry: investigation and proposed behavior

## Source of truth and scope

The primary evidence is [Cayden's Slack thread](https://mentra-labs.slack.com/archives/C096YCLEBFW/p1790731957550599), its four OTA screenshots, and the attached `phone-and-glasses-logs-20260930.zip`. OS-2046 and OS-2047 are secondary summaries. Philippe explicitly confirmed this evidence priority during the investigation.

This investigation was performed from `origin/staging` at `e09a07ee7b71972e75a5051003ec561c12e6cb9b`, on branch `codex/os-2046-os-2047-investigation`. Implementation now lives on this branch; the execution plan records validation and remaining release qualification. Nothing has been merged or released.

### What Cayden actually reported

| Time, September 29 PDT | Primary evidence |
| --- | --- |
| 23:21:53 | `20881.jpg`: **Update Failed**, “Glasses Wi-Fi has no internet connection”, `no_internet`, Retry and Change Wi-Fi. |
| 23:22:19 | “Slowmo download, taking minutes.” `20883.jpg` actually displays **Installing... 14%**, a download-shaped icon, and “Your glasses will restart twice — this may take up to 2 minutes.” The perceived slowness and ambiguous phase presentation remain UX issues to investigate; this screenshot alone does not measure download throughput or prove a stalled flash. |
| 23:26:01 | “Update Failed issue repeated numerous ties as I tried to retry, and I had to connect/disconnect from the wifi and finally it worked.” This establishes repeated failed retries and eventual recovery after reconnect, not the underlying DNS/routing/server cause. |
| 23:28:36 | “Been at \"Verifying your glasses\" for minutes.” |
| 23:30:02 | “Back to this.” `20887.jpg`: recovery service did not respond, restart instructions, `downgrade_handoff_failed`, Retry. |
| 23:32:02 | “Retried and now in this loop.” `20889.jpg`: **Verifying your glasses...**, automatic restart instructions, and the same two-minute estimate. |
| 23:35:31 | Attached original logs. |

Other replies concern VAD, Mentra AI, Maps, and gallery corners. They are not evidence of an OTA root cause and are outside this two-issue plan.

### What the original logs establish

- ASG remains `303000008` / 3.3.0 while the phone selects the `3.2.1-beta.512` manifest with ASG target `302010058`.
- Phone logs record `downgrade_handoff_failed` at 23:29:38.526 and a fresh `ota_start` on Retry at 23:30:05.117.
- Glasses logs record another complete APK download/checksum at 06:30:31.576 UTC and the recovery handoff at 06:30:31.983 UTC, with no recovery verdict or uninstall observed afterward in the retained interval.
- The retained logs contain no `no_internet` event or corresponding exception for the earlier failure. Its primary evidence is the screenshot and Cayden's account. Later successful requests do not explain the earlier failure.
- Boot/event logs contain a recovery launcher attempt, but not enough recovery startup detail to determine the package/component state or why delivery failed. Absence of a recovery log is not proof that a transaction never existed.

## Physical investigation

Devices: USB-connected Mentra Live and Samsung Z Fold running Android 16. Device identifiers and raw logs remain in the private local evidence bundle.

Initial glasses: ASG `302010058`, recovery v10 / 1.1.2, MTK `MentraLive_20260923.0`. Subsequent ASG/BES state reports BES `26.9.27.0`. Phone: Mentra App 3.2.0, code `302000017`. Therefore this is not Cayden's exact phone/firmware environment or an end-to-end RC phone UI qualification.

ASG's BES battery reports showed the glasses charging above 90%; Android's separate battery service reported a misleading 16%. The phone began at 1% and was charging. No MTK or BES firmware was flashed.

The exact published ASG APKs were checked against release SHA-256 and their matching release signing certificate:

| ASG | SHA-256 |
| --- | --- |
| `303000008` | `95c30d5f219ffe702c875e3bf8150e59094b0e9ac5ebd058e23b8940206a4190` |
| `302010058` | `e9292497ce7d19ef9462fa23f17dd96715868c5b52992b7ab2a88e0e43fe45c9` |

`303000008` originates from release `3.3.0-dev.327`, source `d9cf3febb3ef48f69e1c4306d71dcf53b6a96923`. Its recovery manager/controller/receiver source matches the investigation base. Its OtaHelper differs only in BES terminal reconciliation, not the handoff or downloader under investigation. Both APKs' bundled recovery worker `classes.dex` are identical to the initially installed worker. Matching version numbers alone were not used as binary evidence.

### Controlled results

1. **Unavailable worker reproduces the timeout.** After upgrading to exact `303000008`, temporarily disabled `com.mentra.recovery`. The version gate still accepted it, downloaded and verified all 110,319,540 bytes, and sent the handoff at 20:27:52.828 UTC. At 20:30:52.844 it timed out: **180.016 seconds**, `downgrade_handoff_failed`. Recovery's transaction store stayed empty. A debug retry during the wait was refused as an active install.
2. **Re-enabling recovery allows the exact downgrade.** Retry downloaded the same full APK again. Handoff at 20:31:11.985, acceptance observed at 20:31:12.906, factory revert to `51518114`, then target `302010058` at 20:31:20.359. Recovery emitted `VERSION_CONVERGED` at 20:32:20.513 after its 60-second linger. **All 74 pre-existing gallery files had identical SHA-256 afterward.** This checks stored bytes, not phone gallery rendering.
3. **A stalled server is mislabeled as no internet.** On Mentra Wi-Fi, a local HTTP fixture sent 128 KiB of a real release APK and then stopped sending. ASG raised `SocketTimeoutException` at 20:32:05.973 and `no_internet`. Android's Wi-Fi network remained `100`, connected and `VALIDATED`, with the same route/DNS configuration. Changing only the fixture to serve normally and retrying succeeded: checksum at 20:32:34.468 and installation of `303000008`, without reconnecting Wi-Fi.
4. **A stopped worker is different from a disabled worker.** With no active recovery transaction, force-stopped the enabled worker, then requested `303000008 → 302010058` using the real CDN APK URL over Wi-Fi. The existing include-stopped intent woke recovery and obtained acceptance. This is already handled by the shipped code; adding that flag again is not a fix.

The first two tests used the ASG debug OTA entry point and USB-forwarded HTTP to isolate recovery. The network tests used actual glasses Wi-Fi. These are real ASG/recovery execution tests, not proof of the exact Mentra App Retry button flow. The disabled-worker condition was deliberately introduced; it does **not** establish that Cayden's package was disabled. The controlled stall does **not** reproduce his unexplained persistent network condition.

Raw evidence and reproduction fixtures are retained locally under `incident-logs/ota-investigation-20260930/` (gitignored). Release APKs remain in `/tmp/mentra-ota-investigation-20260930/`. The execution plan records final device disposition.

## Proposed behavior

### OS-2046: establish recovery readiness and preserve transaction ownership

The failing design boundary is in `OtaHelper.stageAndHandoffDowngrade`: recovery version >=10 is treated as sufficient, then a large download precedes any verified receiver response. `RecoveryWorkerManager` also treats broadcast dispatch as startup success. A verified local APK is deleted on every new attempt.

Before downloading, obtain a bounded, permission-protected recovery readiness response. Include package/component enabled state, version/protocol, both signature permissions, and receiver resolution in local diagnostics. Start/deploy the bundled worker using the supported mechanisms, await readiness, and give a specific failure when it cannot become ready. Preserve the current include-stopped behavior. Do not assume that reboot or reinstall clears an explicitly disabled package; validate an OEM enable/repair path or return a support recovery action.

Add a recovery-owned transaction identity and status query. Correlate readiness, handoff, and replies to the request/target/hash. An identical active transaction is an idempotent status/acceptance response; a different active transaction reports its ownership rather than asserting global non-ownership. Keep the existing claimed-artifact isolation and exact-version convergence check.

On a missing acknowledgement, query durable recovery state before allowing new install work. Timeout means unknown delivery, not proof that no transaction started. An accepted transaction keeps ownership through process death, reconnection, and slow completion. Reject late or mismatched verdicts. Current `ServiceHeartbeatReceiver` ignores even the target included in the verdict and applies it to the current process-local waiter.

Cache the verified, unclaimed APK by package/version/hash/size and revalidate it on reuse. Do not touch a recovery-claimed `.txn` file. Only fetch again for a changed pin, missing/corrupt bytes, or an explicit cleanup policy.

The phone should distinguish preparing recovery, downloading, applying the version change, reconnecting, and verifying the actual version. Replace the unconditional two-minute/two-restart narrative with phase-appropriate copy and measured bounds. Preserve Cayden's perceived-slowness report: record phase durations and bytes before declaring performance acceptable.

### OS-2047: truthful network errors and recoverable retries

`classifyDownloadError` currently maps DNS failure, connection refusal/failure, and read timeout to `no_internet`. The controlled test demonstrates that this message can be false even with usable internet connectivity.

Record each attempt's phase, endpoint hostname (no tokens/query secrets), network handle/transport/validation, DNS/link changes, response code, exception chain, received bytes, and last-byte time. Retain this around the failure and retry so the first incident cannot roll out of the support bundle. Distinguish manifest fetch, artifact connect, and body read failures.

Use separate stable error categories and recovery text for no network, network not validated/captive portal, DNS failure, connection failure, read stall, HTTP server failure, TLS/clock error, and checksum failure. Validation is diagnostic evidence, not a mandatory gate: phone-served hotspot OTA intentionally uses a local network without internet validation.

Close streams and disconnect `HttpURLConnection` on every success/error/cancellation path. `downloadApkInternal` currently closes its streams only after normal EOF and does not disconnect; other OTA fetch/download paths need the same audit. This is a source-confirmed cleanup gap, not proof of Cayden's network cause.

Retry should take a fresh network snapshot and create a fresh request on the currently intended transport. Reconcile active OTA/install ownership first. Use bounded transport retries only for retryable download failures, preserve checksums and byte-based liveness, and never restart an active firmware install. When the network is genuinely unusable, provide the appropriate reconnect/captive-portal action. Do not blindly toggle Wi-Fi for every server timeout or bind the whole process to a network.

Capture the original failing network/hotspot and transitions on an affected setup before choosing an MTK driver, DNS, routing, or reconnection-policy patch. The current evidence supports better classification, cleanup, and diagnostics; it does not identify one of those lower-level causes.

## Delivery constraint

An ASG fix that exists only inside the lower target APK cannot repair the updater currently failing to install it. Recovery's standalone remote-update path is disabled in the current source. Ship the corrected recovery protocol with a monotonically versioned worker and a compatible source-side ASG bridge release, then the staging target. For an already stuck device, verify/repair the installed signed worker and its enabled state before retrying. Establish the supported remote bridge route or an explicit support procedure; do not silently introduce an unpinned remote updater.

## Acceptance

- Exact `303000008 → 302010058` plus the supported bridge-to-staging path; confirm installed version, final recovery state, and gallery bytes/UI.
- Missing, outdated, disabled, stopped, incompatible-signature, and crashed recovery cases produce bounded outcomes before unnecessary downloads.
- Lost/delayed/duplicated acceptance, retry, phone remount, and ASG/recovery restarts never replace a live transaction or accept another attempt's verdict.
- Retry reuses a valid cached artifact, rejects corrupt bytes, and preserves claimed bytes.
- Fault-injected DNS/connect/read-stall/server/TLS cases retain distinct evidence and truthful messages; recovery succeeds without manual Wi-Fi reconnect when transport is usable.
- Wi-Fi internet and phone-served hotspot OTA both work, including screen-off/background behavior and network changes.
- RC phone UI reproductions preserve the Slack symptoms and verify clear phases, truthful duration copy, and bounded Retry behavior.
