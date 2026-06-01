package com.mentra.asg_client.camera.lifecycle;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.exifinterface.media.ExifInterface;

import org.json.JSONObject;

/**
 * Writes photo-specific metadata into JPEG EXIF without impacting capture success.
 */
final class PhotoExifMetadataWriter {
    private static final String TAG = "CameraNeo";

    private PhotoExifMetadataWriter() {}

    /**
     * Persist IMU payload into JPEG EXIF metadata.
     *
     * <p>Primary tag is {@code UserComment}. If that fails, fall back to
     * {@code ImageDescription}. Returns false on any write failure but never throws.
     */
    static boolean writeImuPayload(@NonNull String photoPath, JSONObject imuPayload) {
        if (imuPayload == null) {
            return false;
        }

        String imuJson = imuPayload.toString();
        if (imuJson.isEmpty()) {
            return false;
        }

        try {
            ExifInterface exif = new ExifInterface(photoPath);
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT, imuJson);
            exif.saveAttributes();
            return true;
        } catch (Throwable primaryError) {
            Log.w(TAG, "Failed writing IMU to EXIF UserComment, trying ImageDescription", primaryError);
            try {
                ExifInterface exif = new ExifInterface(photoPath);
                exif.setAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION, imuJson);
                exif.saveAttributes();
                return true;
            } catch (Throwable fallbackError) {
                Log.e(TAG, "Failed writing IMU payload to EXIF", fallbackError);
                return false;
            }
        }
    }
}
