---
status: draft
owner: Nicolo
---

# ACS Android hardware H.264 encoding

Implementation: [MentraOS PR #3920](https://github.com/Mentra-Community/MentraOS/pull/3920), currently a draft stacked on [Nicolo's ACS/Teams PR #3840](https://github.com/Mentra-Community/MentraOS/pull/3840).

## Summary

We confirmed that Azure Communication Services (ACS) Calling SDK 2.16.0 can send video through Android's hardware H.264 encoder. The SDK does not select it on the tested Qualcomm phones, even when its documented and internal encoder feature flags are enabled. However, the ACS media library contains both software and hardware H.264 implementations. A small, version-specific runtime patch can select the hardware implementation before ACS initializes.

On a Motorola Razr Plus 2024, the patched ACS pipeline used `OMX.qcom.video.encoder.avc`, backed by `c2.qti.avc.encoder`, for the sustained outgoing stream. This establishes technical feasibility; it is not yet a recommendation to enable the patch globally on every Android device.

The intended production flow remains:

```text
Mentra Live -> Cloudflare WHEP -> Mentra App -> ACS -> Microsoft Teams
```

ACS still receives raw video frames. The change only makes ACS encode those frames using the phone's hardware AVC component instead of its software H.264 encoder.

## What was confirmed

- The Razr exposes a real Qualcomm hardware AVC encoder:
  - `OMX.qcom.video.encoder.avc`
  - canonical Codec2 component: `c2.qti.avc.encoder`
- ACS 2.16.0 contains separate `H264SkypeEncoder_SW` and `H264SkypeEncoder_HW` implementations.
- ACS's encoder factory chooses between them using an ARM64 conditional branch.
- Making the factory take its hardware path resulted in sustained hardware encoding.
- The outgoing stream reached Teams at roughly 14-15 FPS. ACS adapted the test stream to approximately 320x180 at 102-103 kbps.
- Android MediaCodec logs showed continuous input/output on the Qualcomm component. A `c2.android.avc.encoder` instance appeared only briefly for an ACS capability probe and was torn down after a few frames.

ACS telemetry continued to label the codec as `h264 sw`. That label describes ACS's internal classification and is not reliable after the runtime patch. The authoritative evidence is Android's MediaCodec/CCodec log showing which component is actually processing the sustained stream.

## Why configuration flags were not enough

The following ACS/ECS settings were tried individually and in combinations:

- `EnableAndroidHwEncoder`
- `EnableAndroidSurfaceHwEncoder`
- `EnableAndroidHWEncoderBySoc`
- `AndroidAdditionalSupportedEncoders`
- `AndroidAdditionalUnsupportedEncoders`
- `DisableSwEncoder`
- `LimitedConfigForRealwear`

We tried boolean values expressed as both `true` and `1`, Qualcomm component names and prefixes, and the short and fully qualified `VideoDSP\MLE` setting paths. None caused ACS to cross its internal hardware-selection gate.

This explains how a phone can expose a working hardware H.264 encoder while ACS still uses software encoding: encoder availability and ACS's decision to instantiate its hardware encoder class are separate decisions.

## Working approach

### 1. Apply the override before ACS initializes

The native ACS media libraries must be loaded and patched before `CallClient` or other ACS classes initialize shared media state.

The current integration does this immediately before constructing `CallClient`:

```kotlin
val encoderOverride = AcsEncoderOverride.apply()
Log.w(TAG, "ACS hardware encoder selection: $encoderOverride")
callClient = CallClient()
```

`AcsEncoderOverride.apply()` is lazy and idempotent, so it executes at most once per process.

### 2. Check that Android exposes hardware AVC

Before touching ACS, query `MediaCodecList.ALL_CODECS` for an encoder supporting `video/avc`. On Android 10 and newer, require `isHardwareAccelerated` and reject `isSoftwareOnly`. On older versions, reject known software component prefixes such as `OMX.google.` and `c2.android.`.

If no hardware AVC component is present, do not patch ACS. Let the SDK retain its normal behavior.

For a production rollout, this check should be strengthened to validate the required resolution, frame rate, color/input format, and known-good codec implementation.

### 3. Patch the verified ACS factory branch

For the tested ACS 2.16.0 ARM64 `libRtmMediaManagerDyn.so`:

- File size: `22,683,240` bytes
- SHA-256: `e15916eb73d7f56725865bcb439261972ca4099ac94d7e601a69735ac70addb3`
- Encoder factory branch offset: `0xDFE070` relative to the library load address

The verified instruction signature is:

```text
0xaa0003f4  mov x20, x0
0x36000143  tbz w3, #0, <software path>
0x528e6ec1  <start of hardware allocation path>
0x52806100  <hardware object allocation setup>
```

Hardware is the fall-through path. Replacing the `tbz` instruction with an ARM64 NOP selects it:

```text
0xd503201f  nop
```

The native implementation should:

1. Find the loaded `libRtmMediaManagerDyn.so` with `dl_iterate_phdr`.
2. Require ARM64.
3. Require the expected relative offset to be inside an executable `PT_LOAD` segment.
4. Compare all four instruction words exactly.
5. Make only the containing code page writable with `mprotect`.
6. Replace the branch with the NOP.
7. Flush the instruction cache with `__builtin___clear_cache`.
8. Restore the page to read/execute protection.

If any validation fails, leave the library untouched. Do not scan broadly for a partial signature and patch the first approximate match.

## Current implementation locations

- Native patch: `mobile/modules/acs-meeting/android/src/main/cpp/acs_encoder_override.cpp`
- Native build: `mobile/modules/acs-meeting/android/src/main/cpp/CMakeLists.txt`
- Android capability gate and initialization: `mobile/modules/acs-meeting/android/src/main/java/com/mentra/acsmeeting/AcsEncoderOverride.kt`
- Call initialization: `mobile/modules/acs-meeting/android/src/main/java/com/mentra/acsmeeting/AcsMeetingSession.kt`
- CMake integration and ACS dependency: `mobile/modules/acs-meeting/android/build.gradle`

There is no ADB/system-property switch in the intended implementation. The property used during the configuration matrix was only temporary test instrumentation and has been removed.

## Cross-device safety

The patch changes ACS's selection logic, not the vendor MediaCodec implementation. It could therefore fail on a phone that advertises hardware AVC but cannot satisfy the exact format ACS requests. Because the patched factory always takes the hardware branch, ACS may not fall back cleanly to software on such a device.

Recommended rollout:

1. Keep the exact ACS version, ABI, offset, and instruction-signature gates.
2. Add a known-good device/codec allowlist initially.
3. Test at least the Razr Plus 2024, Samsung S26 Ultra, Samsung A54, and any proposed minimum-spec device.
4. Verify actual MediaCodec component selection, outgoing Teams video, thermals, and a call of meaningful duration.
5. Add a remotely controlled kill switch before broad release.
6. Expand the allowlist only after each hardware/OS combination passes.
7. Revalidate and update the patch whenever the ACS SDK changes; a signature mismatch must safely disable it.

A future implementation could run a short hardware encoder compatibility test before initializing ACS, but that test must use the same size, frame rate, and input format ACS will request to be meaningful.

## How to validate a device

Use a normal second Teams participant on another device. Do not have the test phone join the same meeting a second time to receive and render its own video; that adds a decoder, renderer, and second ACS call and makes CPU results misleading.

Useful evidence in `adb logcat` includes:

```text
ACS-HW-OVERRIDE: selected ACS H264 hardware factory ...
OMX.qcom.video.encoder.avc
Component Allocated (c2.qti.avc.encoder)
```

Then confirm that the same component continuously enqueues input and dequeues encoded output while the remote Teams participant receives video. Ignore ACS's `codec=h264 sw` label if the Android component logs prove sustained hardware use.

For each device, record:

- Manufacturer, model, SoC, and Android version
- MediaCodec component name
- Requested and received resolution/FPS/bitrate
- Process CPU with preview off and on
- Thermal behavior over at least 10-15 minutes
- Whether start/stop audio remains normal
- Whether video recovers after backgrounding, network changes, and a second call

## What not to include in the production version

- The temporary ADB property/configuration selector
- The experimental ECS flag matrix
- MediaCodec name-substitution hooks
- Vendor capability-field sanitization hooks
- A hidden second ACS participant or renderer
- A patch that accepts an unknown ACS binary or approximate signature

The minimal solution is the automatic capability gate, the exact version-specific factory patch, safe fallback to untouched ACS behavior when the gates fail, and normal single-participant Mentra Call operation.

## Maintenance note

This relies on an internal ACS implementation detail and may break whenever Microsoft updates the native media engine. Treat it as version-pinned native compatibility code, not a stable ACS API. The team should retain the Microsoft authorization for this work and review distribution requirements before shipping it broadly.
