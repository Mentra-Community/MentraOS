# `session.system`

OS-level utilities for miniapps: share sheet, browser open, clipboard, and
file download. Each method bridges to a native phone capability via
LocalMiniappRuntime.

Source: [mobile/modules/miniapp/src/modules/system.ts](../../mobile/modules/miniapp/src/modules/system.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Share text + URL.
const result = await session.system.share({
  title: "Check this out",
  text: "Mentra is cool",
  url: "https://mentra.glass",
})
if (result.cancelled) console.log("user dismissed the sheet")

// Open a URL in the system browser.
session.system.openUrl("https://docs.mentra.glass")

// Copy to clipboard.
await session.system.copyToClipboard("hello")

// Download — opens share sheet for save location.
await session.system.download({
  url: "https://example.com/report.pdf",
  filename: "report.pdf",
})
```

---

## API

### `share(options)` — `Promise<ShareResult>`

Opens the OS share sheet with the supplied content. Any combination of
`text`, `url`, and base64 file data is accepted — the host selects the
appropriate share intent.

**Parameters:** `ShareOptions`

```ts
interface ShareOptions {
  text?: string
  url?: string
  title?: string
  /** Base64-encoded file data for file sharing. */
  base64?: string
  /** MIME type when sharing base64 data. */
  mimeType?: string
  /** Filename when sharing base64 data. */
  filename?: string
}
```

**Returns:** `ShareResult`

```ts
interface ShareResult {
  /** True when the share completed (delivered to a target). */
  success: boolean
  /** True when the user dismissed the sheet without sharing. */
  cancelled?: boolean
}
```

When the runtime returns no result, the module falls back to
`{success: false}`.

---

### `openUrl(url)` — `void`

Opens `url` in the system browser. Fire-and-forget — no ack, no Promise.

**Side effects:**
- Sends `OPEN_URL` as a one-shot (no `requestId`).
- The host blocks dangerous schemes (`javascript:`, `file:`); the SDK does
  not pre-validate.

---

### `copyToClipboard(text)` — `Promise<void>`

Copies `text` to the system clipboard. Resolves when the host
acknowledges; rejects on transport error.

---

### `download(options)` — `Promise<DownloadResult>`

Downloads a file and routes it through the OS share sheet so the user can
choose a save location. Supports either a remote URL or inline base64
payload.

**Parameters:** `DownloadOptions`

```ts
interface DownloadOptions {
  /** URL to download from, OR base64 data. */
  url?: string
  base64?: string
  filename?: string
  mimeType?: string
}
```

**Returns:** `DownloadResult`

```ts
interface DownloadResult {
  /** True when the file was saved / delivered to a share target. */
  success: boolean
  /** True when the user dismissed the share sheet. */
  cancelled?: boolean
}
```

When the runtime returns no result, the module falls back to
`{success: false}`.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `INTERNAL` | `share`, `copyToClipboard`, `download` (rejected Promise) | Phone-side path threw. Check `message`. |
| `REQUEST_ABORTED` | `share`, `copyToClipboard`, `download` (rejected Promise) | Session torn down before the request completed. |

This module declares no synchronous throws and does not gate on a manifest
permission. `openUrl` is fire-and-forget — host-side rejection of a
dangerous scheme surfaces silently.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `share` | `SHARE` (`{text?, url?, title?, base64?, mimeType?, filename?}`) | `REQUEST_RESULT` with `data: ShareResult` |
| `openUrl` | `OPEN_URL` (`{url}`, one-shot, no `requestId`) | — |
| `copyToClipboard` | `COPY_CLIPBOARD` (`{text}`) | `REQUEST_RESULT` |
| `download` | `DOWNLOAD` (`{url?, base64?, filename?, mimeType?}`) | `REQUEST_RESULT` with `data: DownloadResult` |

This module subscribes to no streams.

---

## Tests

_no integration tests yet_
