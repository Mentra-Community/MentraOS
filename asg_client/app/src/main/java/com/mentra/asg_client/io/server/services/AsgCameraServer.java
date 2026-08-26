package com.mentra.asg_client.io.server.services;

import android.media.MediaMetadataRetriever;
import android.os.Build;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;
import com.mentra.asg_client.io.server.core.AsgServer;
import com.mentra.asg_client.io.server.interfaces.*;
import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.utils.CaptureRequestId;
import com.mentra.asg_client.utils.GallerySyncFilter;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Enhanced Camera web server for ASG (AugmentOS Smart Glasses) applications. Provides RESTful API
 * for photo capture, gallery browsing, and file downloads. Integrates with the comprehensive file
 * management system for better security, performance, and maintainability.
 *
 * <p>Follows SOLID principles with dependency injection and proper separation of concerns.
 */
public class AsgCameraServer extends AsgServer {

    private static final String TAG = AsgCameraServer.class.getName();
    private static final int DEFAULT_PORT = 8089;

    /** If phone last_sync_time is this far ahead of glasses clock, treat as full sync. */
    private static final long CLOCK_SKEW_TOLERANCE_MS = 60_000L;

    private static final int MAX_JSON_BODY_BYTES = 1024 * 1024;
    private static final int DEFAULT_MANIFEST_PAGE_SIZE = 50;
    private static final int MAX_MANIFEST_PAGE_SIZE = 100;
    private static final long MIN_TRASH_RETENTION_MS = 7L * 24 * 60 * 60 * 1000;

    /**
     * Provider that returns the capture ID (directory name, e.g. "VID_xxx") of an actively
     * recording video, or null if idle. Used to exclude in-progress recordings from sync and
     * download responses.
     */
    public interface ActiveRecordingProvider {
        String getActiveRecordingCaptureId();

        /**
         * Capture IDs whose files must stay off sync/download until post-record validation
         * completes.
         */
        default Set<String> getPendingVideoIntegrityCaptureIds() {
            return Collections.emptySet();
        }
    }

