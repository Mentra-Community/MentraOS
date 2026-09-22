# Cache-only day-one CI selection

`runner/ci-selection.ts` prepares the inputs for a trusted local routine registration. Call it only after `ci-request` authenticates the request against GitHub observations and the worker's private trust policy. It neither consumes that request nor acquires a fixture lease, downloads files, installs an app, or accesses devices.

The worker CLI performs that authentication before invoking the resolver:

```sh
bun tools/mentra-e2e/ci-worker.ts prepare --run REQUEST_RUN_ID --attempt 1 \
  --trust /private/worker/trust.json \
  --cache-index /private/cache/index.json --cache-index-sha256 INDEX_SHA256 \
  --output /private/preparations/request-unique-generation \
  --python /absolute/trusted/python3
```

Use the actual request workflow run/attempt, reviewed trust entries and cache-index
digest. This command creates no request claim and cannot report a device pass.
Request authentication also rejects an obsolete PR head or base.

```ts
const prepared = await resolveDay1CiSelection(authenticatedRequest, {
  cacheIndex: {path: "/private/cache/index.json", sha256: "…", size: 1234},
  outputDirectory: "/private/preparations/request-unique-generation",
  python: "/trusted/host/python3",
})
```

The operator-owned, hash-pinned cache index is data only:

```json
{
  "schemaVersion": 1,
  "receipt": "/private/cache/published-ios-receipt.json",
  "archive": "/private/cache/exact-mac-artifact.zip",
  "otaManifest": "/private/cache/published-ota-manifest.json",
  "returnArtifacts": {
    "asg": "/private/cache/selected-asg.apk",
    "bes": "/private/cache/selected-bes-ota.bin",
    "mtk": "/private/cache/selected-mtk-full.zip"
  },
  "legacyRoute": {"path": "/private/cache/reviewed-legacy-route.json", "sha256": "…", "size": 1234}
}
```

CI supplies only the existing authenticated URLs, hashes, sizes and build coordinates. It cannot choose any host command, module, installer or local path. Populate the cache using the existing artifact importer/operator cache workflow. A missing or changed cache entry fails preparation; the resolver does not fetch a replacement or select a newer release.

The resolver reuses:

- `.github/scripts/pr-ios-artifacts.mjs` for canonical schema2 publication metadata, including notarized installer metadata and distinct build/publication attempts.
- `mac_ci.extract_package` and `mac_ci.verify_package` through the fixed `verify-ci-selection-mac.py` bridge. This extracts the already-hashed archive into the new preparation directory and checks packaged `build.json`, executable/JavaScript, effective packaged OTA pin and Apple signatures. Downloaded installer/helper code is never executed. Allow up to 2 GiB for the bounded extraction in addition to the recording reserve.
- `verifyBuildManifest` for exact CI manifest shape and compilation provenance. The selected PR head, build merge and `mobileSourceCommit` stay distinct; cached verification does not assert the app is installed or running.
- `parseFirmwareProfile` for the selected return ASG, BES and full MTK image. Each corresponding cached file is rehashed, including after package verification.
- `loadLegacyRoute` for the already-reviewed build-bound legacy policy, rescue manifests, artifacts and embedded system APK evidence. The resolver does not invent or relabel policy evidence for a new candidate. Mutable rescue feeds must still be checked by the existing routine immediately before dispatch and final acceptance.

The returned `reference` pins `selection.json`. Its `selection` contains the frozen `build.json`, OTA manifest, return profile, large artifact references, reviewed legacy route, allowed intermediate versions and evidence references. Small metadata is copied with exclusive creation and mode 0600; large source artifacts remain hash-pinned cache references. A failure after extraction begins leaves `failure.json` and its evidence. An existing output directory is never replaced.

Registration must still verify its local definition/qualification, enrolled fixture, runtime app policy and return-state capability. This resolver explicitly leaves `installed`, `hardwareStarted`, `runtimePolicyObserved` and `firmwareSignatureQualificationIncluded` false. It proves cached artifact integrity and Mac signing; firmware-specific signature/layout checks belong to the existing firmware adapters. Unresolved legacy OTA writers remain an unsupported restoration boundary, regardless of cache completeness.

Tests use generated local bytes and a trusted fake Mac verifier; they do not represent a signed production package or hardware qualification. The existing Python importer tests cover archive extraction, bundle/hash/pin checks and the exact signature verification commands.
