# Examples

Example apps for integrators who embed Mentra's platform SDKs in their own
apps:

- [`bluetooth/`](bluetooth/README.md): the Bluetooth SDK Starter Kit. Native
  Android, iOS, and macOS apps and React Native apps that use
  `@mentra/bluetooth-sdk` (`com.mentraglass:bluetooth-sdk` on Android,
  `MentraBluetoothSDK` on Apple platforms) to connect to smart glasses directly
  over Bluetooth, plus local media and streaming helpers.
- [`oem-app/`](oem-app/README.md): a minimal Expo host that embeds
  `@mentra/engine`, the on-device miniapp registry and runtime, the way a
  second host app would.

Developing a Mentra miniapp that runs inside the Mentra App? Use the Mentra
Miniapp SDK and tooling in [`sdk/`](../sdk/README.md) instead.

## Building from source

The examples build against the SDK source in this repository, so SDK changes
take effect in the next example build without publishing anything:

- The React Native examples and `oem-app` are members of the `examples/` Bun
  workspace ([`package.json`](package.json), [`bun.lock`](bun.lock)). It links
  `@mentra/*` (`workspace:*`) to `mobile/modules` and `cloud-v2/packages`, the
  same way `sdk/` does, and resolves one Expo / React Native version for all
  the examples. Install with `cd examples && bun install`; installing runs the
  linked packages' `prepare` scripts, which build them.
- The native Android example includes `mobile/modules/bluetooth-sdk/android`
  as a Gradle composite build.
- The native iOS and macOS examples use `mobile/modules/bluetooth-sdk` as a
  local Swift package.

The standalone
[Bluetooth SDK Starter Kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit)
is generated from `bluetooth/` with its SDK dependencies pinned to published
versions: the export turns each example into a standalone project that
depends on published package versions. A scheduled workflow exports each
channel's latest completed release, skipping intermediate ones (older releases
by manual dispatch only; `.github/workflows/bluetooth-starter-kit-export.yml`, script
`.github/scripts/export-bluetooth-starter-kit.mjs`). The kit's own CI lives in
the kit repository and is left untouched by the export.

CI: `Example App Builds` builds the Bluetooth examples; `OEM Host Boundary
Gate` and `OEM Example App APK` cover `oem-app/`.
