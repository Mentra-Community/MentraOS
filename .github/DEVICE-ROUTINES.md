# Device routine requests

Routine identities, names, supported platforms, resource requirements and execution policies come from Core's enrolled definitions. GitHub workflows maintain no routine registry.

Explicit requests use **Request device routine** on `dev`. Enter an enrolled routine ID and platform, the source channel, exact published build run ID and original publication attempt. PR sources also require the PR number. Core resolves the immutable app archive, freezes the definition and lane inputs, and queues the host request. Repeating the same source/routine/platform returns the same request; a GitHub rerun does not create another test.

PR `routine:<id>` labels resolve all enrolled platforms for each selected ID. Automatic label dispatch is disabled unless `DEVICE_ROUTINE_PR_DISPATCH_ENABLED=true`. When enabled, the trusted `dev` request workflow reads PR metadata, and app publication callbacks retry selections whose build was pending. Unknown or unsupported selections fail with an admission reason. PR application code is never executed by these callers.

Coordinated publication displays generic available-test and exact-build result links. Publication itself starts no routine. Explicit requests and the independently enabled dev nightly select coverage.

The internal catalog, dispatch and result endpoints require `TEST_RUN_INGEST_TOKEN_DEV`. Execution additionally requires Core's configured host/lane binding and a compatible enrolled definition. A queue acknowledgement is not a passing result.

**Publish routine results** reads Core's frozen framework report. It can run automatically after request/dispatch workflows or manually with the accepted request ID. PR comments bind to the original candidate head and retain one comment per request. Release Slack updates require a retained bot-owned post whose platform archive hash matches the tested build; full desired state is retained before `chat.update`. Missing results, incomplete uploads and evidence failures remain explicit.
