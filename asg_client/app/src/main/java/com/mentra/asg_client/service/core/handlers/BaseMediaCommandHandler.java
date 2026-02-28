package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import org.json.JSONObject;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Base class for media command handlers that provides common package directory management.
 * Follows Single Responsibility Principle by handling only package directory operations.
 * Follows Open/Closed Principle by allowing extension for specific media types.
 * 
 * This class extracts the common functionality of:
 * - Package name resolution (default vs custom)
 * - Package directory management
 * - File path generation
 * - Timestamp generation
 */
public abstract class BaseMediaCommandHandler implements ICommandHandler {
    
    protected static final String TAG = "BaseMediaCommandHandler";
    
    protected final Context context;
    protected final FileManager fileManager;
    
    public BaseMediaCommandHandler(Context context, FileManager fileManager) {
        this.context = context;
        this.fileManager = fileManager;
    }
    
    /**
     * Get the package name from command data, using FileManager's default if not specified.
     * 
     * @param data Command data containing optional packageName
     * @return Resolved package name
     */
    protected String resolvePackageName(JSONObject data) {
        String packageName = data.optString("packageName", "");
        if (packageName.isEmpty()) {
            packageName = fileManager.getDefaultPackageName();
        }
        Log.d(TAG, "Resolved package name: " + packageName);
        return packageName;
    }
    
    /**
     * Get and ensure package directory exists.
     * 
     * @param packageName The package name
     * @return Package directory File object, or null if failed
     */
    protected File getPackageDirectory(String packageName) {
        File packageDir = fileManager.getPackageDirectory(packageName);
        if (packageDir == null) {
            Log.e(TAG, "Failed to get package directory for: " + packageName);
            return null;
        }
        
        if (!fileManager.ensurePackageDirectoryExists(packageName)) {
            Log.e(TAG, "Failed to create package directory for: " + packageName);
            return null;
        }
        
        Log.d(TAG, "Package directory ready: " + packageDir.getAbsolutePath());
        return packageDir;
    }
    
    /**
     * Generate a unique filename with timestamp.
     * 
     * @param prefix File prefix (e.g., "IMG_", "VID_")
     * @param extension File extension (e.g., ".jpg", ".mp4")
     * @return Unique filename
     */
    protected String generateUniqueFilename(String prefix, String extension) {
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        return prefix + timeStamp + extension;
    }
    
    /**
     * Generate full file path within package directory.
     * 
     * @param packageName The package name
     * @param fileName The filename
     * @return Full file path, or null if package directory creation failed
     */
    protected String generateFilePath(String packageName, String fileName) {
        File packageDir = getPackageDirectory(packageName);
        if (packageDir == null) {
            return null;
        }
        
        String filePath = new File(packageDir, fileName).getAbsolutePath();
        Log.d(TAG, "Generated file path: " + filePath);
        return filePath;
    }
    
    /**
     * Validate that requestId is present in command data.
     * 
     * @param data Command data
     * @return true if requestId is present, false otherwise
     */
    protected boolean validateRequestId(JSONObject data) {
        String requestId = data.optString("requestId", "");
        if (requestId.isEmpty()) {
            Log.e(TAG, "Cannot process command - missing requestId");
            return false;
        }
        return true;
    }
    
    /**
     * Log command processing start with package information.
     * 
     * @param commandType The command type being processed
     * @param packageName The package name
     */
    protected void logCommandStart(String commandType, String packageName) {
        Log.d(TAG, "Processing " + commandType + " command for package: " + packageName);
    }
    
    /**
     * Log command processing result.
     * 
     * @param commandType The command type
     * @param success Whether the command was successful
     * @param errorMessage Error message if failed
     */
    protected void logCommandResult(String commandType, boolean success, String errorMessage) {
        if (success) {
            Log.d(TAG, commandType + " command processed successfully");
        } else {
            Log.e(TAG, commandType + " command failed: " + errorMessage);
        }
    }
} 