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

fail=0
failed_files=()
while IFS= read -r f; do
  bun test "$f" || {
    fail=1
    failed_files+=("$f")
  }
done < <(find src \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

echo
if [ "$fail" -ne 0 ]; then
  echo "Failing test files:"
  printf '  %s\n' "${failed_files[@]}"
else
  echo "All test files passed."
fi
exit $fail
