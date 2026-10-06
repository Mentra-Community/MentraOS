package com.mentra.asg_client.io.media.core;

import com.mentra.asg_client.AsgConstants;
import java.net.URI;

/**
 * Decides whether a {@code take_photo} upload target is the phone's local still endpoint.
 *
 * <p>During a WHIP call over the glasses hotspot the phone serves {@code POST /photo/<id>} on the
 * same listener the glasses publish WHIP to. The glasses have no internet on their own hotspot, so
 * only a plain-HTTP private IPv4 target can be reached; anything else keeps the normal photo path
 * (which rejects while streaming).
 */
public final class StreamPhotoTarget {

    private StreamPhotoTarget() {}

    /**
     * @return true when {@code uploadUrl} is {@code http://<private IPv4>[:port]/photo/<id>}.
     */
    public static boolean isLocalStillUpload(String uploadUrl) {
        if (uploadUrl == null || uploadUrl.isEmpty()) return false;
        URI uri;
        try {
            uri = new URI(uploadUrl.trim());
        } catch (Exception e) {
            return false;
        }
        if (!"http".equalsIgnoreCase(uri.getScheme())) return false;
        String path = uri.getPath();
        String prefix = AsgConstants.STREAM_PHOTO_UPLOAD_PATH_PREFIX;
        if (path == null || !path.startsWith(prefix)) return false;
        String id = path.substring(prefix.length());
        if (id.isEmpty() || id.contains("/")) return false;
        return isPrivateIpv4(uri.getHost());
    }

    static boolean isPrivateIpv4(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (parts[i].isEmpty() || parts[i].length() > 3) return false;
            for (int c = 0; c < parts[i].length(); c++) {
                if (!Character.isDigit(parts[i].charAt(c))) return false;
            }
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) return false;
        }
        if (octets[0] == 10) return true;
        if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) return true;
        return octets[0] == 192 && octets[1] == 168;
    }
}
