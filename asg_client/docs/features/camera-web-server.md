# Camera web server

ASG Client embeds a small HTTP server on the glasses (default port **8089**) that the phone uses to enumerate, sync, and download captured photos and videos while connected to the Mentra Live hotspot. It also exposes endpoints for taking pictures, server status, and bulk file management.

Source: `app/src/main/java/com/mentra/asg_client/io/server/`. Main class: `AsgCameraServer` (`io/server/services/AsgCameraServer.java`), built on the abstract `AsgServer` (`io/server/core/AsgServer.java`) which wraps NanoHTTPD.

## When the server runs

By default, the server starts only after the Mentra Live hotspot reports ready and stops as soon as the hotspot stops. `AsgClientService.onHotspotStateChanged()` drives the matching server lifecycle through `AsgClientServiceManager`. At process startup, an already-active hotspot is adopted before the service manager synchronizes the server state.

With persistent access disabled, NanoHTTPD binds specifically to the active hotspot gateway address. Ordinary station-mode WiFi connections do not start the server.

`AsgClientServiceManager.getCameraServer()` exposes the running instance to other components. Gallery counts are read independently from the shared `FileManager`, so BLE status queries also work without a listener.

### Persistent site-network gallery opt-in

`set_gallery_server_enabled` keeps the existing camera server running on all local interfaces at port 8089. It defaults off. The saved setting survives BLE disconnection, hotspot shutdown, and glasses restart until disabled; it has no idle timeout. The server remains running across Wi-Fi disconnections and DHCP changes. A five-second reconciliation loop retries failed starts. Service cleanup stops the server without clearing the saved setting.

Both modes use the same `AsgCameraServer`, factory configuration, camera callbacks, and complete endpoint table below. There is no separate route allowlist or HTTP API variant. Clients can use the existing listing, download, sync, deletion, restore, capture, and browser APIs on the site-network IP.

The server uses plain HTTP without a password or token. Any reachable client can use the complete API, and traffic is unencrypted. This is an explicit opt-in for deployments whose network policy permits that access.

BLE request:

```json
{"type":"set_gallery_server_enabled","request_id":"gallery-1","enabled":true}
```

Response when the setting is saved and a site-network endpoint is available:

```json
{"type":"settings_ack","request_id":"gallery-1","setting":"gallery_server","status":"applied","enabled":true,"listening":true,"url":"http://10.0.0.42:8089","timestamp":1234567890}
```

`enabled` describes the persisted setting; `listening` describes current site-network availability. An enable can succeed with `listening:false` and no `url`, for example without station Wi-Fi or while a bind is being retried. Repeat the same enable to obtain a fresh acknowledgement without restarting a healthy server. Send `enabled:false` to restore hotspot-only access: the listener rebinds to an active hotspot's address or stops if the hotspot is off. Switching binding modes restarts the listener and can interrupt in-flight requests; normal HTTP retries apply.

Commands require a nonempty `request_id` and a JSON boolean `enabled`. Malformed input returns an `invalid_request` error ack without changing the setting. Settings storage failure returns `settings_unavailable`. Native SDKs expose this as `setGalleryServerEnabled`; older firmware that does not handle the command will time out rather than claim success.

### End-to-end device qualification

Use updated glasses firmware and a native SDK build on a managed iPad with both devices joined to the same site Wi-Fi:

1. With the hotspot off and the setting disabled, confirm port 8089 is unavailable on the glasses' site-network IP.
2. Call `setGalleryServerEnabled(true)` through the client SDK. Check `enabled:true`, `listening:true`, and the returned station URL; list `/api/gallery` and download a finished recording through `/api/download`.
3. Background the client and disconnect BLE. Confirm the HTTP transfer completes. Restart the glasses and reconnect Wi-Fi; confirm the server returns without another enable command. Repeat enable after reconnecting BLE to obtain the current URL if DHCP changed it.
4. Exercise capture, deletion, and restore with disposable media using the same HTTP requests as on the hotspot.
5. Call `setGalleryServerEnabled(false)` and confirm `enabled:false`, `listening:false`, no URL, and no station-network access. Start the hotspot and verify the original gallery APIs still work; stop it and verify the server stops.
6. Switch modes during a transfer and verify the client retries an interrupted request. On older firmware, verify the SDK reports a timeout rather than success.

Automated tests complement this hardware path: `GalleryServerCommandTests` replays native SDK commands and raw receive bytes through the real Swift event bridge and request resolver; `galleryServerBridge.test.ts` checks the public TypeScript adapter; ASG lifecycle and HTTP tests cover the device side. Radio, MDM policy, and background execution still require the physical run above.

## Construction

`AsgCameraServer` uses dependency injection — you don't pass `Context` and a port directly. The factory in `io/server/core/DefaultServerFactory.java` builds the dependencies; the typical wiring is:

```java
ServerConfig config = new DefaultServerConfig.Builder()
    .port(8089)
    .serverName("AsgCameraServer")
    .context(context)
    .corsEnabled(true)
    .build();

NetworkProvider network = new DefaultNetworkProvider(logger);
CacheManager cache = new DefaultCacheManager(logger);
RateLimiter rate = new DefaultRateLimiter(100, 60_000, logger);

AsgCameraServer server = new AsgCameraServer(
    config, network, cache, rate, logger, fileManager, hotspotGatewayIp
);

server.setOnPictureRequestListener(() -> mediaCaptureService.takePicture());
server.startServer();
```

The `FileManager` provides package-namespaced file storage and deletion — see [features/file-manager-integration.md](file-manager-integration.md). Files are stored under each requesting app's package directory.

## Endpoints

All routes are dispatched in `AsgCameraServer.handleRequest(IHTTPSession)`.

