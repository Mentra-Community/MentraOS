package com.mentra.asg_client.io.file.security;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Security validator for file operations.
 * Prevents path traversal attacks and validates file names and package names.
 */
public class FileSecurityValidator {
    
    private static final String TAG = "FileSecurityValidator";
    
    // Maximum file name length
    private static final int MAX_FILENAME_LENGTH = 255;
    
    // Maximum package name length
    private static final int MAX_PACKAGE_NAME_LENGTH = 100;
    
    // Maximum file size (100MB)
    private static final long MAX_FILE_SIZE = 100 * 1024 * 1024;
    
    // Dangerous file extensions that should be blocked
    private static final Set<String> DANGEROUS_EXTENSIONS = new HashSet<>(Arrays.asList(
        "exe", "bat", "cmd", "com", "pif", "scr", "vbs", "js", "jar", "war", "ear",
        "sh", "bash", "zsh", "csh", "ksh", "tcsh", "dmg", "app", "deb", "rpm",
        "msi", "dll", "so", "dylib", "sys", "drv", "bin", "elf"
    ));
    
    // Pattern for valid package names (alphanumeric, dots, underscores, hyphens)
    private static final Pattern PACKAGE_NAME_PATTERN = Pattern.compile("^[a-zA-Z0-9._-]+$");
    
    // Pattern for valid file names (alphanumeric, dots, underscores, hyphens, spaces)
    private static final Pattern FILENAME_PATTERN = Pattern.compile("^[a-zA-Z0-9._\\-\\s]+$");
    
    // Path traversal patterns to block
    private static final Pattern PATH_TRAVERSAL_PATTERN = Pattern.compile("(\\.\\.|/|\\\\|:|\\|)");
    
    /**
     * Validate package name for security
     * @param packageName The package name to validate
     * @return true if valid, false otherwise
     */
    public boolean validatePackageName(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return false;
        }
        
        if (packageName.length() > MAX_PACKAGE_NAME_LENGTH) {
            return false;
        }
        
        // Check for path traversal attempts
        if (PATH_TRAVERSAL_PATTERN.matcher(packageName).find()) {
            return false;
        }
        
        // Check for valid characters
        if (!PACKAGE_NAME_PATTERN.matcher(packageName).matches()) {
            return false;
        }
        
        // Check for reserved names
        if (isReservedPackageName(packageName)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Validate file name for security
     * @param fileName The file name to validate
     * @return true if valid, false otherwise
     */
    public boolean validateFileName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return false;
        }
        
        if (fileName.length() > MAX_FILENAME_LENGTH) {
            return false;
        }
        
        // Check for path traversal attempts
        if (PATH_TRAVERSAL_PATTERN.matcher(fileName).find()) {
            return false;
        }
        
        // Check for valid characters
        if (!FILENAME_PATTERN.matcher(fileName).matches()) {
            return false;
        }
        
        // Check for dangerous file extensions
        if (hasDangerousExtension(fileName)) {
            return false;
        }
        
        // Check for reserved file names
        if (isReservedFileName(fileName)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Validate file size
     * @param fileSize The file size in bytes
     * @return true if valid, false otherwise
     */
    public boolean validateFileSize(long fileSize) {
        return fileSize >= 0 && fileSize <= MAX_FILE_SIZE;
    }
    
    /**
     * Validate MIME type
     * @param mimeType The MIME type to validate
     * @return true if valid, false otherwise
     */
    public boolean validateMimeType(String mimeType) {
        if (mimeType == null || mimeType.isEmpty()) {
            return false;
        }
        
        // Basic MIME type format validation
        return mimeType.matches("^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$");
    }
    
    /**
     * Check if a file has a dangerous extension
     * @param fileName The file name to check
     * @return true if dangerous, false otherwise
     */
    public boolean hasDangerousExtension(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return false;
        }
        
        int lastDotIndex = fileName.lastIndexOf('.');
        if (lastDotIndex == -1 || lastDotIndex == fileName.length() - 1) {
            return false;
        }
        
        String extension = fileName.substring(lastDotIndex + 1).toLowerCase();
        return DANGEROUS_EXTENSIONS.contains(extension);
    }
    
    /**
     * Check if a package name is reserved
     * @param packageName The package name to check
     * @return true if reserved, false otherwise
     */
    private boolean isReservedPackageName(String packageName) {
        String lowerPackageName = packageName.toLowerCase();
        
        // System reserved names
        return lowerPackageName.equals("system") ||
               lowerPackageName.equals("android") ||
               lowerPackageName.equals("com.android") ||
               lowerPackageName.equals("android.system") ||
               lowerPackageName.equals("root") ||
               lowerPackageName.equals("admin") ||
               lowerPackageName.equals("system_server") ||
               lowerPackageName.equals("com.android.systemui");
    }
    
