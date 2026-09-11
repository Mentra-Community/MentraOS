# Developer Console

**Status:** Draft. Part of Websites (see ../README.md).

The new developer console is Console2:

- Spec: [`../../013-console2/`](../../013-console2/)
- Proposed path: `cloud-v2/websites/console`
- Proposed hosts: `console2.dev.mentraglass.com`,
  `console2.staging.mentraglass.com`, `console2.mentraglass.com`

Console2 is developer-facing: package claims, bundle versions, CLI
authorization, store submissions, logs, tokens, and signing keys. It should not
own internal admin review queues or enterprise/OEM trusted issuer management.
