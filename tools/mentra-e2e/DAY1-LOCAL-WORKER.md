# Registered local day-one worker

`day1-local.ts` connects the existing CI intake and lifecycle to the actual local
Mac, BES, January MTK, customer OTA, selected MTK and product OTA restoration, recording and result
export adapters. It creates no scheduler, second lease, backend queue or new
firmware retry mechanism. It does not publish results or install the CI app.

This entry is an explicit registration for an approved lab fixture. The default
`ci-worker.ts` command still has no hardware registration. A first registered run
may itself be the full routine qualification: its admission packet must say
`fullRoutinePassed: false`, and it must contain reviewed evidence for safe lab
admission. Admission is not a successful test result.

## Entry points

Run from the reviewed repository checkout, with an already prepared CI selection
from `ci-selection.ts` and a private, SHA-pinned host configuration:

```sh
bun tools/mentra-e2e/day1-local.ts describe --config /absolute/private/config.json --sha256 SHA256
bun tools/mentra-e2e/day1-local.ts check --config /absolute/private/config.json --sha256 SHA256
bun tools/mentra-e2e/day1-local.ts consume --config /absolute/private/config.json --sha256 SHA256
```

`describe` reads only local files. It validates the selected artifact/profile and
reports the definition and selected return-profile digests needed to write the
admission packet. It does not read or approve that packet, enroll a fixture,
acquire a lease or touch hardware. Its admission reference may point to the packet
that will be created next; update the outer config pin after creating the packet.

`check` additionally checks the private admission packet and the enrolled
fixture's original terminal lifecycle journal. It remains a file-only check;
hardware readiness is rechecked under the lease during `consume`.

`consume` authenticates the actual request run and current repository/head/base
through `inspectRoutineRequest`, then calls `consumeRoutineRequest` with this
local registration. The existing durable claim prevents resending a request after
a crash. A duplicate or interrupted request is not a retry command. Successful
terminal intake exports the actual finalized lifecycle and recording into
`<stateDirectory>/runs/<requestId>/admin-export`; publication remains a separate
explicit use of `publish-test-run.ts`.

## Private configuration

Store configs, identity, approvals and evidence outside Git, with mode `0600`.
Each reference is `{path, sha256, size?}` with a normalized absolute path. Keep
tool binaries and adapter source pins in their existing canonical config formats.
`LocalConfig` and `RuntimeInputs` in `runner/day1-local-runtime.ts` are the
authoritative typed shapes.

The outer `LocalConfig` has:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `repositoryRoot` | This reviewed checkout; another checkout is rejected |
| `stateDirectory` | Existing durable CI worker state |
| `fixtureDirectory`, `fixtureID` | The already enrolled fixture and its identity |
| `request` | Exact saved ready CI request JSON |
| `trust` | Existing CI worker trust configuration with explicit source allowlist |
| `selection` | Prepared `day1-ci-selection` JSON, including verified Mac receipt/archive, legacy route and target assets |
| `runtimeInputs` | The frozen local adapter inputs below |
| `admission` | Reviewed safe-admission packet for these exact inputs |

The Python executable used by the firmware adapters must be a regular file;
the default symlink in a virtual environment is rejected by the file-pin checks.
The tested macOS environment uses Python 3.14 and these pinned dependencies:

```sh
python3.14 -m venv --copies "$HOME/.cache/mentra-e2e/runtimes/day1-python314-bleak302"
"$HOME/.cache/mentra-e2e/runtimes/day1-python314-bleak302/bin/python" -m pip install \
  bleak==3.0.2 pyobjc-core==12.2.2 pyobjc-framework-Cocoa==12.2.2 \
  pyobjc-framework-CoreBluetooth==12.2.2 pyobjc-framework-libdispatch==12.2.2
"$HOME/.cache/mentra-e2e/runtimes/day1-python314-bleak302/bin/python" -m pip check
```

Record the resulting interpreter hash and installed package versions in the
private host setup evidence, then use that interpreter in the January and restore
inputs. Provisioning this runtime does not connect to glasses or qualify a run.

`RuntimeInputs` contains the common `leasePath` (ending in
`com.mentra.mentra.lock`), full fixture serial/CID/Bluetooth MAC and explicit USB
return selector, BES config, deferred January config template, selected Mac app
launcher/driver/wrapper pins, selected normal MTK restore helper/probe pins and
runtime config, and `wifi` inputs. `restoreRuntime.sourceProfiles` must contain
the independently verified current modern source profile as well as allowing the
selected target. The current ASG may differ from the selected CI ASG; do not
rewrite current source evidence to the new target version.

`sourceProbeRemote` names the previously enrolled, SHA-owned read-only status
probe. The first source observation uses that existing probe. An explicit setup
step then stages the identical pinned JAR at the global SHA path used by the
January adapter. The January observer restages that path after POWERWASH. All
later customer/restore/return observations use that global path. Unknown bytes or
an ambiguous push are never overwritten or retried.