    /**
     * Check if a file name is reserved
     * @param fileName The file name to check
     * @return true if reserved, false otherwise
     */
    private boolean isReservedFileName(String fileName) {
        String lowerFileName = fileName.toLowerCase();
        
        // Windows reserved names
        if (lowerFileName.equals("con") || lowerFileName.equals("prn") ||
            lowerFileName.equals("aux") || lowerFileName.equals("nul") ||
            lowerFileName.equals("com1") || lowerFileName.equals("com2") ||
            lowerFileName.equals("com3") || lowerFileName.equals("com4") ||
            lowerFileName.equals("com5") || lowerFileName.equals("com6") ||
            lowerFileName.equals("com7") || lowerFileName.equals("com8") ||
            lowerFileName.equals("com9") || lowerFileName.equals("lpt1") ||
            lowerFileName.equals("lpt2") || lowerFileName.equals("lpt3") ||
            lowerFileName.equals("lpt4") || lowerFileName.equals("lpt5") ||
            lowerFileName.equals("lpt6") || lowerFileName.equals("lpt7") ||
            lowerFileName.equals("lpt8") || lowerFileName.equals("lpt9")) {
            return true;
        }
        
        // Unix reserved names
        if (lowerFileName.equals(".") || lowerFileName.equals("..")) {
            return true;
        }
        
        // Common system files
        if (lowerFileName.equals("thumbs.db") || lowerFileName.equals(".ds_store")) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Sanitize a file name for safe use
     * @param fileName The original file name
     * @return Sanitized file name
     */
    public String sanitizeFileName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return "unnamed_file";
        }
        
        // Remove path traversal characters
        String sanitized = fileName.replaceAll("[\\.\\./\\\\:|]", "_");
        
        // Remove or replace invalid characters
        sanitized = sanitized.replaceAll("[^a-zA-Z0-9._\\-\\s]", "_");
        
        // Trim whitespace
        sanitized = sanitized.trim();
        
        // Ensure it's not empty after sanitization
        if (sanitized.isEmpty()) {
            return "unnamed_file";
        }
        
        // Truncate if too long
        if (sanitized.length() > MAX_FILENAME_LENGTH) {
            int lastDotIndex = sanitized.lastIndexOf('.');
            if (lastDotIndex > 0) {
                String name = sanitized.substring(0, lastDotIndex);
                String extension = sanitized.substring(lastDotIndex);
                int maxNameLength = MAX_FILENAME_LENGTH - extension.length();
                if (maxNameLength > 0) {
                    sanitized = name.substring(0, maxNameLength) + extension;
                } else {
                    sanitized = sanitized.substring(0, MAX_FILENAME_LENGTH);
                }
            } else {
                sanitized = sanitized.substring(0, MAX_FILENAME_LENGTH);
            }
        }
        
        return sanitized;
    }
    
    /**
     * Sanitize a package name for safe use
     * @param packageName The original package name
     * @return Sanitized package name
     */
    public String sanitizePackageName(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return "unknown_package";
        }
        
        // Remove path traversal characters
        String sanitized = packageName.replaceAll("[\\.\\./\\\\:|]", "_");
        
        // Remove or replace invalid characters
        sanitized = sanitized.replaceAll("[^a-zA-Z0-9._-]", "_");
        
        // Trim whitespace
        sanitized = sanitized.trim();
        
        // Ensure it's not empty after sanitization
        if (sanitized.isEmpty()) {
            return "unknown_package";
        }
        
        // Truncate if too long
        if (sanitized.length() > MAX_PACKAGE_NAME_LENGTH) {
            sanitized = sanitized.substring(0, MAX_PACKAGE_NAME_LENGTH);
        }
        
        return sanitized;
    }
    
    /**
     * Get the list of dangerous file extensions
     * @return Set of dangerous extensions
     */
    public Set<String> getDangerousExtensions() {
        return new HashSet<>(DANGEROUS_EXTENSIONS);
    }
    
    /**
     * Add a dangerous extension to the blocked list
     * @param extension The extension to add
     */
    public void addDangerousExtension(String extension) {
        if (extension != null) {
            DANGEROUS_EXTENSIONS.add(extension.toLowerCase());
        }
    }
    
    /**
     * Remove a dangerous extension from the blocked list
     * @param extension The extension to remove
     */
    public void removeDangerousExtension(String extension) {
        if (extension != null) {
            DANGEROUS_EXTENSIONS.remove(extension.toLowerCase());
        }
    }
} 