# Storage Service

**Status:** Placeholder. Part of Cloud Core Services (see ../README.md). To be specified.

A thin internal service wrapping the swappable blob storage providers (Cloudflare R2, Alibaba OSS per region), exposing put/get/delete and signed-URL operations. Other services use it instead of talking to providers directly. For example, bundle storage is a concern of miniapp-service, which stores miniapp bundles through this service.

The same wrapper pattern recurs in Mentra Runtime Services for photo storage, but since that product is self-hostable it instantiates its own wrapper against its own provider config rather than sharing this Cloud Core instance across the product boundary. See [`../../002-cloud-runtime/camera/`](../../002-cloud-runtime/camera/).
