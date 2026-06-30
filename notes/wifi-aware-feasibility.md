# Can Mentra Live stream video to iPhone over Wi-Fi Aware?

**Short answer: Almost certainly no, on current hardware.** Our glasses' Wi-Fi chip
does not support Wi-Fi Aware, and even if it did, Apple's Wi-Fi Aware only works on
iPhone 12+ running iOS 26+. We've sent a
question to the ODM to confirm the hardware fact, but we should not bet the iOS-video
roadmap on a "yes."

---

## The problem we were trying to solve

We want to stream video from Mentra Live → iPhone over Wi-Fi (high bandwidth, low
latency). The clean ways to do this all break on iPhone:

- **Glasses-as-hotspot (SoftAP):** When an iPhone joins a Wi-Fi network with no
  internet, iOS treats that as "the network" and effectively loses internet. Bad for
  an always-on, cloud-connected product.
- **Phone-as-hotspot:** Bad UX, and many enterprise iPhones don't even have a hotspot
  data plan.
- **Wi-Fi Direct:** Android supports it; **iPhone does not, and never has.**

That leaves **Wi-Fi Aware** (technical name: **NAN**) as the only standards-based way
for an iPhone to talk peer-to-peer over Wi-Fi *without giving up its internet*. So the
question became: can we use Wi-Fi Aware?

## Two things both have to be true. Neither is.

Wi-Fi Aware needs support on **both ends** — the glasses and the iPhone. Today both
ends fail.

### 1. Our glasses' Wi-Fi chip does not support Wi-Fi Aware

We checked the actual hardware on a connected Mentra Live (not spec sheets — the
device itself). The Wi-Fi chip reports as an older MediaTek connectivity part
(`chipid 0x6761`, `gen4m` driver, 2021 "CERVINO" firmware). On this generation,
Wi-Fi Aware / NAN is not built in:

- Android does not list the `wifi.aware` capability.
- There is no `nan0` Wi-Fi Aware network interface on the device.
- The vendor never shipped the Wi-Fi Aware permission file.

Note: the main processor really is the newer **MT8766B** (an earlier build label
incorrectly said MT6761). But the **Wi-Fi block is the older part**, carried over from
the original MT6761 design. So the chip mislabel doesn't help us — the Wi-Fi itself is
genuinely the older generation.

**Open item (ODM):** We've asked the ODM's firmware engineer for the exact Wi-Fi chip
part number and whether any firmware build can turn NAN on. Best realistic case is
"it's a firmware add" (a real but bounded engineering task). Most likely case is "this
chip can't do it" (hardware change required). We'll update when he replies.

### 2. Apple's Wi-Fi Aware is too new for our user base

Apple only added Wi-Fi Aware in **iOS 26 (Sept 2025)**, and only on **iPhone 12 and
newer**. Any older iPhone or older iOS gets nothing. For enterprise fleets — which
often run older phones and older iOS — this rules out a large share of users. Even a
perfect glasses-side fix would only serve our newest iPhones.

On top of that, Wi-Fi Aware between Apple and non-Apple hardware is still immature in
practice; teams are actively struggling to get these handshakes working. It would need
real prototyping time before we could trust it.

## Recommendation

1. **Don't gate iOS video on Wi-Fi Aware.** Even the best-case outcome only covers the
   newest iPhones, so we need another path regardless.
2. **Send the ODM question** (done) to get the hardware fact on record — cheap, and
   tells us if this is forever-off or a future option.
3. **Pursue an iOS video path that works on all iPhones now.** The two realistic
   options:
   - **Cloud relay:** glasses → cloud → phone. Works on any iPhone, no Wi-Fi conflict.
     Costs some latency and bandwidth.
   - **BLE video to iPhone:** lower-bitrate stream over the Bluetooth link we already
     have. Limited quality, but ships on current hardware.
4. **Keep full Wi-Fi video for Android,** where SoftAP/Wi-Fi Direct work cleanly today.

## One-line summary for the board

> Wi-Fi Aware is blocked on both ends — our current Wi-Fi chip doesn't support it, and
> Apple only supports it on iPhone 12 + iOS 26. We're confirming the hardware with the
> ODM, but iOS video should ship over cloud relay or BLE, not Wi-Fi Aware.

---

*Hardware facts verified on a connected Mentra Live unit (2026-06-27): CPU `MT8766B`,
Wi-Fi `chipid 0x6761` / `gen4m` / CERVINO firmware (2021), Android 11. No `wifi.aware`
feature, no `nan0` interface.*
