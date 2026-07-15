package com.mentra.asg_client.camera.model;

import android.util.Log;
import androidx.annotation.Nullable;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Hands a {@link CapturedPhoto} from the camera layer to the capture consumer without widening the
 * path-based {@code PhotoCaptureCallback} contract: {@code PhotoSession} registers the in-memory
 * photo under its intended file path right before firing {@code onPhotoCaptured(filePath)}, and
 * the consumer {@link #take}s it inside that callback.
 *
 * <p>Bounded to a handful of entries as a leak guard — only one photo job is in flight at a time
 * (enforced by {@code MediaCaptureService}), so anything beyond that is an abandoned capture
 * (error/timeout path that never consumed its entry) and gets evicted oldest-first.
 */
public final class CapturedPhotoStore {
    private static final String TAG = "CapturedPhotoStore";
    private static final int MAX_ENTRIES = 4;

    private static final LinkedHashMap<String, CapturedPhoto> sEntries = new LinkedHashMap<>();

    private CapturedPhotoStore() {}

    /** Register the in-memory photo under its intended file path. */
    public static synchronized void put(String filePath, CapturedPhoto photo) {
        if (filePath == null || photo == null) {
            return;
        }
        sEntries.put(filePath, photo);
        while (sEntries.size() > MAX_ENTRIES) {
            Iterator<Map.Entry<String, CapturedPhoto>> it = sEntries.entrySet().iterator();
            Map.Entry<String, CapturedPhoto> oldest = it.next();
            it.remove();
            Log.w(TAG, "Evicted abandoned in-memory capture: " + oldest.getKey());
        }
    }

    /** Remove and return the in-memory photo for this path, or null when none was registered. */
    @Nullable
    public static synchronized CapturedPhoto take(String filePath) {
        if (filePath == null) {
            return null;
        }
        return sEntries.remove(filePath);
    }
}
