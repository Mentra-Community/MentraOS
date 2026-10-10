package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * INTEGRATOR NOTE: default {@link TraceFreezer} that forwards to
 * {@code BesTraceStore.freeze(File, long, long, int)}, which asg-store adds (contract section 7).
 * That method does not exist on the asg-collector branch, so the call is made by reflection and
 * this class compiles with or without it. After merging asg-store, replace the body of
 * {@link #freeze} with the direct call and delete the reflection:
 *
 * <pre>
 * BesTraceStore store = BesTraceTail.get().store();
 * if (store == null) return null;
 * BesTraceStore.Frozen f = store.freeze(destination, fromWallMs, toWallMs, maxBytes);
 * return new Result(f.lines, f.bytes, f.firstWallMs, f.lastWallMs, f.gaps, f.truncated);
 * </pre>
 */
public final class BesTraceStoreFreezer implements TraceFreezer {
    private static final String TAG = "BesTraceStoreFreezer";

    @Override
    public Result freeze(File destination, long fromWallMs, long toWallMs, int maxBytes) {
        BesTraceStore store = BesTraceTail.get().store();
        if (store == null) {
            return null;
        }
        try {
            Method method = store.getClass().getMethod("freeze", File.class, long.class,
                    long.class, int.class);
            Object frozen = method.invoke(store, destination, fromWallMs, toWallMs, maxBytes);
            if (frozen == null) {
                return null;
            }
            return new Result(
                    ((Number) read(frozen, "lines")).intValue(),
                    ((Number) read(frozen, "bytes")).longValue(),
                    ((Number) read(frozen, "firstWallMs")).longValue(),
                    ((Number) read(frozen, "lastWallMs")).longValue(),
                    ((Number) read(frozen, "gaps")).intValue(),
                    (Boolean) read(frozen, "truncated"));
        } catch (NoSuchMethodException e) {
            Log.w(TAG, "BesTraceStore.freeze is not available in this build; TRACE not frozen");
            return null;
        } catch (Exception e) {
            Log.e(TAG, "BesTraceStore.freeze failed", e);
            return null;
        }
    }

    private static Object read(Object target, String name) throws Exception {
        Field field = target.getClass().getField(name);
        return field.get(target);
    }
}
