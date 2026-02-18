package com.mentra.asg_client.io.server.core;

import com.mentra.asg_client.io.server.interfaces.*;
import com.mentra.asg_client.logging.Logger;
import fi.iki.elonen.NanoHTTPD;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Abstract base server class for ASG (AugmentOS Smart Glasses) applications.
 * Follows SOLID principles with dependency injection and clear separation of concerns.
 */
public abstract class AsgServer extends NanoHTTPD {

    protected static final int MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    protected static final int CACHE_SIZE_LIMIT = 10; // Max 10 files in cache
    
    // Extended timeout for large file transfers (5 minutes)
    // Default NanoHTTPD timeout is 10 seconds which is too short for 500MB+ videos
    protected static final int EXTENDED_SOCKET_TIMEOUT = 300000; // 5 minutes

    // Dependencies injected through constructor
    protected final ServerConfig config;
    protected final NetworkProvider networkProvider;
    protected final CacheManager cacheManager;
    protected final RateLimiter rateLimiter;
    protected final Logger logger;

    /**
     * Constructor for ASG server with dependency injection.
     * Follows Dependency Inversion Principle by depending on abstractions.
     */
    public AsgServer(ServerConfig config, NetworkProvider networkProvider, 
                    CacheManager cacheManager, RateLimiter rateLimiter, Logger logger) {
        super(config.getPort());
        this.config = config;
        this.networkProvider = networkProvider;
        this.cacheManager = cacheManager;
        this.rateLimiter = rateLimiter;
        this.logger = logger;
        
        logger.info(getTag(), "🚀 =========================================");
        logger.info(getTag(), "🚀 " + config.getServerName() + " INITIALIZED");
        logger.info(getTag(), "🚀 =========================================");
        logger.info(getTag(), "🚀 📍 Port: " + config.getPort());
        logger.info(getTag(), "🚀 📍 Max file size: " + MAX_FILE_SIZE + " bytes");
        logger.info(getTag(), "🚀 📍 Rate limit: " + rateLimiter.getMaxRequests() + 
                                " requests per " + rateLimiter.getTimeWindow() + "ms");
    }

    /**
     * Get the server's tag for logging.
     */
    protected abstract String getTag();

    /**
     * Get the server's IP address for external access.
     * Follows Open/Closed Principle by being extensible.
     */
    public String getServerUrl() {
        try {
            String ipAddress = networkProvider.getBestIpAddress();
            return "http://" + ipAddress + ":" + getListeningPort();
        } catch (Exception e) {
            logger.error(getTag(), "Error getting server URL: " + e.getMessage(), e);
            return "http://localhost:" + getListeningPort();
        }
    }

    /**
     * Start the server with enhanced error handling and extended timeout for large files.
     */
    public void startServer() {
        logger.info(getTag(), "🚀 =========================================");
        logger.info(getTag(), "🚀 STARTING " + config.getServerName());
        logger.info(getTag(), "🚀 =========================================");
        
        try {
            // Use extended timeout instead of default SOCKET_READ_TIMEOUT
            // This allows large video transfers (500MB+) to complete without timing out
            start(EXTENDED_SOCKET_TIMEOUT, false);
            logger.info(getTag(), "✅ " + config.getServerName() + 
                       " started successfully on port " + getListeningPort());
            logger.info(getTag(), "⏱️ Socket timeout set to " + EXTENDED_SOCKET_TIMEOUT + "ms (" + 
                       (EXTENDED_SOCKET_TIMEOUT / 60000) + " minutes) for large file support");
            logger.info(getTag(), "📱 Access from mobile app: http://[GLASSES_IP]:" + getListeningPort());
            
            // Log server URL
            try {
                String url = getServerUrl();
                logger.info(getTag(), "🌐 Server URL: " + url);
            } catch (Exception e) {
                logger.warn(getTag(), "🌐 Could not determine server URL: " + e.getMessage());
            }
        } catch (IOException e) {
            logger.error(getTag(), "❌ Failed to start " + config.getServerName() + ": " + e.getMessage(), e);
        }
    }

    /**
     * Stop the server and cleanup resources.
     */
    public void stopServer() {
        logger.info(getTag(), "🛑 =========================================");
        logger.info(getTag(), "🛑 STOPPING " + config.getServerName());
        logger.info(getTag(), "🛑 =========================================");
        
        try {
            logger.info(getTag(), "🛑 🛑 Stopping server...");
            stop();
            
            logger.info(getTag(), "🛑 🧹 Clearing cache...");
            cacheManager.clear();
            
            logger.info(getTag(), "🛑 ✅ " + config.getServerName() + " stopped and cleaned up successfully.");
        } catch (Exception e) {
            logger.error(getTag(), "🛑 💥 Error stopping " + config.getServerName() + ": " + e.getMessage(), e);
        }
    }

    /**
     * Handle incoming requests with enhanced routing and security.
     * Follows Single Responsibility Principle by delegating to specific handlers.
     */
    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();
        String clientIp = session.getRemoteIpAddress();
        
