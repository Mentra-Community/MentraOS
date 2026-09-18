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
MENTRA_IOS_COMPILE_CHECK_SETTINGS=()
if [ "${MENTRA_IOS_PR_COMPILE_MODE:-false}" = "true" ]; then
  MENTRA_IOS_COMPILE_CHECK_SETTINGS+=(
    COMPILER_INDEX_STORE_ENABLE=NO
    DEBUG_INFORMATION_FORMAT=dwarf
    GCC_GENERATE_DEBUGGING_SYMBOLS=NO
  )
  echo "PR compile mode: applying ${#MENTRA_IOS_COMPILE_CHECK_SETTINGS[@]} compile-check build settings: ${MENTRA_IOS_COMPILE_CHECK_SETTINGS[*]}"
else
  echo "Full build mode (non-PR): no compile-check build settings applied."
fi
