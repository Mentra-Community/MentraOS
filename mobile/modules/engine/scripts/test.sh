#!/usr/bin/env bash
# Run each test file in its own bun process.
#
# bun's mock.module patches one process-wide module registry with live ESM
# bindings, last write wins. Several suites mock the same specifiers (e.g.
# "@mentra/bluetooth-sdk/internal" is mocked by audioTestMocks.ts,
# PhonePhotoCoordinator.test.ts, MicStateCoordinator.test.ts, ...), so a
# single `bun test src` lets one file's mock clobber another's and suites
# that pass alone fail in the combined run. Per-file processes give every
# suite an isolated registry.
set -u
cd "$(dirname "$0")/.."

# React-hook suites need this module and react-test-renderer to load ONE React.
# mobile/modules/engine is a workspace member of both mobile/ and sdk/, so a local
# `bun install` in sdk/ symlinks ./node_modules/react to the sdk copy while
# react-test-renderer keeps resolving mobile/node_modules/react. Two instances make
# every hook call throw "Invalid hook call". CI installs only mobile/, so there is a
# single copy there and these suites must run — hence detect the split rather than
# skipping unconditionally. Delete this once engine stops being a member of both
# workspaces, or once both resolve the same react version.
react_from_engine="$(bun -e 'console.log(require.resolve("react"))' 2>/dev/null || true)"
react_from_rtr=""
rtr_entry="$(bun -e 'console.log(require.resolve("react-test-renderer"))' 2>/dev/null || true)"
if [ -n "$rtr_entry" ]; then
  react_from_rtr="$(cd "$(dirname "$rtr_entry")" && bun -e 'console.log(require.resolve("react"))' 2>/dev/null || true)"
fi

skip_react_suites=0
if [ -n "$react_from_engine" ] && [ -n "$react_from_rtr" ] && [ "$react_from_engine" != "$react_from_rtr" ]; then
  skip_react_suites=1
  echo "WARNING: duplicate React detected — skipping react-test-renderer suites."
  echo "  engine resolves:             $react_from_engine"
  echo "  react-test-renderer resolves: $react_from_rtr"
  echo "  These suites still run in CI, which installs only mobile/."
  echo
fi

fail=0
failed_files=()
skipped_files=()
while IFS= read -r f; do
  if [ "$skip_react_suites" -eq 1 ] && grep -q 'react-test-renderer' "$f"; then
    skipped_files+=("$f")
    continue
  fi
  bun test "$f" || {
    fail=1
    failed_files+=("$f")
  }
done < <(find src \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

echo
if [ "${#skipped_files[@]}" -ne 0 ]; then
  echo "Skipped (duplicate React locally, enforced in CI):"
  printf '  %s\n' "${skipped_files[@]}"
fi
if [ "$fail" -ne 0 ]; then
  echo "Failing test files:"
  printf '  %s\n' "${failed_files[@]}"
else
  echo "All test files passed."
fi
exit $fail
