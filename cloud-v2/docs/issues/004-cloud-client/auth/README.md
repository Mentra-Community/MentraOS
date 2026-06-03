# Cloud Client: auth module (`cloud.auth`)

**Status:** Placeholder. Part of the Cloud Client (see ../README.md). To be specified.

The token lifecycle, shared by the runtime and core modules. Holds the Mentra access token and auto-refreshes it (rotating refresh token), mints and caches miniapp-scoped tokens, and exposes the decoded identity (`mentraUserId`, `oemId`). The raw access token never leaves the client. This is the client half of the auth design in [`../../001-cloud-core/auth/auto-auth/`](../../001-cloud-core/auth/auto-auth/).
