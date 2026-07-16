package com.mentra.asg_client.io.media.core.textdetect.roi;

import android.content.res.AssetManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;

/** Loads ONNX models from an Android application's assets. */
public final class AndroidAssetModelSource implements ModelSource {
    private final AssetManager assetManager;
    private final String directory;

    /**
     * Creates an Android asset source.
     *
     * @param assetManager application asset manager
     * @param directory optional asset directory, such as {@code models}; blank means asset root
     */
    public AndroidAssetModelSource(AssetManager assetManager, String directory) {
        this.assetManager = Objects.requireNonNull(assetManager, "assetManager");
        this.directory = directory == null ? "" : trimSlashes(directory);
    }

    /** Loads the named asset into memory. */
    @Override
    public byte[] load(String assetName) throws IOException {
        String path = directory.isEmpty() ? assetName : directory + "/" + assetName;
        try (InputStream input = assetManager.open(path)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static String trimSlashes(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && value.charAt(start) == '/') {
            start++;
        }
        while (end > start && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(start, end);
    }
}
