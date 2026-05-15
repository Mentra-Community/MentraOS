# Camera web server

ASG Client embeds a small HTTP server on the glasses (default port **8089**) that the phone uses to enumerate, sync, and download captured photos and videos. It also exposes endpoints for taking pictures, server status, and bulk file management.

Source: `app/src/main/java/com/mentra/asg_client/io/server/`. Main class: `AsgCameraServer` (`io/server/services/AsgCameraServer.java`), built on the abstract `AsgServer` (`io/server/core/AsgServer.java`) which wraps NanoHTTPD.

## When the server runs

The server is started by `AsgClientServiceManager.initializeCameraWebServer()` after WiFi credentials are accepted (see `WifiCommandHandler.handleSetWifiCredentials`). It listens on the local WiFi address only — it is not exposed beyond the network the glasses are joined to.

`AsgClientServiceManager.getCameraServer()` exposes the running instance to other components. The gallery command handler, for example, reads counts from the server's `FileManager`.

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
    config, network, cache, rate, logger, fileManager
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

Replace `<GLASSES_IP>` with the WiFi IP of the glasses (visible in the phone app's pairing screen).

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
