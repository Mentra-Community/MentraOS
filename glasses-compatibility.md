# Smart Glasses Compatibility

## Supported Devices

MentraOS supports smart glasses through explicit device and project identifiers. A
Bluetooth name or manufacturer-data prefix is a compatibility claim; do not add a
prefix unless the hardware is validated and listed here.

## Feature Compatibility Matrix

| Model | Display (Text) | Display (Images) | Microphone | Speaker | Camera |
| --- | --- | --- | --- | --- | --- |
| Even Realities G1 | Full | Full | Full | Not available | Not available |
| Mentra Live | Not available | Not available | Full | Full | Full |
| Mentra Mach 1 | Full | Not available | Partial* | Not available | Not available |
| Vuzix Z100 | Full | Not available | Partial* | Not available | Not available |
| Xingyi AR99 | Full | Not available | Full | Not available | Not available |

* Microphone support via connected phone's microphone.

## AR99 Compatibility Matrix

The Mentra App exposes validated Xingyi AR99 hardware as `DeviceTypes.AR99`.
Only the exact BLE project identifier listed below is supported.

| Manufacturer | Display model | Device type | BLE project identifier |
| --- | --- | --- | --- |
| Xingyi Intelligent | Xingyi AR99 | `AR99` | `AR99` |

`AF98`, `AF99`, `HVXM`, and `HVXF` are not supported project identifiers and
must be rejected by scanning and advertisement parsing. AR99 pairing must fail
closed when a scan result has no project identifier or has a project identifier
outside the matrix above.

## Getting Started

1. Download the Mentra App from the [App Store](https://apps.apple.com/us/app/mentra-the-smart-glasses-app/id6747363193) or [Google Play](https://play.google.com/store/apps/details?id=com.mentra.mentra).
2. Connect your smart glasses via Bluetooth.
3. Start using miniapps from the [Mentra Miniapp Store](https://apps.mentra.glass).

## Need Help?

If you are having trouble connecting your smart glasses or want to confirm compatibility, please:

- Check our [documentation](https://docs.mentra.glass)
- Join our [Discord community](https://mentra.glass/discord)
- Contact us at [team@mentra.glass](mailto:team@mentra.glass)
