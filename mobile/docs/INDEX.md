# Mobile Docs

This folder holds the durable documentation for the **MentraOS mobile app** — the React Native / Expo client that runs on the user's phone and bridges the smart glasses to the cloud.

## What this folder is for

- Explaining **how the mobile app's native modules work** — the JS↔native bridge, lifecycle, event flow, and platform-specific details that aren't obvious from reading the code alone.
- Recording **architectural decisions and parity contracts** between iOS (Swift) and Android (Kotlin) so future contributors keep both sides in sync.
- Giving new contributors a one-page-per-topic overview before they dive into the source.

It is **not** for:
- Ephemeral planning notes — those live in [mobile/agents/](../agents/).
- Feature/system writeups that span the whole mobile app — those live as `SHOUTY_CASE.md` files at the [mobile/](../) root (e.g. `CAMERA_APP_BUTTON_CAPTURE.md`, `STT_MODEL_DOWNLOAD.md`).
- Cloud, SDK, or repo-wide architecture — see [mintlify-docs/](../../mintlify-docs/) for public docs and [notes/](../../notes/) for working notes at the repo root.

## Layout

- [module/](module/) — per-native-module documentation. One subfolder per Expo native module under `mobile/modules/`, each with a `README.md` plus per-feature pages.

## Core components

### Native modules

| Module | Docs | What it does |
| --- | --- | --- |
| **crust** | [module/crust/README.md](module/crust/README.md) | Catch-all native module: navigation, heading, OS settings, notifications, media, AV routing. |

Per-feature pages under crust:

- [module/crust/Navigation.md](module/crust/Navigation.md) — turn-by-turn navigation via Google Navigation SDK.
- [module/crust/Heading.md](module/crust/Heading.md) — magnetic compass degrees stream.
