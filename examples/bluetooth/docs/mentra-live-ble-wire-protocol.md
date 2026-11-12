# Mentra Live BLE Wire Protocol Notes

Mentra Live phones talk to the glasses over BLE using a K900-style framing layer (`##` + type + 2-byte length + payload + `$$`). Recent SDK releases add **BLE Wire Protocol v2** for higher throughput and **negotiated K900 length endianness** for backward compatibility with older glasses firmware.

Third-party apps using the published Mentra Bluetooth SDK do **not** need custom framing code. Negotiation, chunking, compact JSON, and binary fragment transport are handled inside the native SDK (`MentraLive` on Android/iOS).

## What Changed

| Area | Behavior |
| --- | --- |
| K900 STRING length field | Negotiated per link via `wire_caps.k900_le`. Legacy firmware uses **big-endian**; wire-v2 peers use **little-endian**. |
| Binary transport (`0x40`) | Optional high-throughput path after `wire_caps.binary` and the v2 handshake (`phone_ready` / `glasses_ready`). |
| App API | Unchanged. Keep using `BluetoothSdk`, `useMentraBluetooth()`, and the existing command/event surface. |

## SDK And Firmware Pairing

Use a **matching** SDK + glasses firmware combination:

| Your app SDK | Glasses firmware | Result |
| --- | --- | --- |
| `0.1.19` or older | Any | Legacy path only. Works with older firmware; may fail boot-ready on newer ASG↔BES stacks that changed UART endian without negotiation. |
| `0.1.20` or newer (wire v2 release) | Older BES (big-endian) | Supported. SDK defaults to BE and upgrades to LE only when `wire_caps` advertises it. |
| `0.1.20` or newer | New BES (wire v2) | Full wire v2: LE lengths, optional binary `0x40`, compact JSON. |

BLE wire v2 shipped in SDK `0.1.20`. Pin `@mentra/bluetooth-sdk`, the Android Maven artifact, or the iOS Swift package to `0.1.20` or newer in your app.

## Integrator Checklist

- Pin SDK `0.1.20` or newer in your app to use BLE wire v2.
- Do **not** hand-roll K900 length bytes in app code; always go through the SDK.
- Subscribe to glasses status before sending commands; wait for `fullyBooted` / connection ready on Mentra Live.
- Debounce rapid display or settings writes (the production checklist already recommends this).
- For Mentra Live camera/streaming, confirm Wi-Fi is connected before starting uploads or live streams.

## Validation

Before shipping a Mentra Live integration:

1. Pair against **current production firmware** on a physical device.
2. If you support field devices on older firmware, smoke-test connect + `glasses_ready` + one photo and one settings write.
3. Watch native SDK logs for `wire_caps negotiated` / `BLE wire protocol v2` during connect (optional diagnostics).

See [Troubleshooting](troubleshooting.md#mentra-live-glasses-stuck-not-ready) if glasses never reach ready state after connect.
