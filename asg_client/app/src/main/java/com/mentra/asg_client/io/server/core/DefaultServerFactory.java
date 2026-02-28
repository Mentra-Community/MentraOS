package com.mentra.asg_client.io.server.core;

import android.content.Context;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.server.interfaces.*;
import com.mentra.asg_client.io.server.services.AsgCameraServer;
import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.logging.LoggerFactory;

/**
 * Factory for creating server instances with default implementations.
 * Follows Dependency Inversion Principle by depending on abstractions.
 */
public class DefaultServerFactory {

    /**
     * Create a default logger instance
     */
    public static Logger createLogger() {
        return LoggerFactory.createLogger();
    }

    /**
     * Create a default network provider instance
     */
    public static NetworkProvider createNetworkProvider(Logger logger) {
        return new DefaultNetworkProvider(logger);
    }

    /**
     * Create a default cache manager instance
     */
    public static CacheManager createCacheManager(Logger logger) {
        return new DefaultCacheManager(logger);
    }

    /**
     * Create a default rate limiter instance
     */
    public static RateLimiter createRateLimiter(int maxRequests, long timeWindow, Logger logger) {
        return new DefaultRateLimiter(maxRequests, timeWindow, logger);
    }

    /**
     * Create a default server config instance
     */
    public static ServerConfig createServerConfig(int port, String serverName, Context context) {
        return new DefaultServerConfig.Builder()
                .port(port)
                .serverName(serverName)
                .context(context)
                .build();
    }

    /**
     * Create a camera web server with default implementations
     */
    public static AsgCameraServer createCameraWebServer(int port, String serverName, Context context, Logger logger,  FileManager fileManager) {
        ServerConfig config = createServerConfig(port, serverName, context);
        NetworkProvider networkProvider = createNetworkProvider(logger);
        CacheManager cacheManager = createCacheManager(logger);
        RateLimiter rateLimiter = createRateLimiter(150, 60000, logger); // 100 requests per minute

        return new AsgCameraServer(config, networkProvider, cacheManager, rateLimiter, logger, fileManager);
    }

    /**
     * Create a camera web server with custom rate limiting
     */
    public static AsgCameraServer createCameraWebServer(int port, String serverName, Context context,
                                                        int maxRequests, long timeWindow, Logger logger, FileManager fileManager) {
        ServerConfig config = createServerConfig(port, serverName, context);
        NetworkProvider networkProvider = createNetworkProvider(logger);
        CacheManager cacheManager = createCacheManager(logger);
        RateLimiter rateLimiter = createRateLimiter(maxRequests, timeWindow, logger);

        return new AsgCameraServer(config, networkProvider, cacheManager, rateLimiter, logger, fileManager);
    }
} 