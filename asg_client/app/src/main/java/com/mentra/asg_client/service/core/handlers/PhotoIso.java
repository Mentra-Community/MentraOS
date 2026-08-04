package com.mentra.asg_client.service.core.handlers;

import org.json.JSONObject;

/**
 * Parses optional per-request sensor ISO from {@code take_photo} JSON.
 * Not persisted, and only used by manual-exposure captures.
 */
public final class PhotoIso {

    private PhotoIso() {}

    /**
     * @return positive ISO value, or {@code null} to let the camera path choose ISO
     */
    public static Integer parse(JSONObject data) {
        if (data == null || !data.has("iso") || data.isNull("iso")) {
            return null;
        }
        Object raw = data.opt("iso");
        if (!(raw instanceof Number)) {
            return null;
        }
        long v = ((Number) raw).longValue();
        if (v <= 0) {
            return null;
        }
        if (v > Integer.MAX_VALUE) {
            return Integer.MAX_VALUE;
        }
        return (int) v;
    }
}