        logger.debug(getTag(), "🔍 =========================================");
        logger.debug(getTag(), "🔍 NEW REQUEST RECEIVED");
        logger.debug(getTag(), "🔍 URI: " + uri);
        logger.debug(getTag(), "🔍 Method: " + method);
        logger.debug(getTag(), "🔍 Client IP: " + clientIp);
        logger.debug(getTag(), "🔍 User Agent: " + session.getHeaders().get("user-agent"));
        logger.debug(getTag(), "🔍 =========================================");

        // Rate limiting
        if (!rateLimiter.isAllowed(clientIp)) {
            logger.warn(getTag(), "🚫 Rate limit exceeded for IP: " + clientIp);
            return newFixedLengthResponse(
                Response.Status.TOO_MANY_REQUESTS, 
                "text/plain", 
                "Rate limit exceeded. Please wait before making more requests."
            );
        }
        
        // Record the request for rate limiting
        rateLimiter.recordRequest(clientIp);

        // CORS headers for cross-origin requests
        Map<String, String> headers = new HashMap<>();
        if (config.isCorsEnabled()) {
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            headers.put("Access-Control-Allow-Headers", "Content-Type");
        }

        // Handle preflight OPTIONS requests
        if (method == Method.OPTIONS) {
            logger.debug(getTag(), "🔄 Handling CORS preflight request");
            return newFixedLengthResponse(Response.Status.OK, "text/plain", "");
        }

        try {
            // Route requests using the abstract method
            logger.debug(getTag(), "🛣️ Routing request to appropriate handler...");
            return handleRequest(session);
        } catch (Exception e) {
            logger.error(getTag(), "💥 Error handling request " + uri + ": " + e.getMessage(), e);
            return newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR, 
                "text/plain", 
                "Internal server error: " + e.getMessage()
            );
        }
    }

    /**
     * Abstract method to handle specific requests. Must be implemented by subclasses.
     * Follows Open/Closed Principle by allowing extension without modification.
     */
    protected abstract Response handleRequest(IHTTPSession session);

    /**
     * Get MIME type for file extension.
     */
    protected String getMimeType(String filename) {
        String extension = "";
        int i = filename.lastIndexOf('.');
        if (i > 0) {
            extension = filename.substring(i + 1).toLowerCase();
        }
        
        switch (extension) {
            case "css": return "text/css";
            case "js": return "application/javascript";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "svg": return "image/svg+xml";
            case "ico": return "image/x-icon";
            case "html":
            case "htm": return "text/html";
            case "json": return "application/json";
            case "xml": return "application/xml";
            case "txt": return "text/plain";
            default: return "text/plain";
        }
    }

    /**
     * Serve static files from assets.
     */
    protected Response serveStaticFile(String uri, String assetPath) {
        logger.debug(getTag(), "📁 =========================================");
        logger.debug(getTag(), "📁 STATIC FILE REQUEST HANDLER");
        logger.debug(getTag(), "📁 =========================================");
        
        try {
            // Remove prefix to get filename
            String filename = uri.substring(uri.indexOf("/static/") + 8);
            logger.debug(getTag(), "📁 📝 Requested static file: " + filename);
            
            // Security: prevent directory traversal
            if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                logger.warn(getTag(), "📁 ❌ Invalid static file path (directory traversal attempt): " + filename);
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", "Invalid path");
            }

            String fullAssetPath = assetPath + "/" + filename;
            logger.debug(getTag(), "📁 📂 Asset path: " + fullAssetPath);
            
            InputStream inputStream = config.getContext().getAssets().open(fullAssetPath);
            String mimeType = getMimeType(filename);
            
            logger.debug(getTag(), "📁 ✅ Serving static file: " + filename + " (MIME: " + mimeType + ")");
            return newChunkedResponse(Response.Status.OK, mimeType, inputStream);
        } catch (IOException e) {
            logger.error(getTag(), "📁 💥 Error serving static file " + uri + ": " + e.getMessage());
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "File not found");
        }
    }

    /**
     * Create a JSON error response.
     */
    protected Response createErrorResponse(Response.Status status, String message) {
        return newFixedLengthResponse(
            status,
            "application/json",
            "{\"status\":\"error\",\"message\":\"" + message + "\"}"
        );
    }

    /**
     * Create a JSON success response.
     */
    protected Response createSuccessResponse(Map<String, Object> data) {
        String jsonData = "{}";
        if (data != null) {
            try {
                jsonData = new org.json.JSONObject(data).toString();
                    } catch (Exception e) {
            logger.error(getTag(), "Error creating JSON response: " + e.getMessage());
        }
        }
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            "{\"status\":\"success\",\"data\":" + jsonData + "}"
        );
    }

    /**
     * Get server start time for uptime calculation.
     */
    protected long getStartTime() {
        // This would need to be set when server starts
        return System.currentTimeMillis() - 1000; // Placeholder
    }
} 