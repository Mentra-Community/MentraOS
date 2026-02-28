package com.mentra.asg_client.io.file.core;

import android.content.Context;

import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.io.file.platform.AndroidPlatformStrategy;
import com.mentra.asg_client.io.file.platform.PlatformRegistry;
import com.mentra.asg_client.io.file.platform.PlatformStrategy;

import java.io.File;

/**
 * SOLID-compliant factory for creating platform-specific FileManager instances.
 * Follows Dependency Inversion Principle by depending on abstractions.
 */
public class FileManagerFactory {

    private static final String TAG = "FileManagerFactory";

    // Singleton instance
    private static FileManager instance;

    // Platform configuration
    private static PlatformConfig platformConfig;

    /**
     * Platform configuration holder
     */
    public static class PlatformConfig {
        private final File baseDirectory;
        private final Logger logger;
        private final String platformName;

        public PlatformConfig(File baseDirectory, Logger logger, String platformName) {
            this.baseDirectory = baseDirectory;
            this.logger = logger;
            this.platformName = platformName;
        }

        public File getBaseDirectory() {
            return baseDirectory;
        }

        public Logger getLogger() {
            return logger;
        }

        public String getPlatformName() {
            return platformName;
        }
    }

    /**
     * Initialize with Android context (convenience method)
     *
     * @param context The Android application context
     */
    public static void initialize(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("Context cannot be null");
        }

        AndroidPlatformStrategy strategy = new AndroidPlatformStrategy(context);
        PlatformConfig config = new PlatformConfig(
                strategy.getBaseDirectory(),
                strategy.createLogger(),
                strategy.getPlatformName()
        );

        platformConfig = config;

        if (config.getBaseDirectory() == null) {
            platformConfig.getLogger().info(TAG,
                    "FileManagerFactory initialized for platform: " + config.getPlatformName() +
                            " with base directory: NOT=LOADED=YET=1");
        } else {
            platformConfig.getLogger().info(TAG,
                    "FileManagerFactory initialized for platform: " + config.getPlatformName() +
                            " with base directory: " + config.getBaseDirectory().getAbsolutePath());
        }

//        platformConfig.getLogger().info(TAG,
//                "FileManagerFactory initialized for platform: " + config.getPlatformName() +
//                        " with base directory: " + config.getBaseDirectory().getAbsolutePath());
    }


    /**
     * Auto-detect platform and initialize
     * NOTE: This method will throw an exception on Android. Use initialize(Context) instead.
     */
    public static void initialize() {
        PlatformStrategy strategy = PlatformRegistry.detectPlatform();
        // Check if strategy is null or if getBaseDirectory returns null
        if (strategy == null) {
            throw new IllegalStateException("Failed to detect platform strategy");
        }
        
        File baseDir = strategy.getBaseDirectory();
        if (baseDir == null) {
            throw new IllegalStateException("Platform strategy returned null base directory. On Android, use initialize(Context) instead.");
        }
        
        PlatformConfig config = new PlatformConfig(
                baseDir,
                strategy.createLogger(),
                strategy.getPlatformName()
        );

        platformConfig = config;
        if (config.getBaseDirectory() == null) {
            platformConfig.getLogger().info(TAG,
                    "FileManagerFactory initialized for platform: " + config.getPlatformName() +
                            " with base directory: NOT=LOADED=YET=2");
        } else {
            platformConfig.getLogger().info(TAG,
                    "FileManagerFactory initialized for platform: " + config.getPlatformName() +
                            " with base directory: " + config.getBaseDirectory().getAbsolutePath());
        }
    }

    /**
     * Get the singleton FileManager instance
     *
     * @return FileManager instance
     * @throws IllegalStateException if not initialized
     */
    public static FileManager getInstance() {
        if (platformConfig == null) {
            throw new IllegalStateException("FileManagerFactory not initialized. Call initialize() first.");
        }

        if (instance == null) {
            synchronized (FileManagerFactory.class) {
                if (instance == null) {
                    instance = createPlatformSpecificManager();
                    platformConfig.getLogger().info(TAG, "FileManager instance created");
                }
            }
        }

        return instance;
    }

    /**
     * Create a platform-specific FileManager instance
     *
     * @return FileManager instance for the current platform
     */
    private static FileManager createPlatformSpecificManager() {
        if (platformConfig == null) {
            throw new IllegalStateException("Platform not configured");
        }

        return new FileManagerImpl(platformConfig.getBaseDirectory(), platformConfig.getLogger());
    }

//    /**
//     * Create a new FileManager instance with custom configuration
//     * @param config The platform configuration
//     * @return New FileManager instance
//     */
//    public static FileManager createInstance(PlatformConfig config) {
//        if (config == null) {
//            throw new IllegalArgumentException("PlatformConfig cannot be null");
//        }
//
//        return new FileManagerImpl(config.getBaseDirectory(), config.getLogger());
//    }
//

    /**
     * Create a new FileManager instance for Android
     *
     * @param context The Android context
     * @return New FileManager instance
     */
    public static FileManager createInstance(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("Context cannot be null");
        }

        AndroidPlatformStrategy strategy = new AndroidPlatformStrategy(context);
        return new FileManagerImpl(strategy.getBaseDirectory(), strategy.createLogger());
    }

    /**
     * Create a new FileManager instance with custom settings
     *
     * @param baseDirectory The base directory for files
     * @param logger        The logger to use
     * @return New FileManager instance
     */
    public static FileManager createInstance(File baseDirectory, Logger logger) {
        if (baseDirectory == null) {
            throw new IllegalArgumentException("Base directory cannot be null");
        }
        if (logger == null) {
            throw new IllegalArgumentException("Logger cannot be null");
        }

        return new FileManagerImpl(baseDirectory, logger);
    }

    /**
     * Reset the singleton instance (useful for testing)
     */
    public static void reset() {
        synchronized (FileManagerFactory.class) {
            instance = null;
            if (platformConfig != null) {
                platformConfig.getLogger().info(TAG, "FileManager instance reset");
            }
        }
    }

    /**
     * Check if the factory is initialized
     *
     * @return true if initialized, false otherwise
     */
    public static boolean isInitialized() {
        return platformConfig != null;
    }

    /**
     * Get the current platform configuration
     *
     * @return PlatformConfig or null if not initialized
     */
    public static PlatformConfig getPlatformConfig() {
        return platformConfig;
    }

    /**
     * Get the current platform name
     *
     * @return Platform name or null if not initialized
     */
    public static String getPlatformName() {
        return platformConfig != null ? platformConfig.getPlatformName() : null;
    }
} 