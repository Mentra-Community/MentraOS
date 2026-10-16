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
(`compiled-capture-wiring-v2`). The first actual diagnostic build must exercise this
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
