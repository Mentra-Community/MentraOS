# MentraOS Docs Roots

This repository has one Mintlify documentation root:

- `mintlify-docs/` is the MentraOS documentation site for cloud Mini Apps, OS development, OEMs, cookbook content, and Mentra Live Bluetooth SDK docs.
- `mintlify-docs/bluetooth-sdk/` is the Mentra Bluetooth SDK documentation for mobile apps that connect directly to Mentra Live over Bluetooth.

Keep `mintlify-docs/bluetooth-sdk/` self-contained so changes can be transplanted onto `frozen-docs` with minimal conflicts. Miniapp SDK pages should link to `/bluetooth-sdk/overview` when direct mobile Bluetooth control is the right path.

## Local Export

Export the MentraOS docs:

```bash
cd mintlify-docs
bunx --bun mint export --output /tmp/mentraos-docs-export.zip
```

The Bluetooth SDK tab is included in the same export.
