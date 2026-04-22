package com.mentra.asg_client.io.media.core;

import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.io.File;
import java.nio.ByteBuffer;

/**
 * Lightweight validation that a recorded MP4 is readable by the platform muxer
 * (has a video track and at least one decodable sample). Runs off the recording thread.
 */
public final class RecordedVideoIntegrityChecker {

    private static final String TAG = "RecordedVideoIntegrity";

    /** Below this size, the file is almost certainly incomplete or not a real video. */
    private static final long MIN_FILE_BYTES = 8192;

    private RecordedVideoIntegrityChecker() {}

    /**
     * @param absolutePath full path to the recorded file (e.g. .../VID_xxx/base.mp4)
     * @return true if the container looks sane and has at least one video sample
     */
    public static boolean verify(String absolutePath) {
        File file = new File(absolutePath);
        if (!file.isFile() || !file.canRead()) {
            Log.w(TAG, "Not a readable file: " + absolutePath);
            return false;
        }
        long len = file.length();
        if (len < MIN_FILE_BYTES) {
            Log.w(TAG, "File too small (" + len + " bytes): " + absolutePath);
            return false;
        }

        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(absolutePath);
            int trackCount = extractor.getTrackCount();
            if (trackCount < 1) {
                Log.w(TAG, "No tracks in file: " + absolutePath);
                return false;
            }

            int videoTrackIndex = -1;
            for (int i = 0; i < trackCount; i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    videoTrackIndex = i;
                    break;
                }
            }
            if (videoTrackIndex < 0) {
                Log.w(TAG, "No video track in file: " + absolutePath);
                return false;
            }

            extractor.selectTrack(videoTrackIndex);
            ByteBuffer buffer = ByteBuffer.allocate(256 * 1024);
            int sampleSize = extractor.readSampleData(buffer, 0);
            if (sampleSize <= 0) {
                Log.w(TAG, "No readable video samples: " + absolutePath);
                return false;
            }

            Log.d(TAG, "Integrity OK (" + len + " bytes, first sample " + sampleSize + " bytes): " + absolutePath);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Integrity check failed: " + absolutePath, e);
            return false;
        } finally {
            try {
                extractor.release();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }
}
