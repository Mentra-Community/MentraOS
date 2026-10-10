# @mentra/miniapp-tools

Backend tools for Mentra miniapps. The logging module supports Bun and Node.js.

```ts
import {createLogger} from '@mentra/miniapp-tools/logging';

const logger = createLogger({packageName: 'com.example.miniapp', environment: 'dev'});
const verified = await auth.verifyRequest(request); // @mentra/auth
const log = logger.forUser({mentraUserId: verified.mentraUserId, requestId: crypto.randomUUID()});
log.info('Processing started', {operation: 'generate'});
try {
  await processWork(log); // pass this logger into background and WebSocket work too
} catch (error) {
  log.error('Processing failed', {error});
  throw error;
}
```

Use your actual deployment environment, not `NODE_ENV` when dev/staging/prod all
run in production mode. The default level is `info`; `level` optionally selects
`debug`, `info`, `warn` or `error`. Startup logs can use the unscoped root logger.

`forUser` takes an authenticated Mentra user ID, optional `requestId` and
`sessionId`. It cannot rebind an existing user scope to another user. `child`
adds operation fields while retaining identity. Fields cannot overwrite logger
metadata or user identity. No global current-user state is used.

Each log is JSON on stdout, with `timestamp`, string `level`, `message`,
`packageName`, `environment`, optional `version`, and user/request/session fields.
Your deployment's log collector must ingest these fields at the JSON root;
installing this package alone does not configure log ingestion. The incident
service queries authenticated user logs asynchronously and holds query credentials.
This package contains no log-service credentials and performs no network requests.

Errors include name, message, stack and cause. Credential fields and common token
formats are redacted. Never log request bodies, auth claims, audio or note content;
redaction cannot detect every arbitrary secret. Prefer IDs, operations and timings.
Values are bounded to eight nested levels, 100 collection items and 4,096-character
strings. Lines exceeding 32 KiB retain correlation fields and `truncated: true`
while dropping optional diagnostic fields. Truncation markers remain visible.

Log output is best effort: write failures are contained, and stdout backpressure
drops new lines rather than maintaining another unbounded queue. Logging does not
change business-operation results. Invalid logger configuration or user scopes
throw at construction/scoping time, before emission.
