# NIMO commissioning APK

Publishing order: first land the reviewed workflow/scripts support on `dev`.
Then retain the reviewed native/variant candidate as an open same-repository PR targeting
`dev` or `staging`. Dispatch the trusted workflow at `dev` with that candidate's exact
PR/head/base and `nimo_diagnostic: true`. The existing trusted-dev guard deliberately
rejects PR-branch dispatch; the existing selector rejects closed or stacked-base PRs.
The workflow support alone does not add a diagnostic native/app variant to `dev`.

The `nimo_diagnostic` input of the existing Android workflow is explicit, dispatch-only,
and requires the existing pinned PR/head/base inputs. It is not a normal PR build,
release, inventory offer, or hardware qualification. Do not dispatch until the exact
source revision and its native receiver have been reviewed.

The `nimoDiagnostic` app variant inherits release signing/bundling, permits Android
`run-as`, and disables React Native developer support. Only this variant selects the
SDK's debug DUMP-protected receiver. Ordinary release retains the no-op receiver class.
CI invokes Android SDK `apkanalyzer dex code --class` on the signed APK and verifies
the diagnostic class, DUMP-protected registration/start method, instantiated receiver
subclass/onReceive dispatch, and DeviceManager startup call. Its package revision and
launcher/library content digest are recorded in hash-bound `diagnosticVerification`
(`compiled-capture-wiring-v3`). The first actual diagnostic build must exercise this
tool before admission; source mocks alone do not qualify an APK. Discovery is bounded
to executable, revisioned packages under the canonical SDK cmdline-tools directory;
a latest alias is resolved before hashing, and PATH/outside-SDK tools are refused. CI also verifies an immutable diagnostic asset,
nonempty bundled JavaScript, Android's debuggable manifest flag and release signature.
Diagnostic minification is disabled so bytecode names remain inspectable. Diagnostic
concurrency has a separate suffix and cannot cancel ordinary coverage for the same PR.
Diagnostic compilation cannot reuse a release APK and does not publish a mutable
ordinary APK alias.

Publication coordinates are
`mentra-android-nimo-diagnostic-pr-<PR>-<head>-<run>-<attempt>.{apk,json}`.
The receipt and verified `app` carry `diagnostic: "nimo-resource-v1"`; all SHA256,
size, signed APK, PR merge, source fingerprint and run-attempt pins remain authoritative.
An asset or a caller-supplied marker alone is insufficient proof.

Only authenticated routine authoring intake accepts the explicit request field
`diagnostic: "nimo-resource-v1"`, with Android and exactly the `nimo` glasses model.
It resolves the separate immutable publication and freezes its diagnostic selection.
Ordinary build selection rejects diagnostic receipts before parsers discard unknown
fields. The harness additionally requires the original authoring grant for the exact
installed NIMO resource; ordinary execution refuses diagnostic selections. This adds
no resource offer, fixture, authority, reservation or permission bypass.

The native adapter's `assertDiagnosticArtifact(originalApp)` callback may succeed only
after the verified diagnostic receipt and APK inspections above, matching the original
installed APK SHA256, build and process identity. It must not infer capability from
an API version, filename, source PR or caller boolean.

Native APK compilation and hardware qualification have not been performed as part of
this source change. The first accepted diagnostic build must demonstrate bundled
startup without Metro and the fixed receiver/private receipt path under owned custody.

The capture-qualified receipt additionally fixes `captureProtocol` to
`nimo-preconnect-capture-v1`. The SDK analyzer must find the arm/status/cancel
commands, immutable capture snapshot protocol, main-thread exception relay, and
consumed admission guards at the SDK connect/default/scan and NIMO peer/transport
entry points. Old receiver-only APKs cannot qualify. Actual SDK disassembly
compatibility remains a required first-build gate; source fixtures do not qualify
an APK or demonstrate hardware behavior.

Publication also requires `captureRequiredBeforeArm: true`. Compiled policy checks
trace the diagnostic build literal into the policy comparison/default bridge,
require its consumed return values, and check the SDK/peer admission policy
wiring. Core and harness reject missing/false startup denial evidence before
installation. This is scoped bytecode evidence plus reviewed native source;
it is not a general control-flow proof.

The application transform supports Expo 55's `ExpoReactHostFactory` template by
passing its supported `useDevSupport` argument. Ordinary variants retain the
factory's React Native `ReactBuildConfig.DEBUG` default; `nimoDiagnostic` sets
it false. A fixture from the pinned `expo@55.0.24` package guards this template
and existing custom developer-support arguments fail closed. The legacy
ReactNativeHost template remains supported. The ESM helper has explicit TypeScript
declarations so the mobile plugin is checked by the ordinary compile gate.

The unreleased capture proof also requires `scanInstancePreserved: true`. The
actual SDK connect/default and manager named-connect methods must each invoke
`preserveCapturedScan(String, String): Boolean` and consume its returned register
in the connection branch. Missing any one guard rejects publication; Core and
the harness reject earlier/missing/false scan-preservation receipts. The method
ABI and Kotlin object static receiver initialization were checked with the
Kotlin compiler and `javap`; actual APK analyzer execution is still required.


The v3 proof requires `clockProtocol: "nimo-monotonic-receipt-v1"`. Native receipt
`clock` values use `android-elapsed-realtime-v1` (`SystemClock.elapsedRealtime`,
including suspend). Each request retains its original received timestamp before
any effects; live snapshots carry their observation time. The original captured
arm, same-instance admission, GATT generation start, and first accepted release
nonce/start remain immutable. Firmware, TWS, time command/ACK, microphone stop,
and Exit markers carry explicit nullable monotonic counterparts to the epoch
fields. Epoch timestamps are human diagnostics and must never be compared with
host time or used for event ordering. Later status reads preserve original release
anchors and cannot renew earlier timeout/release evidence.

The harness uses its original durable host operation admission for host freshness
and `checkedAt`; it compares native markers only to the original phone anchors.
Process UUID, PID, capture, instance and generation fences remain required.
Old v2/epoch-only artifacts are refused before native preparation, independently
of source declarations. Actual SDK disassembly is still a first-build gate.


The diagnostic variant mirrors React Native 0.83's supported `debugOptimized`
native mode: it remains Android-debuggable but passes
`-DCMAKE_BUILD_TYPE=Release` only to its CMake configuration. This aligns the
app's generated C++ headers with its release-fallback React Native prefab
libraries. Android debuggability alone otherwise selects CMake Debug, causing
undefined debug-only `Sealable`/`DebugStringConvertible` symbols against release
prefabs. Ordinary variants retain their existing CMake configuration. Existing
known generated diagnostic blocks are upgraded; conflicting CMake modes fail
closed. Actual diagnostic compilation and APK proof remain required gates.
