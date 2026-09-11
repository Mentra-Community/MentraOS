package com.mentra.asg_client.logging;

/**
 * Factory for creating platform-specific Logger instances. Follows Factory Pattern and provides
 * platform detection.
 */
public class LoggerFactory {

    /**
     * Create a logger instance for the current platform
     *
     * @return Logger instance
     */
    public static Logger createLogger() {
        return createLoggerForPlatform();
    }

    /**
     * Create an Android-specific logger
     *
     * @return AndroidLogger instance
     */
    public static Logger createAndroidLogger() {
        return new AndroidLogger();
    }

    /**
     * Create a console logger for non-Android platforms
     *
     * @return ConsoleLogger instance
     */
    public static Logger createConsoleLogger() {
        return new ConsoleLogger();
    }

    /**
     * Detect platform and create appropriate logger
     *
     * @return Platform-specific logger
     */
    private static Logger createLoggerForPlatform() {
        try {
            // Try to detect Android
            Class.forName("android.util.Log");
            return new AndroidLogger();
        } catch (ClassNotFoundException e) {
            // Not Android, use console logger
            return new ConsoleLogger();
        }
    }

    /**
     * Create a logger with custom tag
     *
     * @param defaultTag The default tag to use
     * @return Logger instance with custom tag
     */
    public static Logger createLogger(String defaultTag) {
        try {
            Class.forName("android.util.Log");
            return new AndroidLogger(defaultTag);
        } catch (ClassNotFoundException e) {
            return new ConsoleLogger();
        }
    }
}
