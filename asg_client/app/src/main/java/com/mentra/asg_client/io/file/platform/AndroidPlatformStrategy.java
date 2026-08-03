package com.mentra.asg_client.io.file.platform;

import android.content.Context;

import com.mentra.asg_client.io.media.utils.MediaStorage;
import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.logging.AndroidLogger;

import java.io.File;

/**
 * Android platform strategy implementation.
 * Follows Open/Closed Principle by extending PlatformStrategy.
 */
public class AndroidPlatformStrategy implements PlatformStrategy {

    private final Context context;

    public AndroidPlatformStrategy(Context context) {
        this.context = context;
    }

    @Override
    public File getBaseDirectory() {
        // Shared media root, NOT getExternalFilesDir: the app-owned tree is deleted by the OEM
        // uninstall used for pinned downgrades (hardware-verified 2026-07-21).
        return MediaStorage.getMediaRoot(context);
    }

    @Override
    public Logger createLogger() {
        return new AndroidLogger();
    }

    @Override
    public String getPlatformName() {
        return "Android";
    }

    @Override
    public boolean isSupported() {
        return context != null;
    }
} 