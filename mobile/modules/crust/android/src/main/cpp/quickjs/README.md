# QuickJS JNI lifetime backport

The Kotlin API remains on `io.github.dokar3:quickjs-kt-android:1.0.0-alpha13` to
preserve compatibility with Kotlin 2.1.20. Crust builds this native source for
Android. A private build-input configuration extracts the original AAR's
`classes.jar`. Crust embeds this JAR, preserving Kotlin metadata, while only its
source-built JNI library reaches consuming apps. `quickjs-consumer-rules.pro` in
the Android module preserves the original AAR's R8 rules so JNI class names remain
valid in minified builds. Do not use `pickFirst` to choose between libraries.

Source provenance (licenses accompany each source):

- `jni/`, `common/`: quickjs-kt commit `d2fefdc451678d09bbef5526c3b00f12e41cd5cf`.
- `engine/`: Bellard QuickJS commit `36911f0d3ab1a4c190a4d5cbe7c2db225a455389`, alpha13's submodule pin; only required build inputs.
- `c-vector/`: alpha13 submodule pin `774773d4cb1e66dd736e90e7f482d4f22af464c6`.

Upstream source changes are confined to `jni/jni_globals.{c,h}` and
`jni/quickjs_jni.c`. They backport the shared-resource lifetime fix from
[4a003f6](https://github.com/dokar3/quickjs-kt/commit/4a003f64b1d5e608df1768e6c1a743b603434e10).
A mutex synchronizes VM initialization, instance counts and final cache disposal. Shared caches remain valid until the final instance closes.

Shared-resource lifetime is unconditional; there is no setting or native toggle.
A native Android rebuild is required. iOS does not use this JNI library.

Run the Linux integration test with
`python3 mobile/modules/crust/android/scripts/test-quickjs-lifecycle.py` from the
repository root. It requires JDK 17, CMake/Ninja and cached Gradle dependencies.
It compiles the real JNI library and exercises Kotlin callbacks across both
close orders, sequential/concurrent teardown and clean restart. Plain JavaScript
arithmetic is insufficient: this regression requires a callback into Kotlin.
