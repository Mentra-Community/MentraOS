---
status: active
owner: Philippe
---

# Restore deterministic iOS Hermes builds

The dev.1071 archive failed compiling Hermes against React Native 0.83.6:
`jsi/hermes-interfaces.h` was missing. This is separate from device crashes.

1. Verify the original Hermes source acquisition and pinned RN package inputs.
2. Reproduce the header incompatibility with those exact sources locally.
3. Correct only the demonstrated source-selection/build integration defect.
4. Test the correction and meaningful failure cases, then open one canonical
   Mentra/dev PR with independent review and required CI.

Keep signing and release deadlines unchanged. Do not rerun the failed release,
change runners, bump dependencies, or touch devices. Normal export/publication
and an actual successful signed archive remain separate validation steps.

Local proof: the original job selected latest Hermes `main`. Its current header
reproduces the missing include against installed RN 0.83.6; RN's shipped
`hermes-v0.14.1` header compiles. The original fetched commit and failed binary
probe responses were not logged. A two-line Bun dependency patch retains binary
preference and explicit overrides, falling back to RN's tag. Eight installed
selector checks, the Node test wrapper, and a frozen-lockfile install pass.

Next: canonical PR review/CI, normal Copybara export and signed archive. Existing
`open-close-miniapps-mac` steps MINI-02/MINI-05 provide post-install Hermes/miniapp
smoke coverage; a device routine cannot exercise CocoaPods source selection.
