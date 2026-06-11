# Incident: streaming broken — Cloudflare live-input leak (2026-06-11)

## Symptom
CEO report: "streaming isn't working." cayden@mentra.glass: dev 0-for-61,
staging 0-for-34, prod flaky (his 16:44 attempt timed out twice, went live on
the 3rd poll). Glasses report `{"status":"error","errorDetails":"not_streaming"}`.

## Root cause
The shared Cloudflare account (dev+staging+prod all use account ...544a94) had
**11,778 live inputs** against Cloudflare's 1,000-per-account limit. At that
level CF accepts the RTMP handshake then kills the publish mid-stream.

Reproduced glasses-free from a laptop: `ffmpeg -> rtmps://live.cloudflare.com`
against a freshly-created input on this account connects, then dies mid-publish
("Error submitting a packet to the muxer: End of file"); CF status shows
connected -> disconnected. Same with and without an audio track.

## Why it leaked
- `CloudflareStreamService.createLiveInput` runs on every stream start.
- The ONLY `deleteLiveInput` call site is inside
  `cleanupOrphanedStreams(activeStreamIds)` (CloudflareStreamService.ts:641),
  which has **zero callers** — dead code. Production has never deleted an
  input; 11,778 = total streams ever started (July 2025 -> now).
- Amplifier: the stream-start retry loop re-requests every ~2s on "timeout
  waiting for stream to go live" — one user session this morning created ~17
  inputs in 50 seconds.

## Remediation done (2026-06-11)
- Bulk purge of 11,293 stale inputs (kept: anything connected — there were 0 —
  and anything <7 days old, 485). Script: /tmp/cf_cleanup.py, 4 workers,
  ~2/s, 429-aware. Verified post-purge with a live ffmpeg publish test.

## Fixes needed in cloud/ (owner: streaming team — cloud/ is read-only for the harness)
1. **Delete on stop**: call `deleteLiveInput` from the managed/unmanaged stream
   cleanup paths ("Cleaning up managed stream" in ManagedStreamingExtension).
2. **Wire the janitor**: schedule `cleanupOrphanedStreams` (e.g. hourly timer
   per region, passing the active stream set). It already exists and already
   has the right policy (unconnected && older than 1h).
3. **Backoff the retry storm**: "timeout waiting for stream to go live" retries
   every ~2s and creates a fresh input per attempt; reuse the existing input on
   retry, or cap attempts with exponential backoff.
4. **Optional**: separate CF accounts (or at least live-input prefixes + alerts)
   for dev/staging vs prod, so test churn can't degrade production streaming.
   An alert on live-input count > 500 would have caught this months ago.

## Secondary findings from the same logs
- Glasses status messages arrive without a streamId and fall through to
  UnmanagedStreamingExtension ("Received status message without streamId") even
  for managed streams — correlation relies on keep-alive ACKs only.
- "Timeout waiting for stream to go live" uses maxAttempts=1, so prod logs a
  scary warn on every start even when the stream goes live 3s later.

## UPDATE (post-purge): the live-input leak was NOT the stream killer

After the purge (11,293 deleted, 0 failed, 492 remain — well under limits) the
laptop RTMPS publish STILL died mid-stream. Discriminator test from the same
machine/account: plain `rtmp://live.cloudflare.com:1935` streamed 16s clean
(state=connected throughout); `rtmps://...:443` is killed mid-publish every
time. Root cause of "streaming isn't working": **the office network kills
long-lived RTMPS (TLS) connections on 443** — DPI/SSL-inspection middlebox
signature. Glasses are always handed rtmps:443 URLs, so streaming fails for
anyone on office WiFi and works elsewhere (matches Sean Mulhern's successes
and prod's ~40% timeout rate).

Fixes:
- Short term: allowlist live.cloudflare.com (or RTMPS generally) in the office
  firewall; or have devs test on hotspot.
- Product hardening: fall back to rtmp:1935 or SRT when rtmps:443 publish dies
  within seconds (StreamCommandHandler already supports srt/whip).
- The live-input leak fixes (delete-on-stop, schedule the janitor, retry
  backoff) are still required — the account was 11x over CF's documented limit.
