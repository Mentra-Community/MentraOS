# 003 Cloud Proxy

**Status:** Placeholder. To be specified.

The OEM-side connector an OEM deploys in their own infrastructure. Their apps
reach Mentra's central Cloud Core through it (with OEM-scoped auth), and if the
OEM self-hosts Mentra Runtime Services, the proxy routes those requests to their
own instance instead of Mentra's.

Proxying is optional and orthogonal to self-hosting: an OEM can proxy Cloud Core
(which they cannot self-host) and separately choose to self-host Runtime Services.

## Related

- [`../001-cloud-core/`](../001-cloud-core/): always Mentra-hosted, reached through
  the proxy.
- [`../002-cloud-runtime/`](../002-cloud-runtime/): self-hostable; the proxy routes
  to the OEM's instance when present.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md)
