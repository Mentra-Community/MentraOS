#!/bin/bash
set -euo pipefail
installer_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
installer_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mentra-installer-tests.XXXXXX")"
trap 'rm -rf -- "$installer_test_dir"' EXIT
xcrun swiftc -parse-as-library "$installer_dir/InstallerCore.swift" "$installer_dir/InstallerCoreTests.swift" -o "$installer_test_dir/tests"
"$installer_test_dir/tests"
xcrun swiftc -parse-as-library "$installer_dir/InstallerCore.swift" "$installer_dir/Distribution.swift" "$installer_dir/DistributionTests.swift" -o "$installer_test_dir/distribution-tests"
"$installer_test_dir/distribution-tests"
# Compile the shipping entrypoint too; the unit executable never opens an app,
# installs a build, modifies permissions or requires signing credentials.
xcrun swiftc -parse-as-library -target arm64-apple-macos14.0 "$installer_dir/InstallerCore.swift" "$installer_dir/Distribution.swift" "$installer_dir/Installer.swift" -o "$installer_test_dir/Installer"
# The monorepo's installer (mac_installer.py defines MENTRA_MONOREPO there).
xcrun swiftc -parse-as-library -D MENTRA_MONOREPO "$installer_dir/InstallerCore.swift" "$installer_dir/Distribution.swift" "$installer_dir/DistributionTests.swift" -o "$installer_test_dir/distribution-tests-monorepo"
"$installer_test_dir/distribution-tests-monorepo"
