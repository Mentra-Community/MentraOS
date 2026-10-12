# 016 - Miniapp signing and development builds

**Status:** In progress.

## Model

A miniapp's identity is its package name. Publisher signing follows the Android
model: a package's installed signer decides which bundles may replace it, and a
development build of a package is that package, checked on the phone.

- Signing is opt-in per package. An unsigned package accepts any bundle.
- The first signed bundle a package accepts records its publisher key. From then
  on only bundles signed with the same key replace it; the signature envelope has
  no rotation chain, so the record is permanent until the package is removed.
- An unsigned bundle never replaces a signed install. The user uninstalls the
  package first, which clears its recorded key (Android's
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
- A signed bundle may replace an unsigned install; it records its key and pins
  the package from then on.

The rule needs no backend round trip. The phone enforces it for every install
source, and Core mints a miniapp token for whichever package the phone runs.

## Release signing

### Publisher keys

`@mentra/miniapp-cli` owns one Ed25519 publisher key per package. The private key
stays on the developer machine in the OS keychain, or in a mode-`0600` file under
`~/.mentra/cli-v2/signing-keys/` when the keychain refuses the write. Only a
successful keychain lookup that finds nothing means a package has no key; if the
keychain can't be read, every key command aborts without creating, importing or
replacing a key, so a second identity is never minted for a pinned package.

```txt
mentra-miniapp keys create com.example.myminiapp
mentra-miniapp keys show   com.example.myminiapp
mentra-miniapp keys export com.example.myminiapp ./publisher-key.json
mentra-miniapp keys import com.example.myminiapp ./publisher-key.json
```

CI signs without persisting a key through `--signing-key <path>`, or `--sign`
with `MENTRA_MINIAPP_SIGNING_KEY_FILE` or `MENTRA_MINIAPP_SIGNING_KEY_JSON`.
Losing the key prevents any later release from updating the package on phones
that recorded it.

### Bundle signature

`mentra-miniapp pack --sign` (and `release --sign`) embeds one
`META-INF/MENTRA.SIG` entry in the release ZIP:

```ts
interface MentraBundleSignatureV1 {
  schemaVersion: 1
  algorithm: "Ed25519"
  publicKeyJwk: {kty: "OKP"; crv: "Ed25519"; x: string}
  publisherKeyFingerprint: string // "sha256:" + hex SHA-256 of the raw public key
  payload: {
    packageName: string
    version: string
    manifestSha256: string
    contentSha256: string // canonical list of every other entry's path, size and SHA-256
  }
  signature: string // Ed25519 over the canonical JSON payload
}
```

The signature is self-contained: verifiers check it against the embedded public
key and then compare that key's fingerprint with the one they recorded for the
package. No key registry is involved.

`pack` and `release` are unsigned unless `--sign` or `--signing-key` is passed;
a key sitting in the keychain is not consent to pin a package.

### Store

The Mentra Miniapp Store accepts unsigned releases. For a signed upload it
verifies the envelope against the archive, records the fingerprint on the
package with its first signed release, and rejects a later signed release whose
fingerprint differs. Accepting unsigned uploads does not clear a recorded
fingerprint on the Store or on phones.

`mentra publish` to Core's built-in Store separately signs its upload metadata
with a developer key registered with Core. That authenticates the upload to Core
and is unrelated to the publisher signature phones check.

## Phone signer rule

`publisherIdentityPolicy.ts` in the engine holds the rule; `AppRegistry`, the one
installer for every source, applies it before extraction and again inside its
serialized install transaction immediately before any installed file changes. It
records the fingerprint in the same metadata transaction that activates the
version.

| Installed package | Candidate bundle | Result |
| --- | --- | --- |
| none, or unsigned | unsigned | installs |
| none, or unsigned | signed | installs and records the key |
| signed with key A | signed with key A | installs |
| signed with key A | signed with key B | refused: publisher signature mismatch |
| signed with key A | unsigned | refused: uninstall first |

Every install source follows the table: release QR and manual installs, bundled
ZIPs, deployment-managed and preinstall-registry releases, and development
snapshots. There is no first-party, QR or system-package bypass. Uninstalling the
last installed version of a package clears its recorded key.

The same installer also refuses a release lower than an installed one for every
source (an equal version reinstalls), and restores the previous installation if
anything fails before the install commits.

## Development builds

`mentra dev` (and `mentra-miniapp dev`) serves the project from the developer's
machine and prints a `miniapp://dev?url=...&name=...&package=...&dev=...&mdns=...`
QR. It needs no login and makes no backend call.

The phone runs the build under its manifest package name:

- Scanning the QR, entering the dev server URL, or relaunching from the offline
  screen registers a dev record for the package (listed in `dev_apps_index`,
  with `${package}_dev_*` routing keys). Home shows the package as a dev build
  until a release install or an uninstall replaces it.
- Live dev code is unsigned. The phone refuses it with "`<package>` is installed
  with a publisher signature. Uninstall it before running a development build."
  while the package has a recorded publisher key, and runs it over an unsigned
  install or when the package is not installed. The launcher never runs live dev
  code for a package with a recorded key.
- The phone keeps an offline copy of the last live build as a `dev-<ms>`
  snapshot. Snapshots are installs and follow the signer rule: an unsigned
  snapshot cannot replace a signed install, and a signed snapshot must match the
  recorded key (or records its key when there is none). A snapshot download
  started before a release install commits cannot activate afterwards.

## Miniapp tokens

`session.auth` asks the phone for a token; the phone requests one from Core's
`POST /api/client/auth/miniapp-token` with the user's access token and
`{packageName}`. Core mints the same audience-scoped token for an installed
miniapp and for a development build of that package. The phone has already
decided which package is running and applied the signer rule; Core verifies
nothing else and calls no other service.

## Faults

| Fault | Expected behavior |
| --- | --- |
| Dev build of a package installed with a publisher signature | Phone refuses it and tells the user to uninstall the package first |
| Dev build of an unsigned installed package | Runs as that package; Home marks it as a dev build; tokens name that package |
| Unsigned bundle (release or dev snapshot) over a signed install | Install refused before files change |
| Signed bundle with a different key | Install refused: publisher signature mismatch |
| Bundle modified after signing | Signature verification fails on the phone and in the Store |
| Publisher key lost | Phones and the Store keep the old fingerprint; the package cannot be updated with a new key |
| Signed package uninstalled | Recorded key cleared; any build of the package may install |

## QA

- Engine unit tests: the signer table; live dev registration refused over a
  signed install, allowed over an unsigned install or none, allowed again after
  uninstall; an unsigned installed package plus an unsigned dev build stays
  marked as a dev build and requests tokens for that package; the launcher
  ignores live dev code for a signed package; archive signature verification.
- Mobile installer tests (real `AppRegistry` over a real filesystem): the signer
  table and version ordering for QR/manual, bundled and dev-snapshot installs;
  rechecks inside the serialized transaction; restore on commit failure and on
  interrupted activation.
- Cloud Client and Core unit tests: the miniapp-token request carries only
  `packageName`, and Core mints from it without calling another service.
- SDK CLI tests: unsigned by default, `--sign` and `--signing-key`, key storage.
- Device: install a signed release, scan a `mentra dev` QR for the same package
  and confirm the uninstall prompt; uninstall, rescan, and confirm the dev build
  runs and `session.auth.getToken()` returns a token whose audience is the
  package.
