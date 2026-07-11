# avif-coder-mono

Mentra fork of [awxkee/avif-coder](https://github.com/awxkee/avif-coder) at tag
`1.7.3`, consumed by `asg_client` as `app/libs/avif-coder-mono-1.7.3-mono1.aar`.

## What the fork adds

Upstream `HeifCoder.encodeAvif()` only accepts an Android `Bitmap` and always
encodes chroma 4:2:0. The BLE photo path on the glasses produces grayscale
images for on-phone text recognition, where a Bitmap round-trip wastes ~5MB of
RAM per photo (1 byte/pixel luma forced into a 4 byte/pixel RGBA container)
and the encoder wastes time on empty chroma planes.

The fork is additive only (no upstream code modified):

- `JniMonoEncoder.cpp` - new JNI entry point `encodeAvifMonoImpl` that
  consumes a raw 8-bit luma buffer and emits a true monochrome (YUV400) AVIF
  via libheif's `heif_colorspace_monochrome`. Also exposes the AOM `speed`
  (cpu-used, 0..9) parameter, which upstream never sets - on the MTK8766 the
  default is the dominant cost of the 4-5.5s software AV1 encode.
- `HeifCoder.kt` - new public `encodeAvifMono(luma, width, height, stride,
  quality, speed)` method.
- ABIs trimmed to `armeabi-v7a` + `arm64-v8a` (all Mentra Live ships).

Package/class names are unchanged (`com.radzivon.bartoshyk.avif.coder`), so
the AAR is a drop-in replacement for the upstream JitPack artifact, including
for the existing `encodeAvif`/`decode` call sites.

Monochrome support was validated against the exact bundled library versions
(libheif 1.17.6 + AOM 3.8.1): encode succeeds, output decodes back as
colorspace=monochrome with no chroma planes, and any spec-compliant AVIF
decoder (libavif/dav1d on Android, ImageIO on iOS 16+) reads it - YUV400 is
first-class in the AV1 bitstream spec, not an extension.

## Rebuilding the AAR

```bash
git clone --branch 1.7.3 https://github.com/awxkee/avif-coder.git
cd avif-coder
git apply /path/to/avif-coder-1.7.3-mono.patch
echo "sdk.dir=$ANDROID_HOME" > local.properties   # needs NDK 26.1.10909125 + CMake 3.22.1
JAVA_HOME=/path/to/jdk17 ./gradlew :avif-coder:assembleRelease
cp avif-coder/build/outputs/aar/avif-coder-release.aar \
   ../asg_client/app/libs/avif-coder-mono-1.7.3-mono1.aar
```

The repo commits prebuilt static libs (libheif/libaom/etc.) per ABI under
`avif-coder/src/main/cpp/lib/`, so only the JNI wrapper C++ is compiled - no
third-party native rebuilds are required.

Longer term this should move to a proper `Mentra-Community/avif-coder` fork
published via JitPack; the patch file in this directory is the full diff to
apply on top of upstream `1.7.3`.
