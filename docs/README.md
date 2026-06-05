# MentraOS Docs Roots

This repository has two Mintlify documentation roots:

- `docs/` is the main MentraOS and cloud Mini App documentation for `@mentra/sdk`.
- `docs-bluetooth-sdk/` is the standalone Mentra Bluetooth SDK documentation for mobile apps that connect directly to glasses over Bluetooth.

Keep Bluetooth SDK guide pages out of the main `docs/` navigation. Main App Dev pages can link to `https://bluetooth-sdk-docs.mentra.glass` when camera, photo, streaming, or direct mobile Bluetooth control is the right path.

## Local Export

Export the main MentraOS docs:

```bash
cd docs
bunx --bun mint export --output /tmp/mentraos-docs-export.zip
```

Export the standalone Bluetooth SDK docs:

```bash
cd docs-bluetooth-sdk
bunx --bun mint export --output /tmp/mentra-bluetooth-sdk-docs-export.zip
```
