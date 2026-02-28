package com.mentra.asg_client.io.file.utils;

import java.util.HashMap;
import java.util.Map;

/**
 * Registry for MIME type mappings based on file extensions.
 * Provides centralized MIME type detection and validation.
 */
public class MimeTypeRegistry {
    
    private final Map<String, String> mimeTypeMap;
    
    public MimeTypeRegistry() {
        this.mimeTypeMap = new HashMap<>();
        initializeMimeTypes();
    }
    
    /**
     * Get MIME type for a file based on its extension
     * @param fileName The file name
     * @return MIME type string or "application/octet-stream" for unknown types
     */
    public String getMimeType(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return "application/octet-stream";
        }
        
        int lastDotIndex = fileName.lastIndexOf('.');
        if (lastDotIndex == -1 || lastDotIndex == fileName.length() - 1) {
            return "application/octet-stream";
        }
        
        String extension = fileName.substring(lastDotIndex + 1).toLowerCase();
        return mimeTypeMap.getOrDefault(extension, "application/octet-stream");
    }
    
    /**
     * Check if a file extension is supported
     * @param fileName The file name
     * @return true if the file type is supported
     */
    public boolean isSupportedFileType(String fileName) {
        String mimeType = getMimeType(fileName);
        return !"application/octet-stream".equals(mimeType);
    }
    
    /**
     * Get file extension from MIME type
     * @param mimeType The MIME type
     * @return File extension or null if not found
     */
    public String getExtensionFromMimeType(String mimeType) {
        for (Map.Entry<String, String> entry : mimeTypeMap.entrySet()) {
            if (entry.getValue().equals(mimeType)) {
                return entry.getKey();
            }
        }
        return null;
    }
    
    /**
     * Initialize common MIME type mappings
     */
    private void initializeMimeTypes() {
        // Images
        mimeTypeMap.put("jpg", "image/jpeg");
        mimeTypeMap.put("jpeg", "image/jpeg");
        mimeTypeMap.put("png", "image/png");
        mimeTypeMap.put("gif", "image/gif");
        mimeTypeMap.put("bmp", "image/bmp");
        mimeTypeMap.put("webp", "image/webp");
        mimeTypeMap.put("svg", "image/svg+xml");
        mimeTypeMap.put("ico", "image/x-icon");
        
        // Videos
        mimeTypeMap.put("mp4", "video/mp4");
        mimeTypeMap.put("avi", "video/x-msvideo");
        mimeTypeMap.put("mov", "video/quicktime");
        mimeTypeMap.put("wmv", "video/x-ms-wmv");
        mimeTypeMap.put("flv", "video/x-flv");
        mimeTypeMap.put("webm", "video/webm");
        mimeTypeMap.put("mkv", "video/x-matroska");
        mimeTypeMap.put("3gp", "video/3gpp");
        
        // Audio
        mimeTypeMap.put("mp3", "audio/mpeg");
        mimeTypeMap.put("wav", "audio/wav");
        mimeTypeMap.put("ogg", "audio/ogg");
        mimeTypeMap.put("aac", "audio/aac");
        mimeTypeMap.put("flac", "audio/flac");
        mimeTypeMap.put("m4a", "audio/mp4");
        mimeTypeMap.put("wma", "audio/x-ms-wma");
        
        // Documents
        mimeTypeMap.put("pdf", "application/pdf");
        mimeTypeMap.put("doc", "application/msword");
        mimeTypeMap.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        mimeTypeMap.put("xls", "application/vnd.ms-excel");
        mimeTypeMap.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        mimeTypeMap.put("ppt", "application/vnd.ms-powerpoint");
        mimeTypeMap.put("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        mimeTypeMap.put("txt", "text/plain");
        mimeTypeMap.put("rtf", "application/rtf");
        
        // Archives
        mimeTypeMap.put("zip", "application/zip");
        mimeTypeMap.put("rar", "application/vnd.rar");
        mimeTypeMap.put("7z", "application/x-7z-compressed");
        mimeTypeMap.put("tar", "application/x-tar");
        mimeTypeMap.put("gz", "application/gzip");
        
        // Web
        mimeTypeMap.put("html", "text/html");
        mimeTypeMap.put("htm", "text/html");
        mimeTypeMap.put("css", "text/css");
        mimeTypeMap.put("js", "application/javascript");
        mimeTypeMap.put("json", "application/json");
        mimeTypeMap.put("xml", "application/xml");
        
        // Data formats
        mimeTypeMap.put("csv", "text/csv");
        mimeTypeMap.put("tsv", "text/tab-separated-values");
        mimeTypeMap.put("yaml", "application/x-yaml");
        mimeTypeMap.put("yml", "application/x-yaml");
        
        // Executables and binaries
        mimeTypeMap.put("apk", "application/vnd.android.package-archive");
        mimeTypeMap.put("exe", "application/x-msdownload");
        mimeTypeMap.put("dmg", "application/x-apple-diskimage");
        mimeTypeMap.put("deb", "application/vnd.debian.binary-package");
        mimeTypeMap.put("rpm", "application/x-rpm");
    }
    
    /**
     * Add a custom MIME type mapping
     * @param extension File extension (without dot)
     * @param mimeType MIME type string
     */
    public void addMimeType(String extension, String mimeType) {
        if (extension != null && mimeType != null) {
            mimeTypeMap.put(extension.toLowerCase(), mimeType);
        }
    }
    
    /**
     * Remove a MIME type mapping
     * @param extension File extension to remove
     */
    public void removeMimeType(String extension) {
        if (extension != null) {
            mimeTypeMap.remove(extension.toLowerCase());
        }
    }
    
    /**
     * Get all registered MIME types
     * @return Map of extensions to MIME types
     */
    public Map<String, String> getAllMimeTypes() {
        return new HashMap<>(mimeTypeMap);
    }
} 