| Method | Path                            | Purpose                                                             |
| ------ | ------------------------------- | ------------------------------------------------------------------- |
| GET    | `/`                             | HTML index page (mostly for manual testing)                         |
| POST   | `/api/take-picture`             | Trigger photo capture via the registered `OnPictureRequestListener` |
| GET    | `/api/latest-photo`             | Returns the most recently captured photo (binary)                   |
| GET    | `/api/gallery`                  | List all photos with metadata                                       |
| GET    | `/api/photo?file=<filename>`    | Serve a specific photo                                              |
| GET    | `/api/download?file=<filename>` | Download a specific file with content-disposition                   |
| GET    | `/api/status`                   | Server status & metrics                                             |
| GET    | `/api/health`                   | Health check                                                        |
| POST   | `/api/cleanup`                  | Bulk cleanup operation                                              |
| POST   | `/api/delete-files`             | Delete a list of named files (see below)                            |
| GET    | `/api/sync`                     | Single-file sync handshake                                          |
| GET    | `/api/sync-batch`               | Batch sync handshake                                                |
| GET    | `/api/sync-status`              | Current sync state                                                  |
| GET    | `/static/<filename>`            | Static asset (CSS/JS/images served from app assets)                 |

### `POST /api/delete-files`

Bulk-delete a list of filenames. Used by the phone app when the user removes items from the gallery view. All deletions go through `FileManager.deleteFile`, which scopes deletion to the requesting app's package directory.

**Request:**

```json
{"files": ["IMG_001.jpg", "IMG_002.jpg", "VID_003.mp4"]}
```

`files` is required and must be non-empty.

**Success response:**

```json
{
  "status": "success",
  "data": {
    "message": "File deletion completed",
    "total_files": 3,
    "successful_deletions": 2,
    "failed_deletions": 1,
    "total_deleted_size": 2048576,
    "results": [
      {"file": "IMG_001.jpg", "success": true, "message": "File deleted successfully", "size": 1024288},
      {"file": "IMG_002.jpg", "success": false, "message": "File not found", "size": 0}
    ],
    "timestamp": 1640995200000
  }
}
```

**Error responses:**

- `400` — `{"status": "error", "message": "Files array cannot be empty"}`
- `400` — `{"status": "error", "message": "Invalid JSON format: ..."}`
- `405` — `{"status": "error", "message": "Only POST method is allowed"}`
- `500` — `{"status": "error", "message": "Unexpected error: ..."}`

Files that don't exist are reported as `success: false` in the per-file results but don't fail the whole request.

### Capture IDs and `request_id`

Captures live in directories named `<IMG|VID>_<yyyyMMdd_HHmmss_SSS>_<rand>[_<requestId>]`. The directory name is the `capture_id` returned by `/api/sync`, and the optional trailing segment is the (sanitized) `requestId` of the SDK `take_photo` / video request that produced the capture — the same convention videos have always used, extended to photos.

When a capture ID embeds a request ID, `/api/sync` capture groups and `/api/gallery` entries include it as an explicit `request_id` field (extracted by `CaptureRequestId.extractFromCaptureId`), so clients can correlate bulk-synced files with the originating photo request instead of timestamp-matching. Button-press captures have no originating request; their stable ID is the `capture_id` itself, which is also used as the `requestId` in the photo status messages the glasses emit during the capture. Legacy files and button captures simply omit `request_id`.

The capture ID is also stamped into the photo's EXIF `ImageUniqueID` tag at save time (`PhotoExifMetadataWriter.writeCaptureIdFromPath`), and carried onto re-encoded upload copies, so the correlation survives file renames and camera-roll export where the directory name is lost.

### Active recording exclusion

`AsgCameraServer.ActiveRecordingProvider` lets the capture service inform the server about videos that are currently being written. The server uses this to:

- Hide the in-progress capture's directory from `/api/gallery` and `/api/sync*` responses.
- Block downloads of files that are still being written, which would otherwise return truncated content.

`getPendingVideoIntegrityCaptureIds()` extends this for a brief post-record window during which the recording integrity check is still running.

## Cross-cutting features (from `AsgServer`)

- **Rate limiting** — `RateLimiter` (default 100 req/min per IP). Configurable.
- **Caching** — `CacheManager` for hot-path responses like the gallery listing. TTL'd, with periodic cleanup.
- **CORS** — enabled by default; preflight `OPTIONS` is handled.
- **Static files** — `GET /static/<file>` serves from app assets.
- **Security** — directory-traversal protection on file params, file-extension allowlist, parameter sanitization, security headers.

## Curl test recipes

Replace `<GLASSES_IP>` with the hotspot gateway IP reported by the glasses.

```bash
# Health
curl http://<GLASSES_IP>:8089/api/health

# Server status / metrics
curl http://<GLASSES_IP>:8089/api/status

# Trigger a photo
curl -X POST http://<GLASSES_IP>:8089/api/take-picture

# Latest photo (binary)
curl http://<GLASSES_IP>:8089/api/latest-photo --output latest.jpg

# Gallery JSON
curl http://<GLASSES_IP>:8089/api/gallery

# Download one file
curl "http://<GLASSES_IP>:8089/api/download?file=IMG_001.jpg" --output IMG_001.jpg

# Delete files
curl -X POST http://<GLASSES_IP>:8089/api/delete-files \
  -H 'Content-Type: application/json' \
  -d '{"files": ["IMG_001.jpg", "IMG_002.jpg"]}'
```

## Logcat tags

| Tag                          | Component                               |
| ---------------------------- | --------------------------------------- |
| `AsgCameraServer`            | Route handling, photo serving, deletion |
| `AsgServer` (base class TAG) | Generic request handling, rate limiting |
| `CacheManager`               | Cache hits/misses                       |
| `RateLimiter`                | Throttling decisions                    |
