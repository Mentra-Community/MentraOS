package com.mentra.asg_client.service.core.handlers;

import org.json.JSONObject;

/**
 * Parses optional per-request shutter / exposure time from {@code take_photo} JSON.
 * Values are nanoseconds (Camera2 {@code SENSOR_EXPOSURE_TIME}). Not persisted.
 */
public final class PhotoExposureTimeNs {

    private PhotoExposureTimeNs() {}

    /**
     * @return positive exposure time in nanoseconds, or {@code null} to use auto exposure
     */
    public static Long parse(JSONObject data) {
        if (data == null || !data.has("exposureTimeNs") || data.isNull("exposureTimeNs")) {
            return null;
        }
        Object raw = data.opt("exposureTimeNs");
        if (!(raw instanceof Number)) {
            return null;
        }
        long v = ((Number) raw).longValue();
        if (v <= 0) {
            return null;
        }
        return v;
    }
}
