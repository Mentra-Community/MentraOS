# Releasing the iOS Swift Package

The normal release path is the GitHub Actions workflow documented in
`RELEASING_CI.md`. It exports and tags the public SwiftPM mirror at
`Mentra-Community/mentra-bluetooth-sdk-ios` when
`mobile/modules/bluetooth-sdk/package.json` changes on `staging`.

This manual process remains useful for local verification, emergency recovery,
or inspecting the generated mirror before CI is enabled.

The source of truth stays in this monorepo under `mobile/modules/bluetooth-sdk`.
The public SwiftPM repository is a generated release mirror, not a second source
tree.

## When to Run This

Run the export from the branch or commit that contains the complete SDK feature
set for the release. Do not run the export from a partial split PR branch unless
that branch intentionally contains every Swift source file expected in the
public package. In CI, that branch is `dev` after the SDK package version bump
has merged.

The export copies `ios/Source` by default and excludes only known
MentraOS-internal or non-SPM-compatible paths. If the export verification fails
after a new Swift file is added, either feature-gate that code for SwiftPM or
add an explicit exclusion with a short explanation in the export script.

## Prerequisites

- A clean MentraOS checkout on the release source branch.
- A clean checkout of the public SwiftPM repository next to this repo:

  ```text
  ../mentra-bluetooth-sdk-ios
  ```

- macOS with Xcode, Swift 5.9 or newer, and the iOS platform installed.
- Push permission to `Mentra-Community/mentra-bluetooth-sdk-ios`.
- For CI, a `MENTRA_BLUETOOTH_SDK_IOS_PUSH_TOKEN` repository secret with write
  access to the SwiftPM mirror repository.

## Export and Verify

From the MentraOS repo root:

```bash
git status --short
source_sha=$(git rev-parse --short HEAD)
version=$(node -p "require('./mobile/modules/bluetooth-sdk/package.json').version")
scripts/export-bluetooth-sdk-ios-spm.sh --target ../mentra-bluetooth-sdk-ios --verify
```

The script rewrites the target checkout except for `.git`. The `--verify` flag
runs SwiftPM package description, a native macOS build, and a generic iOS Xcode
build in the exported package. It reads `mobile/modules/bluetooth-sdk/package.json` and inserts that
version into the generated README examples.

## Inspect the Target Diff

Before committing in the public package repo:

```bash
cd ../mentra-bluetooth-sdk-ios
git status --short
git diff --stat
git diff -- Package.swift README.md ios/Source ios/Packages
```

Expected changes should be limited to the exported package manifest, README,
license, Swift sources, privacy manifest, and CoreObjC headers/sources. Do not
commit build products, DerivedData, `.build`, `.swiftpm`, or local Xcode user
state.

If the release version changed, make sure `mobile/modules/bluetooth-sdk/package.json`
already contains the version being tagged before exporting.

## Commit and Tag

Use the same version format as existing SwiftPM tags, for example `0.1.20`
without a leading `v`.

```bash
git add Package.swift README.md LICENSE ios .gitignore
git commit -m "Release MentraBluetoothSDK ${version}" \
  -m "Exported from MentraOS ${source_sha}."
git tag "${version}"
git push origin main
git push origin "${version}"
```

If you started a new shell after exporting, rerun `git rev-parse --short HEAD`
and the package version command above in the MentraOS source checkout, then
paste that source commit hash manually in the commit body.

## Final Checks

Confirm GitHub sees the tag:

```bash
git ls-remote --tags origin "${version}"
```

Then test package resolution from a consumer app or a scratch package before
announcing the release.
