# Sourced by the iOS compile-check workflow before each xcodebuild attempt.
#
# Fills MENTRA_IOS_COMPILE_CHECK_SETTINGS with the extra xcodebuild build
# settings that make a pull_request run a pure native compile check. They
# apply only when MENTRA_IOS_PR_COMPILE_MODE=true (pull_request events, or a
# workflow_dispatch with pr_compile_mode). Push builds and every release lane
# (release-ios.mjs, reusable-coordinated-mobile.yml) never see them, so
# Sentry dSYM uploads and the embedded JS bundle there are untouched.
#
# Why each setting is safe for a compile check that ships nothing:
#   COMPILER_INDEX_STORE_ENABLE=NO   the index store only feeds IDE features.
#   DEBUG_INFORMATION_FORMAT=dwarf   no separate dSYM bundle, so no dsymutil
#                                    pass per app/framework. dSYMs are
#                                    discarded today (no signing, Sentry
#                                    upload disabled).
#   GCC_GENERATE_DEBUGGING_SYMBOLS=NO no -g at all; nothing consumes the
#                                    debug info of an unsigned check build.
#
# It also exports SKIP_BUNDLING=1 in PR compile mode. Expo's
# react-native-xcode.sh then exits the "Bundle React Native code and images"
# phase early (logging "SKIP_BUNDLING enabled; skipping."), so Metro, hermesc
# and the asset copy are skipped on the Mac. The iOS Metro bundle is validated
# on Linux by the "Validate the iOS Metro bundle" step in
# .github/workflows/augmentos-manager-jest.yml instead.
#
# mobile/ci/pr-ios/build.mjs reads the settings from
# MENTRA_IOS_COMPILE_CHECK_SETTINGS_STR and applies them only to unsigned
# builds; signed PR archives (installed by testers) are never affected.
MENTRA_IOS_COMPILE_CHECK_SETTINGS=()
if [ "${MENTRA_IOS_PR_COMPILE_MODE:-false}" = "true" ]; then
  MENTRA_IOS_COMPILE_CHECK_SETTINGS+=(
    COMPILER_INDEX_STORE_ENABLE=NO
    DEBUG_INFORMATION_FORMAT=dwarf
    GCC_GENERATE_DEBUGGING_SYMBOLS=NO
  )
  export SKIP_BUNDLING=1
  echo "PR compile mode: SKIP_BUNDLING=1; applying ${#MENTRA_IOS_COMPILE_CHECK_SETTINGS[@]} compile-check build settings: ${MENTRA_IOS_COMPILE_CHECK_SETTINGS[*]}"
else
  unset SKIP_BUNDLING
  echo "Full build mode: JS bundle embedded; no compile-check build settings applied."
fi
MENTRA_IOS_COMPILE_CHECK_SETTINGS_STR="${MENTRA_IOS_COMPILE_CHECK_SETTINGS[*]}"
export MENTRA_IOS_COMPILE_CHECK_SETTINGS_STR

