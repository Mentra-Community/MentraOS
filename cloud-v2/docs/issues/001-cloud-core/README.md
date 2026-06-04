# 001 Cloud Core Services

Umbrella issue for **Mentra Cloud Core Services** (`@mentra/cloud-core`): the
proprietary cloud product Mentra runs centrally for the whole ecosystem. OEMs
reach it through Cloud Proxy and never self-host it. It hosts the shared
app/developer ecosystem plus auth and bundle storage.

## Services (subfolders)

- [`auth/`](./auth/): the whole auth system. OEM auth (the RFC 8693 token
  exchange, [`auth/oem-auth.md`](./auth/oem-auth.md)), mobile-client-to-cloud identity
  (Mentra-direct and OEM), miniapp auto-auth, and dev console / store sign-in.
- [`oem-service/`](./oem-service/): OEM APIs (org and integration management) that
  back the OEM Portal.
- [`miniapp-service/`](./miniapp-service/): miniapp bundle and metadata for the
  App Store and Dev Console. Stores bundles via the storage-service.
- [`dev-console-service/`](./dev-console-service/): organizations and miniapp
  submission; backs the Dev Console site.
- [`storage-service/`](./storage-service/): a thin wrapper around the swappable
  blob providers (Cloudflare R2, Alibaba OSS), used by other services
  (miniapp-service for bundles, dev-console-service for uploads).

## Related

- [`../002-cloud-runtime/`](../002-cloud-runtime/): the self-hostable runtime product.
- [`../005-websites/`](../005-websites/): the frontends (console, miniapp-store,
  oem-portal) that consume these services.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md): product and
  service taxonomy.
