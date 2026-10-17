# Mac original NIMO session fixture

The fixture shares the existing Swift NIMO implementation and the existing Expo
Bluetooth SDK module. `nimoResourceSession` takes strict Codable request JSON and
returns fixed receipt JSON. The matching schema is `nimo-macos-resource-v1.json`.
It cannot send packets, choose paths, pair, unpair, reset, change radio state, or
connect a caller-selected peripheral. Product connection still uses the normal
SDK; the fixture only arms the capture and releases that original session.

Ordinary launches have no listener and retain ordinary behavior. Only a Mac
process explicitly launched with `MENTRA_NIMO_RESOURCE_BOOTSTRAP` enables this
boundary. Its immutable JSON configuration pins version1, ownerPid,
ownerBirth.seconds/microseconds, ownerAuditToken (64 lowercase hex opaque audit-token bytes), planSha256, grantSha256, bootstrapNonce,
appExecutableSha256 and appBundleId. The controller must independently verify
the selected signed bundle/source identity; an executable hash is not a claim
about an entire bundle's contents. This source change adds no build/publication
or activation workflow.

The listener path is fixed:
`<app container home>/tmp/nr-<bootstrapNonce without hyphens, first16>/s`.
The app exclusively creates a 0700 directory and 0600 socket. It checks directory
identity and Unix peer UID, PID and opaque kernel audit identity. The stable Bun executor opens
the socket itself; a transient CLI child is not the admitted owner. The client
must independently check the app peer PID/birth and selected executable/bundle
identity, then pin the returned directory device/inode before requests.

One newline-terminated envelope, limited to 16KiB, is accepted per connection:
`{bootstrapNonce,hello:true}` performs no Bluetooth effect and returns protocol,
process, processAuditToken, ownerPid, ownerBirth, ownerAuditToken, executableSha256, bundleIdentifier,
directory.device/inode and socketPath. An operation uses
`{bootstrapNonce,request:<typed request>}` and returns `{receipt:<typed receipt>}`
or a bounded `{error:<code>}`. No owner rebinding or transfer exists. Another
executor can read original immutable files only through separately verified
controller custody and old-writer cessation; it cannot acquire new native input
authority by copying an old plan or nonce.

The accepted plan must contain the real CoreBluetooth peripheral UUID. No MAC
address conversion, guessed UUID or connect-by-address discovery is supported.
If no observed/accepted UUID exists, preflight must remain blocked.

Arm requires an unowned app manager. Connection admission retains the exact
Nimo object; scan-to-connect preserves it, and first transport admission retains
the actual CBPeripheral object and UUID. No later object or generation is
adopted. The first status with original:null is read-only capture-bound discovery
of that already-admitted object, not adoption of the current manager. Generation0
has a null startedElapsedMs and the accepted plan UUID. Release requires the
original tuple. Cancel can omit it to drain the same pinned capture even when
setup failed before obtaining a positive-session readback.

Continuous native milliseconds order arm/admission/transport/TWS/actual time
write/ACK and original release markers. Host freshness is a separate clock
contract. Time retries are refused within a fixture capture; an ACK before actual
write start is ignored, and an early ACK cannot qualify before the actual write
callback. A later TWS report does not rewrite the handshake anchor.

Release fences new inputs and reconnects, invalidates encoded results while
retaining real queued/running/delivery counters, and awaits actual writer,
encoder, posted callback and reconnect settlement. A connected session sends the
existing mic stop command and requires the exact stop notification plus its real
write callback. Canvas Exit must have an accepted status0 business ACK after its
actual write completes when required. Native silence/pixel visibility is not
inferred. An ambiguous/incomplete command keeps settlement unknown.

The exact original CBPeripheral is retained after cancellation until its real
`didDisconnectPeripheral` callback. Nil references, a cancellation API return,
logical queue clearing, foreign callbacks and replacement managers cannot prove
closure. No-transport closure is possible only when this capture never admitted
a transport. Timeouts/errors remain explicit and cannot turn into successful
idle merely through a fresh status nonce.

Every accepted request intent is persisted before effects. Exact object admission and transport-generation admission are also published to fixed captureNonce.admission.json and captureNonce.transport.json before scanning or CoreBluetooth connect; failed persistence retains only the cancelled original and never commits successful admission anchors. Fixed UUID intent and
receipt filenames are atomically published with exclusive creation beneath the
original directory; changed bytes under the same nonce are refused. Exact
readbacks return the original receipt bytes. One process allows one capture,
192 ordinary request entries and 64 reserved cleanup/readback entries (256
total). Exact prior nonce readbacks bypass the budget. Repeated status cannot
renew capture/release anchors or reset this budget.

Tests cover original-object/peripheral/generation mismatch, pre-write/negative
ACKs, release nonce immutability, gen0 cancellation, missing/foreign/error closure,
actual encoder worker/delivery and writer callback settlement, and strict request
schema refusal. Full SwiftPM/XCTest execution and Mac artifact/source admission
are required before use; this source change is not hardware qualification.

The current manager tuple vetoes setup/adoption of a foreign or G2 manager. After
actual original NIMO closure and producer settlement, a later G2 manager does not
veto NIMO idle, and no fixture operation is routed to it. This is scoped original
session evidence, not a requirement to stop unrelated apps or controllers.

CoreBluetooth cancellation is asynchronous. Apple's documented closure callback
is [didDisconnectPeripheral](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/cancelperipheralconnection(_:)); merely cancelling a pending/active local connection is not the observed callback.

The existing iOS app compiles the transport. On iOS it is enabled only for `isiOSAppOnMac` plus explicit bootstrap; ordinary iPhone launches cannot enable it. Socket/journal paths stay inside the app-owned container, and overlong Unix paths fail closed.

Peer identity uses public Darwin LOCAL_PEERPID, getpeereid and LOCAL_PEERTOKEN. Full opaque 32-byte audit tokens are compared without interpreting their words or using iOS-unavailable BSM helpers. Bootstrap pins the controller owner's own TASK_AUDIT_TOKEN; the launcher validates actual parent PID/birth and selected executable. The app independently compares kernel peer token to the bootstrap pin. Hello exports its own TASK_AUDIT_TOKEN; the host compares socket peer token and independently verifies actual app PID birth/source. No app-side libproc lookup is required. Actual iOS compilation and signed artifact capability verification remain required; source validation is not hardware qualification.