    // File management system
    private final FileManager fileManager;
    private final GalleryTrashManager galleryTrashManager;
    private final Map<String, String> galleryHashCache =
            Collections.synchronizedMap(
                    new LinkedHashMap<String, String>() {
                        @Override
                        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
                            return size() > 128;
                        }
                    });

    // Optional provider for currently recording file name
    private ActiveRecordingProvider activeRecordingProvider;

    // Cache for latest photo metadata
    private FileMetadata latestPhotoMetadata;

    /** Callback interface for handling "take-picture" requests. */
    public interface OnPictureRequestListener {
        void onPictureRequest();
    }

    private OnPictureRequestListener pictureRequestListener;

    /**
     * Constructor for camera web server with dependency injection. Follows Dependency Inversion
     * Principle by depending on abstractions.
     *
     * @param config Server configuration
     * @param networkProvider Network information provider
     * @param cacheManager Cache manager
     * @param rateLimiter Rate limiter
     * @param logger Logger
     * @param fileManager File manager for secure file operations
     */
    public AsgCameraServer(
            ServerConfig config,
            NetworkProvider networkProvider,
            CacheManager cacheManager,
            RateLimiter rateLimiter,
            Logger logger,
            FileManager fileManager) {
        this(config, networkProvider, cacheManager, rateLimiter, logger, fileManager, null);
    }

    /** Construct a camera server restricted to a single local network address. */
    public AsgCameraServer(
            ServerConfig config,
            NetworkProvider networkProvider,
            CacheManager cacheManager,
            RateLimiter rateLimiter,
            Logger logger,
            FileManager fileManager,
            String bindAddress) {
        super(config, networkProvider, cacheManager, rateLimiter, logger, bindAddress);
        this.fileManager = fileManager;
        this.galleryTrashManager =
                new GalleryTrashManager(
                        fileManager.getPackageDirectory(fileManager.getDefaultPackageName()));

        logger.info(TAG, "📸 Camera server initialized with file manager");
        logger.info(TAG, "📸 Camera package: " + fileManager.getDefaultPackageName());
        logger.info(
                TAG, "📸 Base directory: " + fileManager.getAvailableSpace() + " bytes available");
    }

    @Override
    protected String getTag() {
        return TAG;
    }

    /** Gallery reads include one request per immutable segment and must not exhaust control limits. */
    @Override
    protected boolean shouldRateLimit(IHTTPSession session) {
        if (session.getMethod() != Method.GET) {
            return true;
        }
        switch (session.getUri()) {
            case "/api/download":
            case "/api/photo":
            case "/api/gallery":
            case "/api/sync":
            case "/api/sync-status":
            case "/api/v3/capabilities":
            case "/api/v3/manifest":
            case "/api/v3/hash":
                return false;
            default:
                return true;
        }
    }

    /** Set the listener that will be notified when someone clicks "take picture." */
    public void setOnPictureRequestListener(OnPictureRequestListener listener) {
        this.pictureRequestListener = listener;
        logger.debug(TAG, "📸 Picture request listener " + (listener != null ? "set" : "cleared"));
    }

    /** Handle specific camera-related requests with enhanced file management. */
    @Override
    protected Response handleRequest(IHTTPSession session) {
        String uri = session.getUri();

        switch (uri) {
            case "/":
                logger.debug(TAG, "📄 Serving index page");
                return serveIndexPage();
            case "/api/take-picture":
                logger.debug(TAG, "📸 Handling take picture request");
                return handleTakePicture();
            case "/api/latest-photo":
                logger.debug(TAG, "🖼️ Serving latest photo");
                return serveLatestPhoto();
            case "/api/gallery":
                logger.debug(TAG, "📚 Serving photo gallery");
                return serveGallery(session);
            case "/api/photo":
                logger.debug(TAG, "🖼️ Serving specific photo");
                return servePhoto(session);
            case "/api/download":
                logger.debug(TAG, "⬇️ Serving photo download");
                return serveDownload(session);
            case "/api/status":
                logger.debug(TAG, "📊 Serving server status");
                return serveStatus();
            case "/api/health":
                logger.debug(TAG, "❤️ Serving health check");
                return serveHealth();
            case "/api/cleanup":
                logger.debug(TAG, "🧹 Serving cleanup request");
                return serveCleanup(session);
            case "/api/delete-files":
                logger.debug(TAG, "🗑️ Serving delete files request");
                return serveDeleteFiles(session);
            case "/api/sync":
                logger.debug(TAG, "🔄 Serving sync request");
                return serveSync(session);
            case "/api/sync-batch":
                logger.debug(TAG, "📦 Serving batch sync request");
                return serveBatchSync(session);
            case "/api/sync-status":
                logger.debug(TAG, "📊 Serving sync status request");
                return serveSyncStatus(session);
            case "/api/v3/capabilities":
                return serveGalleryCapabilities();
            case "/api/v3/manifest":
                return serveV3Manifest(session);
            case "/api/v3/hash":
                return serveV3Hash(session);
            case "/api/v3/ack":
                return serveV3Ack(session);
            case "/api/v3/trash":
                return serveV3Trash();
            case "/api/v3/restore":
                return serveV3Restore(session);
            default:
                // Check if it's a static file request
                if (uri.startsWith("/static/")) {
                    logger.debug(TAG, "📁 Serving static file: " + uri);
                    return serveStaticFile(uri, "static");
                } else {
                    logger.warn(TAG, "❌ Endpoint not found: " + uri);
                    return createErrorResponse(
                            Response.Status.NOT_FOUND, "Endpoint not found: " + uri);
                }
        }
    }

    /** Handle take picture request with proper response. */
    private Response handleTakePicture() {
        logger.debug(TAG, "📸 =========================================");
        logger.debug(TAG, "📸 TAKE PICTURE REQUEST HANDLER");
        logger.debug(TAG, "📸 =========================================");

        if (pictureRequestListener != null) {
            logger.debug(TAG, "📸 ✅ Picture listener available, triggering photo capture");
            pictureRequestListener.onPictureRequest();
            logger.debug(TAG, "📸 ✅ Photo capture request sent successfully");

            Map<String, Object> data = new HashMap<>();
            data.put("message", "Picture request received");
            data.put("timestamp", System.currentTimeMillis());
            return createSuccessResponse(data);
        } else {
            logger.error(TAG, "📸 ❌ Picture listener not available");
            return createErrorResponse(
                    Response.Status.SERVICE_UNAVAILABLE, "Picture listener not available");
        }
    }

    /** Serve the latest photo using the file management system. */
    private Response serveLatestPhoto() {
        logger.debug(TAG, "🖼️ =========================================");
        logger.debug(TAG, "🖼️ LATEST PHOTO REQUEST HANDLER");
        logger.debug(TAG, "🖼️ =========================================");

        try {
            // Get latest photo metadata
            FileMetadata latestPhoto = getLatestPhotoMetadata();
            if (latestPhoto == null) {
                logger.warn(TAG, "🖼️ ❌ No photo taken yet");
                return createErrorResponse(Response.Status.NOT_FOUND, "No photo taken yet");
            }

            // Get the file using FileManager
            File photoFile =
                    fileManager.getFile(
                            fileManager.getDefaultPackageName(), latestPhoto.getFileName());
            if (photoFile == null || !photoFile.exists()) {
                logger.warn(TAG, "🖼️ ❌ Photo file not found");
                return createErrorResponse(Response.Status.NOT_FOUND, "Photo file not found");
            }

            // Check cache first
            String cacheKey = "latest_" + latestPhoto.getLastModified();
            Object cachedData = cacheManager.get(cacheKey);

            if (cachedData != null) {
                byte[] cachedBytes = (byte[]) cachedData;
                logger.debug(
                        TAG,
                        "🖼️ ✅ Serving latest photo from cache (" + cachedBytes.length + " bytes)");
                return newChunkedResponse(
                        Response.Status.OK,
                        "image/jpeg",
                        new java.io.ByteArrayInputStream(cachedBytes));
            }

            // For small files, read into memory and cache; for large files, stream directly
            long fileLength = photoFile.length();
            if (fileLength <= MAX_FILE_SIZE) {
                logger.debug(TAG, "🖼️ 📖 Reading photo file from disk for caching...");
                try (FileInputStream fis = new FileInputStream(photoFile)) {
                    byte[] fileData;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        fileData = fis.readAllBytes();
                    } else {
                        fileData = new byte[(int) fileLength];
                        new DataInputStream(fis).readFully(fileData);
                    }
                    logger.debug(
                            TAG, "🖼️ 📖 File read successfully: " + fileData.length + " bytes");

                    logger.debug(TAG, "🖼️ 💾 Caching photo data...");
                    cacheManager.put(cacheKey, fileData, 300000); // Cache for 5 minutes

                    logger.debug(
                            TAG,
                            "🖼️ ✅ Serving latest photo: "
                                    + latestPhoto.getFileName()
                                    + " ("
                                    + fileData.length
                                    + " bytes)");
                    return newChunkedResponse(
                            Response.Status.OK,
                            "image/jpeg",
                            new java.io.ByteArrayInputStream(fileData));
                }
            } else {
                // Stream large files directly without loading into memory
                logger.debug(TAG, "🖼️ 📖 Streaming large photo file: " + fileLength + " bytes");
                BufferedInputStream bis =
                        new BufferedInputStream(new FileInputStream(photoFile), 65536);
                return newChunkedResponse(Response.Status.OK, "image/jpeg", bis);
            }
        } catch (Exception e) {
            logger.error(TAG, "🖼️ 💥 Error reading latest photo: " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error reading photo file");
        }
    }

    /** Serve gallery listing using the file management system. */
    private Response serveGallery() {
        logger.debug(TAG, "📚 Gallery request started");
        return serveGalleryWithParams(null);
    }

    /** Serve gallery listing with pagination support. */
    private Response serveGallery(IHTTPSession session) {
        logger.debug(TAG, "📚 Gallery request started with params");
        return serveGalleryWithParams(session);
    }

    /** Internal method to serve gallery with optional pagination parameters. */
    private Response serveGalleryWithParams(IHTTPSession session) {
        long startTime = System.currentTimeMillis();
        long timeoutMs = 5000; // 5 second timeout for gallery requests

        // Parse pagination parameters
        int limit = 0; // 0 means no limit (return all)
        int offset = 0;

        if (session != null) {
            Map<String, String> params = session.getParms();
            String limitParam = params.get("limit");
            String offsetParam = params.get("offset");

            if (limitParam != null && !limitParam.isEmpty()) {
                try {
                    limit = Integer.parseInt(limitParam);
                    limit = Math.max(0, Math.min(limit, 100)); // Cap at 100 items per request
                    logger.debug(TAG, "📚 Pagination limit: " + limit);
                } catch (NumberFormatException e) {
                    logger.warn(TAG, "📚 Invalid limit parameter: " + limitParam);
                }
            }

            if (offsetParam != null && !offsetParam.isEmpty()) {
                try {
                    offset = Integer.parseInt(offsetParam);
                    offset = Math.max(0, offset);
                    logger.debug(TAG, "📚 Pagination offset: " + offset);
                } catch (NumberFormatException e) {
                    logger.warn(TAG, "📚 Invalid offset parameter: " + offsetParam);
                }
            }
        }

        try {
            // Get all photos using FileManager with timeout
            List<FileMetadata> photoMetadataList =
                    fileManager.listFiles(fileManager.getDefaultPackageName());

            long fetchTime = System.currentTimeMillis() - startTime;
            logger.debug(
                    TAG,
                    "📚 Found "
                            + photoMetadataList.size()
                            + " total photos in "
                            + fetchTime
                            + "ms");

            if (photoMetadataList.isEmpty()) {
                logger.debug(TAG, "📚 No photos found, returning empty gallery");
                Map<String, Object> data = new HashMap<>();
                data.put("photos", new ArrayList<>());
                data.put("total_count", 0);
                data.put("total_size", 0);
                data.put("has_more", false);
                return createSuccessResponse(data);
            }

            // Check timeout before processing
            if (System.currentTimeMillis() - startTime > timeoutMs) {
                logger.warn(
                        TAG,
                        "📚 Gallery request timeout after "
                                + (System.currentTimeMillis() - startTime)
                                + "ms");
                return createErrorResponse(
                        Response.Status.REQUEST_TIMEOUT, "Gallery request timeout");
            }

            // Filter BEFORE pagination so pages have a consistent size and total_count
            // reflects only files that will actually be served.
            List<FileMetadata> servableList = new ArrayList<>(photoMetadataList.size());
            for (FileMetadata photoMetadata : photoMetadataList) {
                if (isAvifTransferArtifact(photoMetadata.getFileName())) {
                    logger.debug(
                            TAG,
                            "📚 Skipping AVIF transfer artifact in gallery: "
                                    + photoMetadata.getFileName());
                    continue;
                }
                if (isImuSidecar(photoMetadata.getFileName())) {
                    continue;
                }
                if (isHdrBracket(photoMetadata.getFileName())) {
                    continue;
                }
                if (!shouldExposeServableFile(photoMetadata)) {
                    continue;
                }
                servableList.add(photoMetadata);
            }

            // Sort by modification time (newest first) BEFORE pagination
            servableList.sort((a, b) -> Long.compare(b.getLastModified(), a.getLastModified()));

            // Apply pagination on the filtered list
            int totalCount = servableList.size();
            int endIndex = (limit > 0) ? Math.min(offset + limit, totalCount) : totalCount;
            int actualOffset = Math.min(offset, totalCount);

            List<FileMetadata> paginatedList = servableList.subList(actualOffset, endIndex);
            boolean hasMore = endIndex < totalCount;

            logger.debug(
                    TAG,
                    "📚 Returning photos "
                            + actualOffset
                            + " to "
                            + endIndex
                            + " of "
                            + totalCount);

            List<Map<String, Object>> photos = new ArrayList<>();
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US);
            long totalSize = 0;
            long paginatedSize = 0;

            // Calculate total size (for all servable photos)
            for (FileMetadata metadata : servableList) {
                totalSize += metadata.getFileSize();
            }

            // Process only the paginated subset
            for (FileMetadata photoMetadata : paginatedList) {
                // Check timeout during processing
                if (System.currentTimeMillis() - startTime > timeoutMs) {
                    logger.warn(
                            TAG,
                            "📚 Gallery processing timeout after "
                                    + (System.currentTimeMillis() - startTime)
                                    + "ms");
                    return createErrorResponse(
                            Response.Status.REQUEST_TIMEOUT, "Gallery processing timeout");
                }

                Map<String, Object> photoInfo = new HashMap<>();
                photoInfo.put("name", photoMetadata.getFileName());
                photoInfo.put("size", photoMetadata.getFileSize());
                photoInfo.put("modified", sdf.format(new Date(photoMetadata.getLastModified())));
                photoInfo.put("mime_type", photoMetadata.getMimeType());
                photoInfo.put("url", "/api/photo?file=" + photoMetadata.getFileName());
                photoInfo.put("download", "/api/download?file=" + photoMetadata.getFileName());

                // Originating SDK requestId embedded in the capture directory name, when present.
                String photoRequestId =
                        CaptureRequestId.extractFromCaptureId(
                                deriveCaptureId(photoMetadata.getFileName()));
                if (photoRequestId != null) {
                    photoInfo.put("request_id", photoRequestId);
                }

                // Add video-specific information
                if (isVideoFile(photoMetadata.getFileName())) {
                    photoInfo.put("is_video", true);
                    photoInfo.put(
                            "thumbnail_url", "/api/photo?file=" + photoMetadata.getFileName());
                } else {
                    photoInfo.put("is_video", false);
                }

                photos.add(photoInfo);
                paginatedSize += photoMetadata.getFileSize();
            }

            long totalTime = System.currentTimeMillis() - startTime;
            logger.debug(
                    TAG,
                    "📚 Gallery served successfully with "
                            + photos.size()
                            + " photos (of "
                            + totalCount
                            + " total) in "
                            + totalTime
                            + "ms");

            Map<String, Object> data = new HashMap<>();
            data.put("photos", photos);
            data.put("total_count", totalCount); // Total number of all photos
            data.put("returned_count", photos.size()); // Number returned in this response
            data.put("total_size", totalSize); // Total size of all photos
            data.put("returned_size", paginatedSize); // Size of returned photos
            data.put("offset", actualOffset);
            data.put("limit", limit);
            data.put("has_more", hasMore);
            data.put("package_name", fileManager.getDefaultPackageName());
            data.put("processing_time_ms", totalTime);

            // Add keep-alive headers for gallery responses too
            Response response = createSuccessResponse(data);
            response.addHeader("Connection", "keep-alive");
            response.addHeader("Keep-Alive", "timeout=300, max=100");
            return response;
        } catch (Exception e) {
            long totalTime = System.currentTimeMillis() - startTime;
            logger.error(
                    TAG,
                    "📚 Error serving gallery after " + totalTime + "ms: " + e.getMessage(),
                    e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error reading gallery");
        }
    }

    /**
     * Serve a specific photo or video thumbnail by filename using the file management system. For
     * videos, this endpoint serves thumbnails instead of the full video file.
     */
    private Response servePhoto(IHTTPSession session) {
        logger.debug(TAG, "🖼️ Photo/Video request started");

        Map<String, String> params = session.getParms();
        String filename = params.get("file");

        logger.debug(TAG, "🖼️ Requested filename: " + filename);

        if (filename == null || filename.isEmpty()) {
            logger.warn(TAG, "🖼️ File parameter missing or empty");
            return createErrorResponse(Response.Status.BAD_REQUEST, "File parameter required");
        }

        try {
            // Get file using FileManager (security validation is handled automatically)
            File mediaFile = fileManager.getFile(fileManager.getDefaultPackageName(), filename);
            if (mediaFile == null || !mediaFile.exists()) {
                logger.warn(TAG, "🖼️ Media file not found: " + filename);
                return createErrorResponse(Response.Status.NOT_FOUND, "Media file not found");
            }

            // Get metadata for MIME type
            FileMetadata metadata =
                    fileManager.getFileMetadata(fileManager.getDefaultPackageName(), filename);
            String mimeType = metadata != null ? metadata.getMimeType() : "image/jpeg";

            // Check if it's a video file - serve thumbnail instead of full video
            if (isVideoFile(filename)) {
                logger.debug(TAG, "🎥 Video file detected: " + filename);
                return serveVideoThumbnail(mediaFile, filename);
            } else {
                logger.debug(TAG, "🖼️ Image file detected: " + filename);
                return serveImageFile(mediaFile, filename, mimeType);
            }
        } catch (Exception e) {
            logger.error(
                    TAG, "🖼️ Error reading media file " + filename + ": " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error reading media file");
        }
    }

    /** Serve video thumbnail */
    private Response serveVideoThumbnail(File videoFile, String filename) {
        logger.debug(TAG, "🎥 Generating/serving thumbnail for video: " + filename);

        try {
            // Get or create thumbnail
            File thumbnailFile = fileManager.getThumbnailManager().getOrCreateThumbnail(videoFile);

            if (thumbnailFile == null || !thumbnailFile.exists()) {
                logger.warn(TAG, "🎥 Failed to generate thumbnail for video: " + filename);
                return createErrorResponse(
                        Response.Status.INTERNAL_ERROR, "Failed to generate video thumbnail");
            }

            // Use fixed-length response so clients can validate download integrity
            long thumbSize = thumbnailFile.length();
            logger.debug(
                    TAG,
                    "🎥 Streaming video thumbnail: " + filename + " (" + thumbSize + " bytes)");
            BufferedInputStream bis =
                    new BufferedInputStream(new FileInputStream(thumbnailFile), 65536);
            Response response =
                    newFixedLengthResponse(Response.Status.OK, "image/jpeg", bis, thumbSize);
            response.addHeader("Content-Length", String.valueOf(thumbSize));
            return response;
        } catch (Exception e) {
            logger.error(
                    TAG, "🎥 Error serving video thumbnail " + filename + ": " + e.getMessage(), e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Error serving video thumbnail");
        }
    }

    /** Serve image file */
    private Response serveImageFile(File imageFile, String filename, String mimeType) {
        logger.debug(
                TAG,
                "🖼️ Streaming image file: " + filename + " (" + imageFile.length() + " bytes)");

        try {
            // Use fixed-length response with Content-Length so clients can validate
            // integrity after download. Chunked responses lack Content-Length, which
            // means a graceful TCP close mid-transfer looks identical to a completed
            // download on Android (HttpURLConnection treats EOF as success).
            long fileSize = imageFile.length();
            BufferedInputStream bis =
                    new BufferedInputStream(new FileInputStream(imageFile), 65536);
            Response response = newFixedLengthResponse(Response.Status.OK, mimeType, bis, fileSize);
            response.addHeader("Content-Length", String.valueOf(fileSize));
            return response;
        } catch (Exception e) {
            logger.error(
                    TAG, "🖼️ Error reading image file " + filename + ": " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error reading image file");
        }
    }

    /** Check if a file is a video file */
    private boolean isVideoFile(String filename) {
        if (filename == null) return false;

        String lowerFilename = filename.toLowerCase();
        return lowerFilename.endsWith(".mp4")
                || lowerFilename.endsWith(".avi")
                || lowerFilename.endsWith(".mov")
                || lowerFilename.endsWith(".wmv")
                || lowerFilename.endsWith(".flv")
                || lowerFilename.endsWith(".webm")
                || lowerFilename.endsWith(".mkv")
                || lowerFilename.endsWith(".3gp");
    }

    /**
     * Derive a capture ID from a filename. Groups related files together. Examples:
     * "IMG_xxx/base.jpg" -> "IMG_xxx" "IMG_xxx/ev-2.jpg" -> "IMG_xxx" "IMG_xxx/imu.json" ->
     * "IMG_xxx" "IMG_xxx.jpg" -> "IMG_xxx" (legacy flat file) "IMG_xxx_ev-2.jpg" -> "IMG_xxx"
     * (legacy bracket) "IMG_xxx.imu.json" -> "IMG_xxx" (legacy sidecar) "VID_xxx/base.mp4" ->
     * "VID_xxx"
     */
    private String deriveCaptureId(String name) {
        if (name == null) return "unknown";

        // Folder-based: take everything before the first '/'
        if (name.contains("/")) {
            return name.substring(0, name.indexOf('/'));
        }

        // Legacy flat file: strip extension and known suffixes
        String stem = name;

        // Strip .imu.json first (before generic extension strip)
        if (stem.toLowerCase().endsWith(".imu.json")) {
            stem = stem.substring(0, stem.length() - ".imu.json".length());
            return stem;
        }

        // Strip file extension
        int dotIdx = stem.lastIndexOf('.');
        if (dotIdx > 0) {
            stem = stem.substring(0, dotIdx);
        }

        // Strip HDR bracket suffix (e.g. _ev-2, _ev0, _ev2)
        stem = stem.replaceAll("_ev-?\\d+$", "");

        return stem;
    }

    /**
     * Assign a role to a file within a capture group.
     *
     * @param fileName The full relative filename (e.g. "IMG_xxx/base.jpg" or "IMG_xxx.jpg")
     * @return "primary", "bracket", or "sidecar"
     */
    private String assignFileRole(String fileName) {
        if (fileName == null) return "primary";

        // Get just the leaf filename
        String leaf =
                fileName.contains("/")
                        ? fileName.substring(fileName.lastIndexOf('/') + 1)
                        : fileName;
        String lower = leaf.toLowerCase();

        // Sidecar files
        if (lower.equals("imu.json") || lower.endsWith(".imu.json")) return "sidecar";

        // Bracket files (ev-2.jpg, ev0.jpg, ev2.jpg)
        if (lower.matches("ev-?\\d+\\.jpe?g") || lower.matches(".*_ev-?\\d+\\.jpe?g")) {
            return "bracket";
        }

        // Everything else is primary
        return "primary";
    }

    /**
     * Check if a file is an AVIF transfer artifact that should be excluded from sync AVIF files are
     * temporary transfer artifacts created during BLE photo transfers and should not be synced to
     * mobile devices.
     */
    /**
     * Check if a file is an IMU sidecar (sensor data bundled with media capture). These are
     * metadata files, not displayable media.
     */
    private boolean isImuSidecar(String filename) {
        if (filename == null) return false;
        String leaf =
                filename.contains("/")
                        ? filename.substring(filename.lastIndexOf('/') + 1)
                        : filename;
        return leaf.equalsIgnoreCase("imu.json");
    }

    /**
     * Check if a file is an HDR bracket (individual exposure in a burst set). Only the merged base
     * file should appear in the gallery, not individual brackets.
     */
    private boolean isHdrBracket(String filename) {
        if (filename == null) return false;
        String leaf =
                filename.contains("/")
                        ? filename.substring(filename.lastIndexOf('/') + 1)
                        : filename;
        // Match folder-based bracket files: ev-2.jpg, ev0.jpg, ev2.jpg
        return leaf.toLowerCase().matches("ev-?\\d+\\.jpe?g");
    }

    private boolean isAvifTransferArtifact(String filename) {
        if (filename == null || filename.isEmpty()) {
            logger.debug(TAG, "🔄 File is null or empty, returning false");
            return false;
        }

        logger.debug(TAG, "🔄 Checking if file is an AVIF transfer artifact: " + filename);

        // AVIF transfer artifacts have specific naming patterns:
        // 1. Files without extensions (BLE limitation) - pattern: "I" + digits or "ble_" + digits
        // 2. Files with .avif extension
        // 3. Files matching BLE image ID patterns

        String lowerFilename = filename.toLowerCase();

        // Check for .avif extension
        if (lowerFilename.endsWith(".avif") || lowerFilename.endsWith(".avifs")) {
            logger.debug(TAG, "🔄 Detected AVIF by extension: " + filename);
            return true;
        }

        // Check for BLE transfer patterns (no extension due to 16-char limit)
        // Pattern 1: "I" followed by digits (e.g., "I634744046")
        if (filename.matches("^I\\d+$")) {
            logger.debug(TAG, "🔄 Detected AVIF by BLE ID pattern (I+digits): " + filename);
            return true;
        }

        // Pattern 2: "ble_" followed by digits (e.g., "ble_1234567890")
        if (filename.matches("^ble_\\d+$")) {
            logger.debug(
                    TAG, "🔄 Detected AVIF by BLE transfer pattern (ble_+digits): " + filename);
            return true;
        }

        // Pattern 3: Files that are just digits (potential BLE image IDs)
        if (filename.matches("^\\d+$")) {
            logger.debug(TAG, "🔄 Detected AVIF by pure digit pattern: " + filename);
            return true;
        }

        // Check file content signature for AVIF detection
        if (hasAvifSignature(filename)) {
            logger.debug(TAG, "🔄 Detected AVIF by content signature: " + filename);
            return true;
        }

        return false;
    }

    /**
     * Check if a file has AVIF signature by reading file content AVIF files start with ISOBMFF
     * container format and have "ftypavif" signature
     */
    private boolean hasAvifSignature(String filename) {
        try {
            // Get the file from the file manager
            File file = fileManager.getFile(fileManager.getDefaultPackageName(), filename);
            if (file == null || !file.exists()) {
                logger.debug(TAG, "🔄 File not found for signature check: " + filename);
                return false;
            }

            // Read first 20 bytes to check file signature
            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] header = new byte[20];
                int bytesRead = fis.read(header);

                if (bytesRead < 12) {
                    logger.debug(TAG, "🔄 File too small for AVIF signature check: " + filename);
                    return false;
                }

                // Check for AVIF signature at positions 4-12
                // AVIF files have "ftypavif" signature in ISOBMFF container
                String signature = new String(header, 4, 8, StandardCharsets.UTF_8);

                if ("ftypavif".equals(signature)) {
                    logger.debug(TAG, "🔄 AVIF signature detected in file: " + filename);
                    return true;
                }

                logger.debug(
                        TAG,
                        "🔄 No AVIF signature found in file: "
                                + filename
                                + " (signature: "
                                + signature
                                + ")");
                return false;
            }

        } catch (Exception e) {
            logger.warn(
                    TAG,
                    "🔄 Error checking AVIF signature for file: "
                            + filename
                            + " - "
                            + e.getMessage());
            return false;
        }
    }

    /** Serve photo download with proper headers using the file management system. */
    private Response serveDownload(IHTTPSession session) {
        Map<String, String> params = session.getParms();
        String filename = params.get("file");

        if (filename == null || filename.isEmpty()) {
            logger.warn(TAG, "⬇️ ❌ File parameter missing or empty");
            return createErrorResponse(Response.Status.BAD_REQUEST, "File parameter required");
        }

        // Block downloads of files that are actively being recorded
        if (isActiveRecording(filename)) {
            logger.warn(TAG, "⬇️ ❌ Blocked download of in-progress recording: " + filename);
            return createErrorResponse(
                    Response.Status.FORBIDDEN, "File is currently being recorded");
        }

        try {
            // Get file using FileManager (security validation is handled automatically)
            File photoFile = fileManager.getFile(fileManager.getDefaultPackageName(), filename);
            if (photoFile == null || !photoFile.exists()) {
                logger.warn(TAG, "⬇️ ❌ Photo file not found: " + filename);
                return createErrorResponse(Response.Status.NOT_FOUND, "Photo not found");
            }

            FileMetadata downloadMetadata =
                    fileManager.getFileMetadata(fileManager.getDefaultPackageName(), filename);
            if (downloadMetadata != null && !shouldExposeServableFile(downloadMetadata)) {
                logger.warn(TAG, "⬇️ ❌ Blocked download of unservable file: " + filename);
                return createErrorResponse(
                        Response.Status.CONFLICT, "File is not ready for download");
            }
            if (GallerySyncFilter.isZeroBytePrimaryVideo(filename, photoFile.length())) {
                logger.warn(TAG, "⬇️ ❌ Blocked download of zero-byte video: " + filename);
                return createErrorResponse(Response.Status.CONFLICT, "Video file is not ready");
            }

            FileMetadata metadata =
                    fileManager.getFileMetadata(fileManager.getDefaultPackageName(), filename);
            String mimeType = metadata != null ? metadata.getMimeType() : "image/jpeg";
            long fileLength = photoFile.length();
            String etag =
                    GalleryTransferProtocol.createEtag(
                            filename, photoFile.length(), photoFile.lastModified());
            String rangeHeader = session.getHeaders().get("range");
            String ifRange = session.getHeaders().get("if-range");
            if (ifRange != null && !ifRange.trim().equals(etag)) {
                rangeHeader = null;
            }

            GalleryTransferProtocol.ByteRange range;
            try {
                range = GalleryTransferProtocol.parseRange(rangeHeader, fileLength);
            } catch (IllegalArgumentException e) {
                Response response =
                        createErrorResponse(
                                Response.Status.RANGE_NOT_SATISFIABLE, "Unsatisfiable byte range");
                response.addHeader("Content-Range", "bytes */" + fileLength);
                response.addHeader("Accept-Ranges", "bytes");
                response.addHeader("ETag", etag);
                return response;
            }

            long start = range != null ? range.start : 0;
            long length = range != null ? range.length() : fileLength;
            Response.Status status =
                    range != null ? Response.Status.PARTIAL_CONTENT : Response.Status.OK;
            InputStream stream = GalleryTransferProtocol.open(photoFile, start, length);
            Response response = newFixedLengthResponse(status, mimeType, stream, length);
            response.addHeader(
                    "Content-Disposition",
                    "attachment; filename=\"" + new File(filename).getName() + "\"");
            response.addHeader("Accept-Ranges", "bytes");
            response.addHeader("ETag", etag);
            response.addHeader("X-Content-Type-Options", "nosniff");
            if (range != null) {
                response.addHeader(
                        "Content-Range",
                        "bytes " + range.start + "-" + range.end + "/" + fileLength);
            }
            logger.debug(
                    TAG,
                    "⬇️ Serving "
                            + filename
                            + " bytes "
                            + start
                            + "-"
                            + (start + length - 1)
                            + "/"
                            + fileLength);
            return response;
        } catch (Exception e) {
            logger.error(
                    TAG, "⬇️ 💥 Error downloading photo " + filename + ": " + e.getMessage(), e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Error downloading photo file");
        }
    }

    /** Serve cleanup request to remove old photos. */
    private Response serveCleanup(IHTTPSession session) {
        logger.debug(TAG, "🧹 =========================================");
        logger.debug(TAG, "🧹 CLEANUP REQUEST HANDLER");
        logger.debug(TAG, "🧹 =========================================");

        Map<String, String> params = session.getParms();
        String maxAgeParam = params.get("max_age_hours");

        // Default to 24 hours if not specified
        long maxAgeHours = 24;
        if (maxAgeParam != null && !maxAgeParam.isEmpty()) {
            try {
                maxAgeHours = Long.parseLong(maxAgeParam);
            } catch (NumberFormatException e) {
                logger.warn(TAG, "🧹 ❌ Invalid max_age_hours parameter: " + maxAgeParam);
                return createErrorResponse(
                        Response.Status.BAD_REQUEST, "Invalid max_age_hours parameter");
            }
        }

        long maxAgeMs = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds

        try {
            // Cleanup is restricted to already-acknowledged recoverable trash. Live captures are
            // never age-deleted because a failed phone sync must leave its source retryable.
            long effectiveAgeMs = Math.max(maxAgeMs, MIN_TRASH_RETENTION_MS);
            int captureCleanedCount = galleryTrashManager.garbageCollect(effectiveAgeMs);

            // Preserve the non-gallery maintenance performed by the legacy endpoint. SDK no-save
            // uploads live under a dedicated hidden tree, so orphan cleanup can be scoped there
            // without age-deleting live captures or bypassing recoverable-trash retention.
            int pendingCleanedCount =
                    fileManager.cleanupOldSdkPendingFiles(
                            fileManager.getDefaultPackageName(), maxAgeMs);
            int thumbnailCleanedCount =
                    fileManager.getThumbnailManager().cleanupOldThumbnails(maxAgeMs);
            int cleanedCount = captureCleanedCount + pendingCleanedCount;

            logger.debug(
                    TAG,
                    "🧹 ✅ Cleanup completed: "
                            + captureCleanedCount
                            + " acknowledged captures permanently removed, "
                            + pendingCleanedCount
                            + " pending SDK files removed, and "
                            + thumbnailCleanedCount
                            + " thumbnails removed");

            Map<String, Object> data = new HashMap<>();
            data.put("message", "Cleanup completed successfully");
            data.put("files_removed", cleanedCount);
            data.put("captures_removed", captureCleanedCount);
            data.put("pending_files_removed", pendingCleanedCount);
            data.put("thumbnails_removed", thumbnailCleanedCount);
            data.put("max_age_hours", maxAgeHours);
            data.put("effective_retention_hours", effectiveAgeMs / (60 * 60 * 1000));
            data.put("timestamp", System.currentTimeMillis());

            return createSuccessResponse(data);
        } catch (Exception e) {
            logger.error(TAG, "🧹 💥 Error during cleanup: " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error during cleanup");
        }
    }

    /**
     * Serve delete files request to remove specific files. Accepts POST request with JSON body:
     * {"files": ["file1.jpg", "file2.jpg"]}
     */
    private Response serveDeleteFiles(IHTTPSession session) {
        if (!"POST".equals(session.getMethod().name())) {
            return createErrorResponse(
                    Response.Status.METHOD_NOT_ALLOWED, "Only POST method is allowed");
        }

        try {
            JSONObject request = readJsonBody(session);
            JSONArray files = request.getJSONArray("files");
            if (files.length() == 0) {
                return createErrorResponse(
                        Response.Status.BAD_REQUEST, "Files array cannot be empty");
            }

            String legacyAckId =
                    "legacy-" + request.optString("client_id", "unknown") + "-" + UUID.randomUUID();
            Map<String, GalleryTrashManager.Result> captureResults = new LinkedHashMap<>();
            List<Map<String, Object>> results = new ArrayList<>();
            int successCount = 0;
            int failureCount = 0;
            long totalTrashedSize = 0;

            for (int i = 0; i < files.length(); i++) {
                String requestedName = files.optString(i, "").trim();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("file", requestedName);
                if (requestedName.isEmpty()) {
                    item.put("success", false);
                    item.put("message", "Empty filename");
                    failureCount++;
                    results.add(item);
                    continue;
                }

                String captureId = GallerySyncFilter.deriveCaptureId(requestedName);
                GalleryTrashManager.Result result = captureResults.get(captureId);
                if (result == null) {
                    result = galleryTrashManager.trashCapture(captureId, legacyAckId);
                    captureResults.put(captureId, result);
                    if (result.success && !result.alreadyTrashed) {
                        totalTrashedSize += result.totalSize;
                    }
                }

                item.put("capture_id", captureId);
                item.put("success", result.success);
                item.put("recoverable", result.success);
                item.put("already_trashed", result.alreadyTrashed);
                item.put("message", result.message);
                item.put("size", result.totalSize);
                if (result.success) {
                    successCount++;
                } else {
                    failureCount++;
                }
                results.add(item);
            }

            Map<String, Object> responseData = new LinkedHashMap<>();
            // Preserve the legacy response shape even though delete now means recoverable trash.
            responseData.put("message", "File deletion completed");
            responseData.put("total_files", files.length());
            responseData.put("successful_deletions", successCount);
            responseData.put("failed_deletions", failureCount);
            responseData.put("total_deleted_size", totalTrashedSize);
            responseData.put("recoverable", true);
            responseData.put("results", results);
            responseData.put("timestamp", System.currentTimeMillis());
            garbageCollectGalleryTrashBestEffort();
            return createSuccessResponse(responseData);
        } catch (JSONException | IllegalArgumentException e) {
            logger.warn(TAG, "🗑️ Invalid delete request: " + e.getMessage());
            return createErrorResponse(Response.Status.BAD_REQUEST, "Invalid delete request");
        } catch (IOException e) {
            logger.error(TAG, "🗑️ Unable to move capture to trash", e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Unable to move capture to recoverable trash");
        }
    }

    /** Serve enhanced server status information with file management metrics. */
    private Response serveStatus() {
        logger.debug(TAG, "📊 =========================================");
        logger.debug(TAG, "📊 STATUS REQUEST HANDLER");
        logger.debug(TAG, "📊 =========================================");

        try {
            Map<String, Object> status = new HashMap<>();
            status.put("server", "CameraWebServer");
            status.put("port", getListeningPort());
            status.put("uptime", System.currentTimeMillis() - getStartTime());
            status.put("cache_size", cacheManager.size());
            status.put("server_url", getServerUrl());

            // File management metrics
            status.put("package_name", fileManager.getDefaultPackageName());
            status.put(
                    "total_photos",
                    fileManager.listFiles(fileManager.getDefaultPackageName()).size());
            status.put(
                    "package_size",
                    fileManager.getPackageSize(fileManager.getDefaultPackageName()));
            status.put("available_space", fileManager.getAvailableSpace());
            status.put("total_space", fileManager.getTotalSpace());

            // Thumbnail metrics
            status.put("thumbnail_count", fileManager.getThumbnailManager().getThumbnailCount());
            status.put(
                    "thumbnail_directory_size",
                    fileManager.getThumbnailManager().getThumbnailDirectorySize());

            // Performance metrics from file manager
            var performanceStats = fileManager.getOperationLogger().getPerformanceStats();
            status.put("file_operations_total", performanceStats.totalOperations);
            status.put("file_operations_success_rate", performanceStats.successRate);
            status.put("file_operations_bytes_processed", performanceStats.totalBytesProcessed);

            logger.debug(TAG, "📊 📈 Server port: " + getListeningPort());
            logger.debug(TAG, "📊 📈 Cache size: " + cacheManager.size());
            logger.debug(TAG, "📊 📈 Total photos: " + status.get("total_photos"));
            logger.debug(TAG, "📊 📈 Package size: " + status.get("package_size") + " bytes");
            logger.debug(TAG, "📊 📈 Available space: " + status.get("available_space") + " bytes");
            logger.debug(TAG, "📊 📈 Thumbnail count: " + status.get("thumbnail_count"));
            logger.debug(
                    TAG,
                    "📊 📈 Thumbnail directory size: "
                            + status.get("thumbnail_directory_size")
                            + " bytes");
            logger.debug(TAG, "📊 📈 Success rate: " + performanceStats.successRate + "%");

            logger.debug(TAG, "📊 ✅ Status served successfully");
            return createSuccessResponse(status);
        } catch (Exception e) {
            logger.error(TAG, "📊 💥 Error serving status: " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error getting status");
        }
    }

    /** Serve health check endpoint. */
    private Response serveHealth() {
        logger.debug(TAG, "❤️ =========================================");
        logger.debug(TAG, "❤️ HEALTH CHECK REQUEST HANDLER");
        logger.debug(TAG, "❤️ =========================================");

        long timestamp = System.currentTimeMillis();
        logger.debug(TAG, "❤️ ✅ Health check passed at timestamp: " + timestamp);

        return newFixedLengthResponse(
                Response.Status.OK,
                "application/json",
                "{\"status\":\"healthy\",\"timestamp\":" + timestamp + "}");
    }

    /** Serve the enhanced index page with gallery and better UI. */
    private Response serveIndexPage() {
        logger.debug(TAG, "📄 =========================================");
        logger.debug(TAG, "📄 INDEX PAGE REQUEST HANDLER");
        logger.debug(TAG, "📄 =========================================");

        try {
            logger.debug(TAG, "📄 📖 Reading index.html from assets...");
            InputStream inputStream = config.getContext().getAssets().open("index.html");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            int nRead;
            byte[] data = new byte[1024];
            while ((nRead = inputStream.read(data, 0, data.length)) != -1) {
                buffer.write(data, 0, nRead);
            }
            buffer.flush();

            String html = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            logger.debug(
                    TAG, "📄 📖 HTML file read successfully: " + html.length() + " characters");

            // Replace placeholders with dynamic content
            String serverUrl = getServerUrl();
            String serverPort = String.valueOf(getListeningPort());

            logger.debug(TAG, "📄 🔄 Replacing placeholders...");
            logger.debug(TAG, "📄 🔄 Server URL: " + serverUrl);
            logger.debug(TAG, "📄 🔄 Server Port: " + serverPort);

            String finalHtml =
                    html.replace("{{SERVER_URL}}", serverUrl)
                            .replace("{{SERVER_PORT}}", serverPort);

            logger.debug(TAG, "📄 ✅ Index page served successfully");
            logger.debug(TAG, "📄 📄 Final HTML size: " + finalHtml.length() + " characters");

            return newFixedLengthResponse(Response.Status.OK, "text/html", finalHtml);
        } catch (IOException e) {
            logger.error(TAG, "📄 💥 Error reading index.html from assets", e);
            return newFixedLengthResponse(
                    Response.Status.INTERNAL_ERROR, "text/plain", "Failed to load index.html");
        }
    }

    /** Get the latest photo metadata with caching. */
    private FileMetadata getLatestPhotoMetadata() {
        try {
            // Check if we have a cached latest photo
            if (latestPhotoMetadata != null) {
                // Verify it still exists
                if (fileManager.fileExists(
                        fileManager.getDefaultPackageName(), latestPhotoMetadata.getFileName())) {
                    return latestPhotoMetadata;
                }
            }

            // Get all photos and find the latest one
            List<FileMetadata> photos = fileManager.listFiles(fileManager.getDefaultPackageName());
            if (photos.isEmpty()) {
                return null;
            }

            // Sort by modification time (newest first) and return the latest
            photos.sort((a, b) -> Long.compare(b.getLastModified(), a.getLastModified()));
            latestPhotoMetadata = photos.get(0);

            return latestPhotoMetadata;
        } catch (Exception e) {
            logger.error(TAG, "Error getting latest photo metadata: " + e.getMessage(), e);
            return null;
        }
    }

    /** Get the FileManager instance for external access. */
    public FileManager getFileManager() {
        return fileManager;
    }

    public void setActiveRecordingProvider(ActiveRecordingProvider provider) {
        this.activeRecordingProvider = provider;
    }

    /**
     * @return true if the given file belongs to a capture that is currently being recorded. Derives
     *     the capture ID from the file name and compares against the active recording.
     */
    private boolean isActiveRecording(String fileName) {
        if (activeRecordingProvider == null || fileName == null) return false;
        String activeCaptureId = activeRecordingProvider.getActiveRecordingCaptureId();
        Set<String> blocked = activeRecordingProvider.getPendingVideoIntegrityCaptureIds();
        return GallerySyncFilter.isCaptureBlockedFromSync(fileName, activeCaptureId, blocked);
    }

    /** Whether a file may appear in gallery listings or sync responses. */
    private boolean shouldExposeServableFile(FileMetadata metadata) {
        if (metadata == null) {
            return false;
        }
        String fileName = metadata.getFileName();
        if (isActiveRecording(fileName)) {
            return false;
        }
        if (GallerySyncFilter.isZeroBytePrimaryVideo(fileName, metadata.getFileSize())) {
            logger.debug(TAG, "Skipping zero-byte primary video from sync/gallery: " + fileName);
            return false;
        }
        return true;
    }

    private Response serveGalleryCapabilities() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("api_version", 3);
        data.put("manifest_version", 3);
        data.put("range_downloads", true);
        data.put("fixed_length_downloads", true);
        data.put("etag", true);
        data.put("sha256", true);
        data.put("recoverable_trash", true);
        data.put("idempotent_ack", true);
        data.put("selected_capture", true);
        data.put("recommended_segment_bytes", 16 * 1024 * 1024);
        data.put("max_manifest_page_size", MAX_MANIFEST_PAGE_SIZE);
        data.put("server_time", System.currentTimeMillis());
        return createSuccessResponse(data);
    }

    /** Lightweight, newest-first manifest. Derived thumbnails and hashes stay lazy. */
    private Response serveV3Manifest(IHTTPSession session) {
        try {
            int limit = DEFAULT_MANIFEST_PAGE_SIZE;
            String limitValue = session.getParms().get("limit");
            if (limitValue != null) {
                limit = Integer.parseInt(limitValue);
            }
            limit = Math.max(1, Math.min(limit, MAX_MANIFEST_PAGE_SIZE));
            String cursor = session.getParms().get("cursor");
            String selectedCaptureId = session.getParms().get("capture_id");

            List<FileMetadata> files =
                    new ArrayList<>(fileManager.listFiles(fileManager.getDefaultPackageName()));
            files.removeIf(
                    metadata ->
                            !shouldExposeServableFile(metadata)
                                    || isAvifTransferArtifact(metadata.getFileName()));
            files.sort(
                    Comparator.comparingLong(FileMetadata::getLastModified)
                            .reversed()
                            .thenComparing(FileMetadata::getFileName, Comparator.reverseOrder()));

            Map<String, List<FileMetadata>> grouped = new HashMap<>();
            for (FileMetadata metadata : files) {
                grouped.computeIfAbsent(
                                GallerySyncFilter.deriveCaptureId(metadata.getFileName()),
                                ignored -> new ArrayList<>())
                        .add(metadata);
            }

            List<Map<String, Object>> allCaptures = new ArrayList<>();
            for (Map.Entry<String, List<FileMetadata>> entry : grouped.entrySet()) {
                String captureId = entry.getKey();
                if (selectedCaptureId != null && !selectedCaptureId.equals(captureId)) {
                    continue;
                }
                List<FileMetadata> captureFiles = entry.getValue();
                long timestamp =
                        captureFiles.stream()
                                .mapToLong(FileMetadata::getLastModified)
                                .max()
                                .orElse(0);
                long totalSize = 0;
                List<Map<String, Object>> manifestFiles = new ArrayList<>();
                String thumbnailUrl = null;
                boolean hasNonEmptyPrimary = false;
                boolean hasVideoPrimary = false;

                for (FileMetadata metadata : captureFiles) {
                    String encodedName =
                            URLEncoder.encode(
                                    metadata.getFileName(), StandardCharsets.UTF_8.name());
                    String role = assignFileRole(metadata.getFileName());
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("name", metadata.getFileName());
                    item.put("size", metadata.getFileSize());
                    item.put("modified", metadata.getLastModified());
                    item.put("mime_type", metadata.getMimeType());
                    item.put("role", role);
                    item.put(
                            "etag",
                            GalleryTransferProtocol.createEtag(
                                    metadata.getFileName(),
                                    metadata.getFileSize(),
                                    metadata.getLastModified()));
                    item.put("download_url", "/api/download?file=" + encodedName);
                    item.put("hash_url", "/api/v3/hash?file=" + encodedName);
                    manifestFiles.add(item);
                    totalSize += metadata.getFileSize();
                    if ("primary".equals(role)) {
                        hasNonEmptyPrimary |= metadata.getFileSize() > 0;
                        hasVideoPrimary |= isVideoFile(metadata.getFileName());
                        thumbnailUrl = "/api/photo?file=" + encodedName;
                    }
                }

                if (manifestFiles.isEmpty() || !hasNonEmptyPrimary) {
                    continue;
                }
                Map<String, Object> capture = new LinkedHashMap<>();
                capture.put("capture_id", captureId);
                capture.put("type", hasVideoPrimary ? "video" : "photo");
                capture.put("timestamp", timestamp);
                capture.put("total_size", totalSize);
                capture.put("files", manifestFiles);
                capture.put("cursor", manifestCursor(timestamp, captureId));
                if (thumbnailUrl != null) {
                    capture.put("thumbnail_url", thumbnailUrl);
                }
                String requestId = CaptureRequestId.extractFromCaptureId(captureId);
                if (requestId != null) {
                    capture.put("request_id", requestId);
                }
                allCaptures.add(capture);
            }

            allCaptures.sort(
                    (left, right) -> {
                        int timestampOrder =
                                Long.compare(
                                        ((Number) right.get("timestamp")).longValue(),
                                        ((Number) left.get("timestamp")).longValue());
                        if (timestampOrder != 0) {
                            return timestampOrder;
                        }
                        return ((String) right.get("capture_id"))
                                .compareTo((String) left.get("capture_id"));
                    });

            int start = 0;
            if (cursor != null && !cursor.isEmpty()) {
                int separator = cursor.indexOf(':');
                if (separator <= 0 || separator == cursor.length() - 1) {
                    throw new IllegalArgumentException("Invalid manifest cursor");
                }
                long cursorTimestamp = Long.parseLong(cursor.substring(0, separator));
                String cursorCaptureId = cursor.substring(separator + 1);
                // Keyset pagination stays stable if the cursor capture is acknowledged or a
                // newer capture appears between requests. Start at the first item strictly older
                // than the (timestamp, capture ID) key instead of searching for an exact row.
                while (start < allCaptures.size()) {
                    Map<String, Object> candidate = allCaptures.get(start);
                    long timestamp = ((Number) candidate.get("timestamp")).longValue();
                    String captureId = (String) candidate.get("capture_id");
                    if (timestamp < cursorTimestamp
                            || (timestamp == cursorTimestamp
                                    && captureId.compareTo(cursorCaptureId) < 0)) {
                        break;
                    }
                    start++;
                }
            }
            int end = Math.min(start + limit, allCaptures.size());
            List<Map<String, Object>> page =
                    start <= allCaptures.size()
                            ? new ArrayList<>(allCaptures.subList(start, end))
                            : Collections.emptyList();

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("api_version", 3);
            data.put("captures", page);
            data.put("has_more", end < allCaptures.size());
            data.put(
                    "next_cursor",
                    end < allCaptures.size() && !page.isEmpty()
                            ? page.get(page.size() - 1).get("cursor")
                            : JSONObject.NULL);
            data.put("total_count", allCaptures.size());
            data.put("server_time", System.currentTimeMillis());
            return createSuccessResponse(data);
        } catch (IllegalArgumentException e) {
            return createErrorResponse(Response.Status.BAD_REQUEST, e.getMessage());
        } catch (Exception e) {
            logger.error(TAG, "Unable to build v3 gallery manifest", e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Unable to build manifest");
        }
    }

    private Response serveV3Hash(IHTTPSession session) {
        String fileName = session.getParms().get("file");
        if (fileName == null || fileName.isEmpty()) {
            return createErrorResponse(Response.Status.BAD_REQUEST, "File parameter required");
        }
        if (isActiveRecording(fileName)) {
            return createErrorResponse(Response.Status.CONFLICT, "File is not ready");
        }
        try {
            File file = fileManager.getFile(fileManager.getDefaultPackageName(), fileName);
            if (file == null) {
                return createErrorResponse(Response.Status.NOT_FOUND, "File not found");
            }
            String etag =
                    GalleryTransferProtocol.createEtag(
                            fileName, file.length(), file.lastModified());
            String cacheKey = fileName + "\n" + etag;
            String hash = galleryHashCache.get(cacheKey);
            if (hash == null) {
                hash = GalleryTransferProtocol.sha256(file);
                galleryHashCache.put(cacheKey, hash);
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("file", fileName);
            data.put("size", file.length());
            data.put("etag", etag);
            data.put("sha256", hash);
            return createSuccessResponse(data);
        } catch (IOException e) {
            logger.error(TAG, "Unable to hash gallery file " + fileName, e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Unable to hash file");
        }
    }

    private Response serveV3Ack(IHTTPSession session) {
        if (!"POST".equals(session.getMethod().name())) {
            return createErrorResponse(
                    Response.Status.METHOD_NOT_ALLOWED, "Only POST method is allowed");
        }
        try {
            JSONObject request = readJsonBody(session);
            String captureId = request.getString("capture_id");
            String ackId = request.getString("ack_id");
            if (captureId.trim().isEmpty() || ackId.trim().isEmpty()) {
                throw new IllegalArgumentException("Capture and acknowledgement IDs are required");
            }
            GalleryTrashManager.Result result = galleryTrashManager.trashCapture(captureId, ackId);
            Map<String, Object> data = trashResultData(result);
            data.put("ack_id", ackId);
            garbageCollectGalleryTrashBestEffort();
            return createSuccessResponse(data);
        } catch (JSONException | IllegalArgumentException e) {
            return createErrorResponse(Response.Status.BAD_REQUEST, "Invalid acknowledgement");
        } catch (IOException e) {
            logger.error(TAG, "Unable to acknowledge gallery capture", e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Unable to acknowledge capture");
        }
    }

    private Response serveV3Trash() {
        try {
            List<Map<String, Object>> captures = new ArrayList<>();
            for (GalleryTrashManager.TrashedCapture trashed : galleryTrashManager.listTrashed()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("capture_id", trashed.captureId);
                item.put("file_count", trashed.fileCount);
                item.put("total_size", trashed.totalSize);
                item.put("trashed_at", trashed.trashedAt);
                captures.add(item);
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("captures", captures);
            data.put("total_count", captures.size());
            return createSuccessResponse(data);
        } catch (IOException e) {
            logger.error(TAG, "Unable to list gallery trash", e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Unable to list trash");
        }
    }

    private Response serveV3Restore(IHTTPSession session) {
        if (!"POST".equals(session.getMethod().name())) {
            return createErrorResponse(
                    Response.Status.METHOD_NOT_ALLOWED, "Only POST method is allowed");
        }
        try {
            JSONObject request = readJsonBody(session);
            GalleryTrashManager.Result result =
                    galleryTrashManager.restoreCapture(request.getString("capture_id"));
            if (!result.success) {
                return createErrorResponse(Response.Status.NOT_FOUND, result.message);
            }
            return createSuccessResponse(trashResultData(result));
        } catch (JSONException | IllegalArgumentException e) {
            return createErrorResponse(Response.Status.BAD_REQUEST, "Invalid restore request");
        } catch (IOException e) {
            logger.error(TAG, "Unable to restore gallery capture", e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Unable to restore capture");
        }
    }

    private static String manifestCursor(long timestamp, String captureId) {
        return timestamp + ":" + captureId;
    }

    private static Map<String, Object> trashResultData(GalleryTrashManager.Result result) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("success", result.success);
        data.put("capture_id", result.captureId);
        data.put("already_trashed", result.alreadyTrashed);
        data.put("recoverable", result.success);
        data.put("file_count", result.fileCount);
        data.put("total_size", result.totalSize);
        data.put("message", result.message);
        return data;
    }

    private void garbageCollectGalleryTrashBestEffort() {
        try {
            galleryTrashManager.garbageCollect(MIN_TRASH_RETENTION_MS);
        } catch (IOException e) {
            logger.warn(TAG, "Deferred gallery trash cleanup failed: " + e.getMessage());
        }
    }

    private JSONObject readJsonBody(IHTTPSession session) throws IOException, JSONException {
        String contentLengthValue = session.getHeaders().get("content-length");
        int contentLength;
        try {
            contentLength = Integer.parseInt(contentLengthValue != null ? contentLengthValue : "0");
        } catch (NumberFormatException e) {
            throw new IOException("Invalid Content-Length", e);
        }
        if (contentLength <= 0 || contentLength > MAX_JSON_BODY_BYTES) {
            throw new IOException("Invalid request body length");
        }
        byte[] body = new byte[contentLength];
        InputStream input = session.getInputStream();
        int offset = 0;
        while (offset < contentLength) {
            int read = input.read(body, offset, contentLength - offset);
            if (read < 0) {
                throw new IOException("Incomplete request body");
            }
            offset += read;
        }
        return new JSONObject(new String(body, StandardCharsets.UTF_8));
    }

    /** Get the camera package name. */
    public String getCameraPackage() {
        return fileManager.getDefaultPackageName();
    }

    /**
     * Serve sync request for efficient client-side synchronization. Returns only files that have
     * changed since the last sync.
     */
    private Response serveSync(IHTTPSession session) {
        logger.debug(TAG, "🔄 =========================================");
        logger.debug(TAG, "🔄 SYNC REQUEST HANDLER");
        logger.debug(TAG, "🔄 =========================================");

        Map<String, String> params = session.getParms();
        // Accept both "last_sync_time" (what mobile sends) and "last_sync" (legacy)
        String lastSyncTimeParam = params.get("last_sync_time");
        if (lastSyncTimeParam == null) {
            lastSyncTimeParam = params.get("last_sync");
        }
        String clientId = params.get("client_id");
        String includeThumbnails = params.get("include_thumbnails");

        // Validate client ID
        if (clientId == null || clientId.trim().isEmpty()) {
            logger.warn(TAG, "🔄 ❌ Client ID is required for sync");
            return createErrorResponse(Response.Status.BAD_REQUEST, "Client ID is required");
        }

        long lastSyncTime = 0;
        if (lastSyncTimeParam != null && !lastSyncTimeParam.isEmpty()) {
            try {
                lastSyncTime = Long.parseLong(lastSyncTimeParam);
            } catch (NumberFormatException e) {
                logger.warn(TAG, "🔄 ❌ Invalid last_sync parameter: " + lastSyncTimeParam);
                return createErrorResponse(
                        Response.Status.BAD_REQUEST, "Invalid last_sync parameter");
            }
        }

        long glassesNow = System.currentTimeMillis();
        if (lastSyncTime > glassesNow + CLOCK_SKEW_TOLERANCE_MS) {
            logger.warn(
                    TAG,
                    "🔄 ⏰ last_sync_time is in the future vs glasses clock (last_sync="
                            + lastSyncTime
                            + " ("
                            + new Date(lastSyncTime)
                            + "), glasses_now="
                            + glassesNow
                            + " ("
                            + new Date(glassesNow)
                            + ")); resetting to 0 for full sync");
            lastSyncTime = 0;
        }

        boolean includeThumbnailsFlag = "true".equalsIgnoreCase(includeThumbnails);

        try {
            logger.debug(TAG, "🔄 📊 Processing sync request for client: " + clientId);
            logger.debug(
                    TAG,
                    "🔄 📊 Last sync time: " + lastSyncTime + " (" + new Date(lastSyncTime) + ")");

            // Get all files
            List<FileMetadata> allFiles =
                    fileManager.listFiles(fileManager.getDefaultPackageName());

            // Filter files that have changed since last sync
            List<Map<String, Object>> changedFiles = new ArrayList<>();
            List<Map<String, Object>> deletedFiles = new ArrayList<>();

            // For now, we'll return all files since we don't track deletions
            // In a more sophisticated implementation, you'd track deletions separately
            for (FileMetadata fileMetadata : allFiles) {
                if (fileMetadata.getLastModified() > lastSyncTime) {
                    // Skip files that are actively being recorded or not yet servable
                    if (!shouldExposeServableFile(fileMetadata)) {
                        if (isActiveRecording(fileMetadata.getFileName())) {
                            logger.debug(
                                    TAG,
                                    "🔄 Skipping active recording: " + fileMetadata.getFileName());
                        }
                        continue;
                    }

                    // Transfer artifacts are hidden, but never physically deleted during a read
                    // operation. Only an explicit, committed capture acknowledgement may move
                    // source media out of the live gallery.
                    if (isAvifTransferArtifact(fileMetadata.getFileName())) {
                        logger.debug(
                                TAG,
                                "🔄 Hiding AVIF transfer artifact: " + fileMetadata.getFileName());
                        continue;
                    }

                    Map<String, Object> fileInfo = new HashMap<>();
                    fileInfo.put("name", fileMetadata.getFileName());
                    fileInfo.put("size", fileMetadata.getFileSize());
                    fileInfo.put("modified", fileMetadata.getLastModified());
                    fileInfo.put("mime_type", fileMetadata.getMimeType());
                    fileInfo.put("url", "/api/photo?file=" + fileMetadata.getFileName());
                    fileInfo.put("download", "/api/download?file=" + fileMetadata.getFileName());

                    // Add media type, thumbnail, and duration information
                    if (isVideoFile(fileMetadata.getFileName())) {
                        fileInfo.put("is_video", true);
                        if (includeThumbnailsFlag) {
                            // Include base64 thumbnail data for immediate display
                            try {
                                File videoFile =
                                        fileManager.getFile(
                                                fileManager.getDefaultPackageName(),
                                                fileMetadata.getFileName());
                                if (videoFile != null && videoFile.exists()) {
                                    File thumbnailFile =
                                            fileManager
                                                    .getThumbnailManager()
                                                    .getOrCreateThumbnail(videoFile);
                                    if (thumbnailFile != null && thumbnailFile.exists()) {
                                        try (FileInputStream fis =
                                                new FileInputStream(thumbnailFile)) {
                                            byte[] thumbnailData;
                                            if (Build.VERSION.SDK_INT
                                                    >= Build.VERSION_CODES.TIRAMISU) {
                                                thumbnailData = fis.readAllBytes();
                                            } else {
                                                thumbnailData =
                                                        new byte[(int) thumbnailFile.length()];
                                                new DataInputStream(fis).readFully(thumbnailData);
                                            }
                                            String thumbnailBase64 =
                                                    android.util.Base64.encodeToString(
                                                            thumbnailData,
                                                            android.util.Base64.DEFAULT);
                                            fileInfo.put("thumbnail_data", thumbnailBase64);
                                        }
                                    }

                                    // Extract video duration
                                    try {
                                        MediaMetadataRetriever retriever =
                                                new MediaMetadataRetriever();
                                        retriever.setDataSource(videoFile.getAbsolutePath());
                                        String durationStr =
                                                retriever.extractMetadata(
                                                        MediaMetadataRetriever
                                                                .METADATA_KEY_DURATION);
                                        retriever.release();
                                        if (durationStr != null) {
                                            fileInfo.put("duration", Long.parseLong(durationStr));
                                        }
                                    } catch (Exception e) {
                                        logger.warn(
                                                TAG,
                                                "Failed to extract duration for "
                                                        + fileMetadata.getFileName()
                                                        + ": "
                                                        + e.getMessage());
                                    }
                                }
                            } catch (Exception e) {
                                logger.warn(
                                        TAG,
                                        "Failed to include thumbnail for "
                                                + fileMetadata.getFileName()
                                                + ": "
                                                + e.getMessage());
                            }
                            fileInfo.put(
                                    "thumbnail_url",
                                    "/api/photo?file=" + fileMetadata.getFileName());
                        }
                    } else {
                        fileInfo.put("is_video", false);
                        if (includeThumbnailsFlag) {
                            // Include base64 thumbnail data for photos too
                            try {
                                File imageFile =
                                        fileManager.getFile(
                                                fileManager.getDefaultPackageName(),
                                                fileMetadata.getFileName());
                                if (imageFile != null && imageFile.exists()) {
                                    File thumbnailFile =
                                            fileManager
                                                    .getThumbnailManager()
                                                    .getOrCreateImageThumbnail(imageFile);
                                    if (thumbnailFile != null && thumbnailFile.exists()) {
                                        try (FileInputStream fis =
                                                new FileInputStream(thumbnailFile)) {
                                            byte[] thumbnailData;
                                            if (Build.VERSION.SDK_INT
                                                    >= Build.VERSION_CODES.TIRAMISU) {
                                                thumbnailData = fis.readAllBytes();
                                            } else {
                                                thumbnailData =
                                                        new byte[(int) thumbnailFile.length()];
                                                new DataInputStream(fis).readFully(thumbnailData);
                                            }
                                            String thumbnailBase64 =
                                                    android.util.Base64.encodeToString(
                                                            thumbnailData,
                                                            android.util.Base64.DEFAULT);
                                            fileInfo.put("thumbnail_data", thumbnailBase64);
                                        }
                                    }
                                }
                            } catch (Exception e) {
                                logger.warn(
                                        TAG,
                                        "Failed to include photo thumbnail for "
                                                + fileMetadata.getFileName()
                                                + ": "
                                                + e.getMessage());
                            }
                        }
                    }

                    changedFiles.add(fileInfo);
                }
            }

            // Sort files by modification time (oldest first) for chronological sync
            // This ensures older captures are synced first, building gallery chronologically
            changedFiles.sort(
                    (file1, file2) -> {
                        Long modified1 = (Long) file1.get("modified");
                        Long modified2 = (Long) file2.get("modified");
                        if (modified1 == null) modified1 = 0L;
                        if (modified2 == null) modified2 = 0L;
                        return Long.compare(modified1, modified2); // Oldest first
                    });

            // Group files into captures
            Map<String, List<Map<String, Object>>> captureGroups = new LinkedHashMap<>();
            for (Map<String, Object> fileInfo : changedFiles) {
                String name = (String) fileInfo.get("name");
                String captureId = deriveCaptureId(name);
                captureGroups.computeIfAbsent(captureId, k -> new ArrayList<>()).add(fileInfo);
            }

            // Build captures array
            List<Map<String, Object>> captures = new ArrayList<>();
            for (Map.Entry<String, List<Map<String, Object>>> entry : captureGroups.entrySet()) {
                String captureId = entry.getKey();
                List<Map<String, Object>> captureFiles = entry.getValue();

                Map<String, Object> capture = new HashMap<>();
                capture.put("capture_id", captureId);

                // Surface the originating SDK requestId (embedded in the capture directory
                // name) so clients can correlate synced files with photo/video requests
                // without timestamp matching. Absent for button captures and legacy files.
                String captureRequestId = CaptureRequestId.extractFromCaptureId(captureId);
                if (captureRequestId != null) {
                    capture.put("request_id", captureRequestId);
                }

                // Determine type from primary file
                boolean isVideo = captureId.startsWith("VID_") || captureId.startsWith("BUFFER_");
                capture.put("type", isVideo ? "video" : "photo");

                // Calculate total size and find timestamp
                long captureTotalSize = 0;
                long captureTimestamp = 0;
                String thumbnailData = null;
                Long duration = null;

                List<Map<String, Object>> fileList = new ArrayList<>();
                for (Map<String, Object> file : captureFiles) {
                    String fileName = (String) file.get("name");
                    long fileSize = (Long) file.get("size");
                    captureTotalSize += fileSize;

                    long modified = (Long) file.get("modified");
                    if (modified > captureTimestamp) captureTimestamp = modified;

                    // Assign role based on filename
                    String role = assignFileRole(fileName);

                    Map<String, Object> captureFile = new HashMap<>();
                    captureFile.put("name", fileName);
                    captureFile.put("size", fileSize);
                    captureFile.put("role", role);
                    fileList.add(captureFile);

                    // Grab thumbnail from primary file
                    if ("primary".equals(role) && file.containsKey("thumbnail_data")) {
                        thumbnailData = (String) file.get("thumbnail_data");
                    }
                    if ("primary".equals(role) && file.containsKey("duration")) {
                        duration = (Long) file.get("duration");
                    }
                }

                capture.put("timestamp", captureTimestamp);
                capture.put("total_size", captureTotalSize);
                capture.put("files", fileList);
                if (thumbnailData != null) {
                    capture.put("thumbnail_data", thumbnailData);
                }
                if (duration != null) {
                    capture.put("duration", duration);
                }
                captures.add(capture);
            }

            // Calculate sync statistics
            long currentTime = System.currentTimeMillis();
            long totalSize = changedFiles.stream().mapToLong(file -> (Long) file.get("size")).sum();

            Map<String, Object> syncData = new HashMap<>();
            syncData.put("api_version", 2);
            syncData.put("client_id", clientId);
            syncData.put("sync_timestamp", currentTime);
            syncData.put("last_sync_time", lastSyncTime);
            syncData.put("captures", captures);
            syncData.put("changed_files", changedFiles); // Keep for backwards compat
            syncData.put("deleted_files", deletedFiles);
            syncData.put("total_changed", changedFiles.size());
            syncData.put("total_deleted", deletedFiles.size());
            syncData.put("total_size", totalSize);
            syncData.put("server_time", currentTime);

            logger.debug(
                    TAG,
                    "🔄 ✅ Sync completed: "
                            + captures.size()
                            + " captures, "
                            + changedFiles.size()
                            + " changed files, "
                            + deletedFiles.size()
                            + " deleted files, "
                            + totalSize
                            + " bytes");

            return createSuccessResponse(syncData);
        } catch (Exception e) {
            logger.error(TAG, "🔄 💥 Error during sync: " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error during sync");
        }
    }

    /**
     * Serve batch sync request for downloading multiple files efficiently. Accepts POST request
     * with JSON body containing file list.
     */
    private Response serveBatchSync(IHTTPSession session) {
        logger.debug(TAG, "📦 =========================================");
        logger.debug(TAG, "📦 BATCH SYNC REQUEST HANDLER");
        logger.debug(TAG, "📦 =========================================");

        // Check if it's a POST request
        if (!"POST".equals(session.getMethod().name())) {
            logger.warn(
                    TAG, "📦 Invalid method: " + session.getMethod().name() + " (expected POST)");
            return createErrorResponse(
                    Response.Status.METHOD_NOT_ALLOWED, "Only POST method is allowed");
        }

        try {
            JSONObject jsonObject = readJsonBody(session);
            JSONArray filesArray = jsonObject.getJSONArray("files");
            String clientId = jsonObject.optString("client_id", "unknown");
            boolean includeThumbnails = jsonObject.optBoolean("include_thumbnails", false);

            if (filesArray.length() == 0) {
                logger.warn(TAG, "📦 Empty files array");
                return createErrorResponse(
                        Response.Status.BAD_REQUEST, "Files array cannot be empty");
            }

            // OOM protection: limit the number of files in a single batch
            int MAX_BATCH_FILES = 5;
            if (filesArray.length() > MAX_BATCH_FILES) {
                logger.warn(
                        TAG,
                        "📦 Too many files in batch: "
                                + filesArray.length()
                                + " (max: "
                                + MAX_BATCH_FILES
                                + ")");
                return newFixedLengthResponse(
                        Response.Status.BAD_REQUEST,
                        "application/json",
                        "{\"status\":\"error\",\"error\":\"Too many files in batch. Maximum: "
                                + MAX_BATCH_FILES
                                + "\"}");
            }

            // Process batch download
            List<Map<String, Object>> results = new ArrayList<>();
            int successCount = 0;
            int failureCount = 0;
            long totalDownloadedSize = 0;

            for (int i = 0; i < filesArray.length(); i++) {
                String fileName = filesArray.getString(i);

                if (fileName == null || fileName.trim().isEmpty()) {
                    logger.warn(TAG, "📦 Skipping empty filename at index " + i);
                    Map<String, Object> result = new HashMap<>();
                    result.put("file", fileName);
                    result.put("success", false);
                    result.put("message", "Empty filename");
                    results.add(result);
                    failureCount++;
                    continue;
                }

                logger.debug(TAG, "📦 Processing file: " + fileName);

                if (isActiveRecording(fileName)) {
                    logger.warn(
                            TAG,
                            "📦 Skipping file pending recording or integrity check: " + fileName);
                    Map<String, Object> result = new HashMap<>();
                    result.put("file", fileName);
                    result.put("success", false);
                    result.put("message", "File is not ready for download");
                    results.add(result);
                    failureCount++;
                    continue;
                }

                try {
                    // Get file metadata
                    FileMetadata metadata =
                            fileManager.getFileMetadata(
                                    fileManager.getDefaultPackageName(), fileName);
                    if (metadata == null) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("file", fileName);
                        result.put("success", false);
                        result.put("message", "File not found");
                        results.add(result);
                        failureCount++;
                        continue;
                    }

                    if (!shouldExposeServableFile(metadata)) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("file", fileName);
                        result.put("success", false);
                        result.put("message", "File is not ready for download");
                        results.add(result);
                        failureCount++;
                        continue;
                    }

                    // Get file
                    File file = fileManager.getFile(fileManager.getDefaultPackageName(), fileName);
                    if (file == null || !file.exists()) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("file", fileName);
                        result.put("success", false);
                        result.put("message", "File not accessible");
                        results.add(result);
                        failureCount++;
                        continue;
                    }

                    // Read file data
                    byte[] fileData;
                    try (FileInputStream fis = new FileInputStream(file)) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            fileData = fis.readAllBytes();
                        } else {
                            fileData = new byte[(int) file.length()];
                            new DataInputStream(fis).readFully(fileData);
                        }
                    }

                    // Encode as base64 for JSON transmission
                    String base64Data =
                            android.util.Base64.encodeToString(
                                    fileData, android.util.Base64.DEFAULT);

                    Map<String, Object> result = new HashMap<>();
                    result.put("file", fileName);
                    result.put("success", true);
                    result.put("size", fileData.length);
                    result.put("modified", metadata.getLastModified());
                    result.put("mime_type", metadata.getMimeType());
                    result.put("data", base64Data);
                    result.put("is_video", isVideoFile(fileName));

                    // Include thumbnail if requested and it's a video
                    if (includeThumbnails && isVideoFile(fileName)) {
                        File thumbnailFile =
                                fileManager.getThumbnailManager().getOrCreateThumbnail(file);
                        if (thumbnailFile != null && thumbnailFile.exists()) {
                            try (FileInputStream fis = new FileInputStream(thumbnailFile)) {
                                byte[] thumbnailData;
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    thumbnailData = fis.readAllBytes();
                                } else {
                                    thumbnailData = new byte[(int) thumbnailFile.length()];
                                    new DataInputStream(fis).readFully(thumbnailData);
                                }
                                String thumbnailBase64 =
                                        android.util.Base64.encodeToString(
                                                thumbnailData, android.util.Base64.DEFAULT);
                                result.put("thumbnail_data", thumbnailBase64);
                            }
                        }
                    }

                    results.add(result);
                    successCount++;
                    totalDownloadedSize += fileData.length;

                    logger.debug(
                            TAG,
                            "📦 Successfully processed: "
                                    + fileName
                                    + " ("
                                    + fileData.length
                                    + " bytes)");

                } catch (Exception e) {
                    logger.error(
                            TAG, "📦 Error processing file " + fileName + ": " + e.getMessage(), e);
                    Map<String, Object> result = new HashMap<>();
                    result.put("file", fileName);
                    result.put("success", false);
                    result.put("message", "Error processing file: " + e.getMessage());
                    results.add(result);
                    failureCount++;
                }
            }

            // Prepare response
            Map<String, Object> responseData = new HashMap<>();
            responseData.put("client_id", clientId);
            responseData.put("batch_timestamp", System.currentTimeMillis());
            responseData.put("total_files", filesArray.length());
            responseData.put("successful_downloads", successCount);
            responseData.put("failed_downloads", failureCount);
            responseData.put("total_downloaded_size", totalDownloadedSize);
            responseData.put("results", results);

            logger.info(
                    TAG,
                    "📦 Batch sync completed: "
                            + successCount
                            + " successful, "
                            + failureCount
                            + " failed, "
                            + totalDownloadedSize
                            + " bytes transferred");
            return createSuccessResponse(responseData);

        } catch (JSONException e) {
            logger.error(TAG, "📦 JSON parsing error: " + e.getMessage(), e);
            return createErrorResponse(
                    Response.Status.BAD_REQUEST, "Invalid JSON format: " + e.getMessage());
        } catch (IOException e) {
            logger.error(TAG, "📦 IO error reading request body: " + e.getMessage(), e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Error reading request body");
        } catch (Exception e) {
            logger.error(TAG, "📦 Unexpected error during batch sync: " + e.getMessage(), e);
            return createErrorResponse(
                    Response.Status.INTERNAL_ERROR, "Unexpected error: " + e.getMessage());
        }
    }

    /** Serve sync status for monitoring sync operations. */
    private Response serveSyncStatus(IHTTPSession session) {
        logger.debug(TAG, "📊 =========================================");
        logger.debug(TAG, "📊 SYNC STATUS REQUEST HANDLER");
        logger.debug(TAG, "📊 =========================================");

        try {
            Map<String, Object> status = new HashMap<>();

            // Basic server info
            status.put("server_time", System.currentTimeMillis());
            status.put("server_uptime", System.currentTimeMillis() - getStartTime());

            // File statistics (servable media only)
            List<FileMetadata> allFiles =
                    fileManager.listFiles(fileManager.getDefaultPackageName());
            List<FileMetadata> servableFiles = new ArrayList<>();
            for (FileMetadata metadata : allFiles) {
                if (isAvifTransferArtifact(metadata.getFileName())) {
                    continue;
                }
                if (isImuSidecar(metadata.getFileName()) || isHdrBracket(metadata.getFileName())) {
                    continue;
                }
                if (shouldExposeServableFile(metadata)) {
                    servableFiles.add(metadata);
                }
            }
            status.put("total_files", servableFiles.size());
            status.put(
                    "total_size",
                    servableFiles.stream().mapToLong(FileMetadata::getFileSize).sum());

            // File type breakdown (exclude auxiliary files like HDR brackets and IMU sidecars)
            long imageCount =
                    servableFiles.stream().filter(f -> !isVideoFile(f.getFileName())).count();
            long videoCount =
                    servableFiles.stream().filter(f -> isVideoFile(f.getFileName())).count();
            status.put("image_count", imageCount);
            status.put("video_count", videoCount);

            // Thumbnail statistics
            status.put("thumbnail_count", fileManager.getThumbnailManager().getThumbnailCount());
            status.put(
                    "thumbnail_size",
                    fileManager.getThumbnailManager().getThumbnailDirectorySize());

            // Storage information
            status.put("available_space", fileManager.getAvailableSpace());
            status.put("total_space", fileManager.getTotalSpace());

            // Performance metrics
            var performanceStats = fileManager.getOperationLogger().getPerformanceStats();
            status.put("file_operations_total", performanceStats.totalOperations);
            status.put("file_operations_success_rate", performanceStats.successRate);

            // Sync recommendations
            Map<String, Object> recommendations = new HashMap<>();
            recommendations.put("recommended_sync_interval_ms", 30000); // 30 seconds
            recommendations.put("max_batch_size", 10); // Max files per batch
            recommendations.put("include_thumbnails", true); // Include thumbnails for videos
            recommendations.put("compression_enabled", false); // Base64 encoding used
            status.put("sync_recommendations", recommendations);

            logger.debug(TAG, "📊 ✅ Sync status served successfully");
            return createSuccessResponse(status);
        } catch (Exception e) {
            logger.error(TAG, "📊 💥 Error serving sync status: " + e.getMessage(), e);
            return createErrorResponse(Response.Status.INTERNAL_ERROR, "Error getting sync status");
        }
    }
}
