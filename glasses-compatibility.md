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
| AR99 family | Full | Not available | Full | Not available | Not available |

* Microphone support via connected phone's microphone.

## AR99 Family Compatibility Matrix

The Mentra App exposes AR99-family hardware as `DeviceTypes.AR99`, but each
supported OEM variant must keep its own manufacturer, display model, and BLE
project identifier.

| Manufacturer | Display model | Device type | BLE project identifier |
| --- | --- | --- | --- |
| Xingyi Intelligent | Xingyi AR99 | `AR99` | `AR99` |
| Xingyi Intelligent | Xingyi AR99 CAT | `AR99` | `AF99` |
| HOLOVOX | HOLOVOX Legacy | `AR99` | `HVXM` |
| HOLOVOX | HOLOVOX Luna | `AR99` | `HVXF` |

`AF98` is not a supported project identifier and must be rejected by scanning and
advertisement parsing. AR99-family pairing must fail closed when a scan result
has no project identifier or has a project identifier outside the matrix above.

## Getting Started

1. Download the Mentra App from the [App Store](https://apps.apple.com/us/app/mentra-the-smart-glasses-app/id6747363193) or [Google Play](https://play.google.com/store/apps/details?id=com.mentra.mentra).
2. Connect your smart glasses via Bluetooth.
3. Start using miniapps from the [Mentra Miniapp Store](https://apps.mentra.glass).

## Need Help?

If you are having trouble connecting your smart glasses or want to confirm compatibility, please:

- Check our [documentation](https://docs.mentra.glass)
- Join our [Discord community](https://mentra.glass/discord)
- Contact us at [team@mentra.glass](mailto:team@mentra.glass)