# ---------------------------------------------------------------------------
# PR-build experiments (apply to every pull_request build, signed or not;
# never to push/full builds). Each is a single flag set in the workflow's job
# env so a one-line commit turns it on or off; the timeline in the job
# summary is the evidence. Thresholds: scheduling flags ship at >=30 s
# repeatable saving, Swift compilation mode at >=60 s, both with no rise in
# first-attempt failures/retries and acceptable memory pressure.
# ---------------------------------------------------------------------------
MENTRA_IOS_PR_BUILD_SETTINGS=()
MENTRA_IOS_XCODEBUILD_EXTRA_ARGS=()
if [ "${MENTRA_IOS_PR_BUILD:-false}" = "true" ]; then
  if [ "${MENTRA_IOS_EXPERIMENT_PARALLEL:-0}" = "1" ]; then
    # Explicit job count and independent-target parallelism. xcodebuild
    # already defaults to both in the new build system; this makes the
    # intent visible and lets a paired run confirm there is nothing left.
    ncpu="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"
    MENTRA_IOS_XCODEBUILD_EXTRA_ARGS+=(-parallelizeTargets -jobs "$ncpu")
  fi
  if [ "${MENTRA_IOS_EXPERIMENT_EXPLICIT_MODULES:-0}" = "1" ]; then
    # Explicit Clang/Swift modules: scanning becomes visible work so module
    # builds are shared and scheduled up front. Judge on elapsed time, not on
    # ScanDependencies alone.
    MENTRA_IOS_PR_BUILD_SETTINGS+=(CLANG_ENABLE_EXPLICIT_MODULES=YES SWIFT_ENABLE_EXPLICIT_MODULES=YES)
  fi
  if [ "${MENTRA_IOS_EXPERIMENT_SWIFT_SINGLEFILE:-0}" = "1" ]; then
    # Per-file Swift compilation (batched) instead of one whole-module job
    # per target. Targets the ~3m50s critical-path SwiftCompile of
    # MentraBluetoothSDK seen in the task timeline. Keeps -O; only the
    # compilation unit changes. Push and release builds keep whole-module.
    MENTRA_IOS_PR_BUILD_SETTINGS+=(SWIFT_COMPILATION_MODE=singlefile)
  fi
  # Xcode 16 CompileC does not export CCACHE_BINARY, so RN's ccache-clang.sh
  # falls through to plain clang. Command-line CC/CXX point at wrappers that
  # bake the ccache path in (ios-ccache-wrappers.sh). Push/release untouched.
  if [ -n "${MENTRA_IOS_CCACHE_CC:-}" ] && [ -x "$MENTRA_IOS_CCACHE_CC" ] \
    && [ -n "${MENTRA_IOS_CCACHE_CXX:-}" ] && [ -x "$MENTRA_IOS_CCACHE_CXX" ]; then
    MENTRA_IOS_PR_BUILD_SETTINGS+=(
      "CC=$MENTRA_IOS_CCACHE_CC"
      "CXX=$MENTRA_IOS_CCACHE_CXX"
      "LD=$MENTRA_IOS_CCACHE_CC"
      "LDPLUSPLUS=$MENTRA_IOS_CCACHE_CXX"
    )
    # Keep Clang's module cache inside the workspace so CCACHE_BASEDIR can
    # rewrite it. The default /var/folders/... path is unique per runner
    # process and makes every CompileC a miss across actions-runner-1/2/3.
    if [ -n "${GITHUB_WORKSPACE:-}" ]; then
      MENTRA_IOS_PR_BUILD_SETTINGS+=(
        "MODULE_CACHE_DIR=$GITHUB_WORKSPACE/mobile/ios/build-device/ModuleCache"
      )
    fi
    echo "ccache wrappers on xcodebuild: CC=$MENTRA_IOS_CCACHE_CC CXX=$MENTRA_IOS_CCACHE_CXX"
  fi
  if [ "${#MENTRA_IOS_PR_BUILD_SETTINGS[@]}" -gt 0 ] || [ "${#MENTRA_IOS_XCODEBUILD_EXTRA_ARGS[@]}" -gt 0 ]; then
    echo "PR build experiments: args [${MENTRA_IOS_XCODEBUILD_EXTRA_ARGS[*]}] settings [${MENTRA_IOS_PR_BUILD_SETTINGS[*]}]"
  fi
fi
MENTRA_IOS_PR_BUILD_SETTINGS_STR="${MENTRA_IOS_PR_BUILD_SETTINGS[*]}"
MENTRA_IOS_XCODEBUILD_EXTRA_ARGS_STR="${MENTRA_IOS_XCODEBUILD_EXTRA_ARGS[*]}"
export MENTRA_IOS_PR_BUILD_SETTINGS_STR MENTRA_IOS_XCODEBUILD_EXTRA_ARGS_STR
