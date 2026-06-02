# Releasing the iOS Swift Package

This is the current manual process for publishing the public SwiftPM mirror at
`Mentra-Community/mentra-bluetooth-sdk-ios`.

The source of truth stays in this monorepo under `mobile/modules/bluetooth-sdk`.
The public SwiftPM repository is a generated release mirror, not a second source
tree.

## When to Run This

Run the export from the branch or commit that contains the complete SDK feature
set for the release. Do not run the export from a partial split PR branch unless
that branch intentionally contains every Swift source file expected in the
public package.

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

- Xcode with the iOS platform installed.
- Push permission to `Mentra-Community/mentra-bluetooth-sdk-ios`.

## Export and Verify

From the MentraOS repo root:

```bash
git status --short
source_sha=$(git rev-parse --short HEAD)
scripts/export-bluetooth-sdk-ios-spm.sh --target ../mentra-bluetooth-sdk-ios --verify
```

The script rewrites the target checkout except for `.git`. The `--verify` flag
runs SwiftPM package description and a generic iOS Xcode build in the exported
package.

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

If the release version changed, make sure the generated README examples point at
the version being tagged. Until the export script accepts a version argument,
update the version text in the export script before exporting, or update the
generated target README before committing.

## Commit and Tag

Use the same version format as existing SwiftPM tags, for example `0.1.8`
without a leading `v`.

```bash
version=0.1.8

git add Package.swift README.md LICENSE ios .gitignore
git commit -m "Release MentraBluetoothSDK ${version}" \
  -m "Exported from MentraOS ${source_sha}."
git tag "${version}"
git push origin main
git push origin "${version}"
```

If you started a new shell after exporting, rerun `git rev-parse --short HEAD`
in the MentraOS source checkout and paste that source commit hash manually in
the commit body.

## Final Checks

Confirm GitHub sees the tag:

```bash
git ls-remote --tags origin "${version}"
```

Then test package resolution from a consumer app or a scratch package before
announcing the release.
