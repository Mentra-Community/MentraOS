package com.mentra.asg_client.camera.policy;

import java.util.function.BooleanSupplier;

/** Tracks applied hardware state, not preferences, and refuses disruptive crop changes. */
public final class CameraFovPolicy {
    public enum Result { UNCHANGED, CHANGED, BUSY }
    private Integer mAppliedFov;
    private Integer mAppliedRoi;

    /** Applies a crop only when capture is idle; failed writes never advance the cache. */
    public synchronized Result apply(int fov, int roi, BooleanSupplier busy, Runnable write) {
        if (mAppliedFov != null && mAppliedFov == fov && mAppliedRoi == roi) {
            return Result.UNCHANGED;
        }
        if (busy.getAsBoolean()) return Result.BUSY;
        // A partially successful hardware write leaves effective state unknown.
        mAppliedFov = null;
        mAppliedRoi = null;
        write.run();
        mAppliedFov = fov;
        mAppliedRoi = roi;
        return Result.CHANGED;
    }
}