The Wi-Fi adapter receives pinned ADB, exact USB/full device identity, expected
private IPv4 endpoint at port 5555, and permitted modern firmware/ASG/APK-hash
tuples. It uses the normal ASG `set_wifi_adb_state` command, saves the observed
original port setting, and connects only the freshly identified exact endpoint.
Its setup and restoration both require independent all-writer idle proof and a
closing identity/ASG-process check. It does not guess addresses or restart adbd.

The BES source-proof log, boot, PID and device epoch are an immutable source
anchor captured during owned preparation. No live proof is captured by
registration verification before the lease. Under the lease, the normal source
collector refreshes version/status immediately before BES reconciliation; the
BES adapter still enforces its original 60-second freshness gate at dispatch.
A changed source boot needs new reviewed preparation, not a widened age limit.

The admission packet has these required values:

```json
{
  "schemaVersion": 1,
  "kind": "authorized-lab-qualification",
  "routineId": "day1-ota",
  "fullRoutinePassed": false,
  "definitionDigest": "SHA256_FROM_DESCRIBE",
  "requestSha256": "SHA256_OF_CANONICAL_PARSED_REQUEST",
  "fixtureID": "ENROLLED_FIXTURE_ID",
  "enrolledSourceProfileDigest": "ACTUAL_ENROLLED_SOURCE_PROFILE_DIGEST",
  "returnProfileDigest": "SELECTED_RETURN_PROFILE_DIGEST",
  "harnessRevision": "REVIEWED_LOCAL_GIT_COMMIT",
  "unsupportedLegacyState": "quarantine-no-restoration",
  "restoreScope": "selected-mtk-and-gated-product-ota",
  "evidence": [
    {"kind": "source-validation", "path": "/absolute/private/validation.json", "sha256": "SHA256"},
    {"kind": "firmware-artifacts", "path": "/absolute/private/artifacts.json", "sha256": "SHA256"},
    {"kind": "native-components", "path": "/absolute/private/components.json", "sha256": "SHA256"},
    {"kind": "selected-full-ota", "path": "/absolute/private/full-ota-verification.json", "sha256": "SHA256"}
  ]
}
```

These evidence files must actually exist and match their digests. The enrolled
source digest is checked against the frozen allowed profiles and the original
ready fixture journal. The selected return digest is separate. New source code,
inputs or target artifacts require a new reviewed definition and packet.

## Bind the actual full-OTA proof

Before assigning `restoreRuntime.artifactVerification`, use the proof binder to
check the retained native verification packet against the exact selected OTA
manifest. Its private schema-1 config is:

```json
{
  "schemaVersion": 1,
  "proof": {"path": "/absolute/private/native-proof.json", "sha256": "SHA256"},
  "manifest": {"path": "/absolute/private/ota.json", "url": "https://SELECTED_MANIFEST", "sha256": "SHA256", "size": 1234},
  "output": "/absolute/private/fresh-bound-proof.json"
}
```

```sh
bun tools/mentra-e2e/bind-full-ota-proof.ts --config /absolute/private/bind.json --sha256 CONFIG_SHA256
```

The binder rechecks the actual retained native command/log/target evidence and
writes a fresh exclusive `0600` result. It does not independently authenticate AWS
or qualify hardware; an operator must pin the original proof after authenticating
the build. The runtime requires that bound result's full-payload, signature,
partition, byte-count, OTA hash and selected manifest fields agree before writes.

## Execution and current limits

The sequence is: fresh source/app checks; owned diagnostic probe and Wi-Fi
preparation; exact app stop; compact January BES; deferred full-January MTK
configuration derived from the persisted BES continuity proof; full January
activation/recovery; exact app launch; actual customer recording and OTA; closing
customer target/idle proof; cleanup barrier; recorder park and app stop; selected
normal full MTK restoration if needed; exact app launch and recorder
reattachment; a separate owned product OTA step for eligible ASG/BES restoration;
Wi-Fi setting restoration; independent combined return verification;
finalized recording verification and CI result export.

Setup is preserved in lifecycle and command journals. Window recording starts
only after the selected app is launched for the customer flow. Pauses during an
owned app stop are recorded by the existing park/reattach API; no frames or
timestamps are invented for the absent window.

The normal full MTK restore is followed by a separate once-only product OTA
operation for eligible ASG/BES restoration. It uses a fresh modern USB identity,
independent all-writer idle proof, the exact selected manifest and the existing
Mentra App update flow. Its `RESTORE-OTA-*` chapters and `hardware-restore`
evidence are separate from the original customer attempt. The selected manifest
is rechecked before each new Update Now action. It does not retry the original
customer operation, downgrade newer BES/ASG, or introduce a raw component installer.

Known setup-baseline MTK/BES versions are explicitly bound to the qualified January
profile and compact BES artifact. Observing such a source never changes target
assertions into passes. An unobservable legacy writer, missing MAC on a new boot,
unsettled updater, unsupported source, newer-than-target component, incomplete
evidence or failed final app/firmware assertion keeps the fixture unavailable.
A failed customer test remains failed even if separate cleanup reaches the selected
target. Full recovery and unattended qualification still require a real complete
run; source-only tests do not supply that evidence.

No real request or hardware was consumed by the source-only tests. The tests
exercise synthetic terminal enrollment and admission rejection, actual lifecycle
journal formats, and fake transport no-resend/identity behavior.
