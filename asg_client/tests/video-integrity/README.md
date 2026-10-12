# Recorded video integrity device regression

Run from the repository root with an authorized, connected Mentra Live:

```sh
ADB_SERIAL=<adb-device-serial> ./asg_client/scripts/test-video-integrity.sh
```

Requires JDK 17, ADB, Android platform 34 and build-tools 35.0.0. Override
`ANDROID_HOME` (or `ANDROID_SDK_ROOT`), `ANDROID_JAR`, or `D8` for another local SDK
installation. The checker requires Android API 28 or later, matching ASG's minimum.

The script compiles the **production** `RecordedVideoIntegrityChecker` with this
test, converts it to DEX, and executes it via `app_process` on the device. It does
not install an APK or start ASG, the camera, networking, or firmware updates. It
uses a unique directory under `/data/local/tmp` and removes its files on exit.
This is an isolated Android media regression, not a full capture/upload test or
a registered automatic device routine.

The test checks missing/undersized files, an invalid container, audio-only MP4,
an MP4 with intact track tables but a truncated first video sample, and valid
small/large first samples. It independently decodes the large sample with the
device's AVC decoder before asserting that the production checker accepts it.
It exits nonzero on the first failed assertion.

To establish the failure on an older source revision using the same fixtures:

```sh
ASG_INTEGRITY_SOURCE_REF=4e485930e223459b6c6f4a4f30072be409611f3d \
  ADB_SERIAL=<adb-device-serial> ./asg_client/scripts/test-video-integrity.sh
```

On a Mentra Live running Android 11/API 30, staging at that revision passed the
first six cases and hardware decode, then rejected the valid large sample.
The fixed checker passed all seven cases. The large first sample is 543,521
bytes; the former 262,144-byte buffer caused `readSampleData` to throw
`IllegalArgumentException`. Reading it with a sufficiently sized buffer and
decoding with `OMX.MTK.VIDEO.DECODER.AVC` both succeeded.

`getSampleSize()` uses the extractor's sample-fetch path, so it still exercises
payload readability; it avoids the redundant Java copy and its arbitrary size
limit. The truncated-payload case specifically guards against accepting a video
based only on the presence of track metadata. This remains a lightweight first
sample check, not validation that every frame in the recording decodes.

## Synthetic fixtures

These are generated test patterns and tones, not user recordings. Generated with
FFmpeg 8.0.1 and libx264. They reproduce a frame-size condition; they do not claim
to reproduce the glasses camera encoder's rate control or an outdoor scene.

| Fixture | Contents | First video sample | SHA-256 |
| --- | --- | ---: | --- |
| `large-first-sample.mp4` | One 854×480 H.264 frame, 15 fps, noisy test pattern; fast-start MP4 | 543,521 B | `16349a5e568020613eef144e5437acbcdc0fecdeaa6739de8f500197db244790` |
| `small-first-sample.mp4` | One second of 854×480 black video at 15 fps and a 440 Hz AAC tone | 817 B | `0baffe43360b3fd9e70ad5fee4e6dc883cee712199489e14c1c3b214937eecdd` |
| `audio-only.mp4` | AAC track copied from the small-sample fixture | — | `7ecd690691ad6bb50709171058542f6cda3bb9e5c1cf7c2d45a74ea4016b4cdd` |

Generation commands (run in a disposable directory; encoder versions can change
the exact bytes):

```sh
ffmpeg -f lavfi -i 'testsrc2=size=854x480:rate=15' \
  -vf 'noise=alls=60:allf=t:all_seed=2024' -frames:v 15 \
  -c:v libx264 -preset medium -b:v 8M -pix_fmt yuv420p \
  -movflags +faststart detail.mp4
ffmpeg -i detail.mp4 -frames:v 1 -c:v copy first-frame.mp4
ffmpeg -i first-frame.mp4 -c copy -movflags +faststart large-first-sample.mp4
ffmpeg -f lavfi -i 'color=black:size=854x480:rate=15' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k \
  -movflags +faststart small-first-sample.mp4
ffmpeg -i small-first-sample.mp4 -vn -c:a copy -movflags +faststart audio-only.mp4
```

The 8 Mbps encoder argument is an average bitrate request, not a bound on a
single frame. The frozen fixture's actual size is the regression condition.
