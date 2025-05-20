package com.augmentos.augmentos;

import android.content.Context;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.core.content.FileProvider;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;

public class FileProviderModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext reactContext;
    private static final String AUTHORITY = "com.augmentos.augmentos.fileprovider";

    public FileProviderModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @NonNull
    @Override
    public String getName() {
        return "FileProviderModule";
    }

    /**
     * Convert a file path to a content:// URI using FileProvider
     *
     * @param filePath Absolute path to the file
     * @param promise Promise to resolve with the content URI
     */
    @ReactMethod
    public void getUriForFile(String filePath, Promise promise) {
        try {
            // Log debug info
            System.out.println("FileProviderModule: getUriForFile called with path: " + filePath);
            
            File file = new File(filePath);
            
            if (!file.exists()) {
                System.out.println("FileProviderModule: File does not exist: " + filePath);
                promise.reject("FILE_NOT_FOUND", "The file does not exist: " + filePath);
                return;
            }
            
            System.out.println("FileProviderModule: File exists, size: " + file.length() + " bytes");
            System.out.println("FileProviderModule: Using authority: " + AUTHORITY);
            
            Context context = reactContext.getApplicationContext();
            Uri contentUri = FileProvider.getUriForFile(
                context,
                AUTHORITY,
                file
            );
            
            System.out.println("FileProviderModule: Content URI created: " + contentUri.toString());
            promise.resolve(contentUri.toString());
        } catch (Exception e) {
            System.out.println("FileProviderModule: Error: " + e.getMessage());
            e.printStackTrace();
            promise.reject("FILE_PROVIDER_ERROR", e.getMessage(), e);
        }
    }
    
    /**
     * Share a file directly using an Intent
     * 
     * @param filePath Path to the file to share
     * @param mimeType MIME type of the file
     * @param title Title for the share dialog
     * @param message Optional message to include with the share
     * @param promise Promise to resolve when sharing is complete
     */
    @ReactMethod
    public void shareFile(String filePath, String mimeType, String title, String message, Promise promise) {
        try {
            System.out.println("FileProviderModule: shareFile called with path: " + filePath);
            
            File file = new File(filePath);
            if (!file.exists()) {
                System.out.println("FileProviderModule: File does not exist: " + filePath);
                promise.reject("FILE_NOT_FOUND", "The file does not exist: " + filePath);
                return;
            }
            
            Context context = reactContext.getApplicationContext();
            Uri contentUri = FileProvider.getUriForFile(
                context,
                AUTHORITY,
                file
            );
            
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
            intent.setType(mimeType);
            intent.putExtra(android.content.Intent.EXTRA_STREAM, contentUri);
            
            if (message != null && !message.isEmpty()) {
                intent.putExtra(android.content.Intent.EXTRA_TEXT, message);
            }
            
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            
            // Create chooser intent
            android.content.Intent chooser = android.content.Intent.createChooser(intent, title);
            chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            
            context.startActivity(chooser);
            promise.resolve(true);
        } catch (Exception e) {
            System.out.println("FileProviderModule: Error sharing: " + e.getMessage());
            e.printStackTrace();
            promise.reject("SHARE_ERROR", e.getMessage(), e);
        }
    }
}