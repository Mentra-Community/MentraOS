package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import java.io.File;

/** Default {@link TraceFreezer}: freezes the rolling BES TRACE store into the incident bundle. */
public final class BesTraceStoreFreezer implements TraceFreezer {
    private static final String TAG = "BesTraceStoreFreezer";

    @Override
    public Result freeze(File destination, long fromWallMs, long toWallMs, int maxBytes) {
        BesTraceStore store = BesTraceTail.get().store();
        if (store == null) {
            return null;
        }
        try {
            BesTraceStore.Frozen frozen = store.freeze(destination, fromWallMs, toWallMs, maxBytes);
            return new Result(frozen.lines, frozen.bytes, frozen.firstWallMs, frozen.lastWallMs,
                    frozen.gaps, frozen.truncated);
        } catch (RuntimeException e) {
            Log.e(TAG, "BesTraceStore.freeze failed", e);
            return null;
        }
    }
}
