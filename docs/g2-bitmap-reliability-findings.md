# G2 bitmap reliability: findings from the BLE harness

**For:** Fosse (G2 native driver owner)
**From:** agent-harness work (Isaiah)
**Re:** `fixes-53` branch, `mobile/modules/bluetooth-sdk/android/.../sgcs/G2.kt`
**Status:** investigation notes + recommendations. No code changed.

## TL;DR

While building a standalone BLE harness that drives a real G2 from a Mac, I
ported the image path 1:1 from `G2.kt`, then had to diverge in a few specific
places before bitmaps would actually render on the lens. `fixes-53` already does
most of what I learned. Two differences still stand out and are the exact changes
that turned "nothing renders" into "photos render" on hardware:

1. **Image container IDs 10–13 never rendered on this firmware** — the harness
   only gets pixels with low IDs (1, or 1..4 for tiles). `fixes-53` uses 10–13.
2. **Multi-fragment image transfer is broken on this firmware** — fragment 0
   ACKs success, every continuation ACKs failure. The harness avoids it entirely
   by tiling into single-fragment strips. `fixes-53` still multi-fragments any
   image larger than one 4096 B fragment.

Both are empirical against firmware **2.2.4.34** on a physical G2 pair (confirmed
on-lens). If `fixes-53` targets newer firmware these may differ, but they're the
first things I'd check.

## What `fixes-53` already gets right

Calling this out so the below reads as "two gaps," not "rewrite it." The branch
already does, and matches the harness on:

- **Per-fragment ACK gating.** Waits for each fragment's `ImgResCmd` (4 = success,
  5 = failed), correlated by (session, fragmentIndex); the ACK paces the stream,
  no blind timer. (`G2.kt sendImageData`.)
- **Whole-image retry with a fresh session** on fail/timeout (`IMG_MAX_ATTEMPTS`),
  so a stale ACK from a prior attempt can't match.
- **Full image header in every fragment** (container/name/session/totalSize).
- **8 ms inter-BLE-packet gap** (`BLE_PACKET_GAP_MS = 8L`) so the Android GATT
  stack doesn't silently drop bursted `WRITE_TYPE_NO_RESPONSE` packets.
- **CREATE first, REBUILD after** (`createPageMessage` vs `rebuildPageMessage`).
- **Max-4 image containers with eviction.**
- An EvenHub command resend (`EVEN_HUB_RESEND_COUNT`) the harness doesn't even have.

## The two high-impact findings

### 1. Container IDs 10–13 never render; use low IDs

`fixes-53`:

```kotlin
private val imageContainerIDPool: List<Int> = listOf(10, 11, 12, 13)
```

The harness only ever saw pixels on the lens with **low container IDs**:

- image-only page → ID **1**
- page shared with the default `text-1` event-capture container → ID **2**
  (ID 1 collides with the text container on a shared page)
- tiled strips → IDs **1..4**

The failure mode is nasty: with 10–13 the firmware still **ACKs `code=4`
(success)** for fragment 0, so the transfer looks healthy in logs, but nothing
appears. I never root-caused *why* 10–13 is rejected for display — only that
switching to low IDs is what made images show up.

**Recommendation:** change the image container ID pool to low IDs that don't
collide with the text/event-capture container (e.g. `2, 3, 4, 5`, reserving 1 for
the event-capture text container, or `1` on image-only pages). Verify on hardware.

### 2. Multi-fragment transfer is broken; tile into single-fragment strips

`fixes-53` `sendImageData` fragments any image larger than 4096 B into one
container and streams `mapFragmentIndex` 0,1,2,… under one session id. On 2.2.4.34
the firmware reassembly is broken:

> fragment 0 → ACK `code=4` (success); every continuation fragment → ACK `code=5`
> (failed).

So a >4096 B image will: send frag 0 (ok), send frag 1 (fail) → abandon attempt →
retry whole image (fresh session) → fail again → exhaust `IMG_MAX_ATTEMPTS` and
give up. **The image never renders.**

This already bites the branch's default rect: a 200×100 4-bit BMP is
~`(100 rowBytes × 100 rows) + 118 header ≈ 10.1 KB` → 3 fragments → fails.

The harness's working approach (`displayImageTiled`): split the image into
**horizontal strips, each a single ≤4096 B fragment in its own container**, and
declare all strips in **one** rebuild. With a 4-bit BMP:

```
rowBytes = (ceil(width / 2) + 3) & ~3
maxRows  = floor((4096 - 118) / rowBytes)   // rows that fit in one fragment
strips   = ceil(height / maxRows)           // must be <= 4 (container limit)
```

Each strip is then a single `updateImageRawData` with `mapFragmentIndex = 0`,
ACK-gated like today. This is the only image path I got to render reliably.

**Recommendation:** for any image that doesn't fit in one fragment, tile it into
≤4 single-fragment strip containers instead of multi-fragmenting one container.
If a target image needs more than 4 strips at its width, it has to be smaller
(or width reduced) — the firmware caps at 4 containers.

## Smaller things

### 3. `IMG_ACK_TIMEOUT_MS = 1000` is tight for slow links

The harness waits **6000 ms** per fragment ACK. On a slower-bonded G2 pair
(the BCC-link pair renders at ~4–6 fps vs the faster one), a legitimately-slow
ACK can exceed 1 s, which trips a spurious whole-image retry and then give-up
after 3 attempts. Consider raising the timeout (or scaling it to link speed).

### 4. `compressMode` field (proto field 5)

`fixes-53` always writes `compressMode = 0` (`w.writeInt32Field(5, 0)`). The
proven harness sender **omits field 5 entirely**. This may be proto-equivalent,
but I deliberately dropped it as part of getting the stream accepted, so flagging
it rather than assuming it's a no-op.

### 5. Session counter advance

The harness advances the session id by **2** after a transfer ("sessions wedge
after a failed stream; advance to skip inherited state") vs `fixes-53`'s +1.
Minor — `fixes-53` already uses a fresh session per attempt, so this is largely
covered. Noting it only for completeness.

## Where this came from

These findings are from an internal BLE harness I (Isaiah) built — a standalone
Mac tool that drives a real G2 over CoreBluetooth, no phone in the loop. It's not
something you need (or have) to act on this; everything load-bearing is captured
above. I mention it only so you know the source: the harness's image encoder was
ported 1:1 from your `G2.kt`, and the divergences listed here are exactly the
points where the 1:1 port wouldn't render and I had to change something. The
4-vs-5 fragment ACK pattern and the 10–13 ID behavior are both visible in the
harness's captured ACK logs.

The cheapest way to confirm #1 and #2 is on your side, directly in `G2.kt`:
flip the container ID pool to low IDs and send a >4096 B image as tiled
single-fragment strips, then watch whether pixels actually land on the lens
(not just whether fragment 0 ACKs success). Happy to hop on a call or pair on the
hardware check — those two are where I'd start.

## Confidence / caveats

All of the above is empirical against **firmware 2.2.4.34** on one physical G2
pair, confirmed by pixels actually appearing on the lens. I did not RE the
firmware, so the *why* behind 10–13 and the multi-fragment NAK is unknown — only
the *what works*. If `fixes-53` runs against different firmware, re-verify on
hardware before taking #1/#2 as given.
