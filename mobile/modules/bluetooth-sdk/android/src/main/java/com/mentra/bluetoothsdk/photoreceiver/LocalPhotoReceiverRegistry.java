package com.mentra.bluetoothsdk.photoreceiver;

import androidx.annotation.Nullable;

import java.net.URI;
import java.util.Collections;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

/**
 * Tracks the SDK photo receiver that is hosted inside the phone app process.
 *
 * <p>The glasses need a LAN-reachable URL, but the phone-side BLE fallback relay
 * can upload to the same receiver over loopback. Keeping this tiny registry lets
 * the relay avoid stale Wi-Fi interface addresses after network changes.
 */
public final class LocalPhotoReceiverRegistry {
    private static volatile Set<URI> activeUploadUris = Collections.emptySet();

    private LocalPhotoReceiverRegistry() {}

    public static void register(String uploadUrl) {
        try {
            URI uri = URI.create(uploadUrl);
            if (isSupportedUploadUri(uri)) {
                Set<URI> nextUploadUris = new HashSet<>(activeUploadUris);
                nextUploadUris.add(uri);
                activeUploadUris = Collections.unmodifiableSet(nextUploadUris);
            }
        } catch (Exception ignored) {
        }
    }

    public static void unregister() {
        activeUploadUris = Collections.emptySet();
    }

    public static boolean isActive() {
        return !activeUploadUris.isEmpty();
    }

    @Nullable
    public static String loopbackUploadUrlFor(@Nullable String webhookUrl) {
        Set<URI> registeredUris = activeUploadUris;
        if (registeredUris.isEmpty() || webhookUrl == null || webhookUrl.isEmpty()) {
            return null;
        }

        try {
            URI uri = URI.create(webhookUrl);
            for (URI registeredUri : registeredUris) {
                if (matchesRegisteredUploadUri(uri, registeredUri)) {
                    return new URI(
                            uri.getScheme(),
                            null,
                            "127.0.0.1",
                            effectivePort(uri),
                            normalizedPath(uri),
                            uri.getRawQuery(),
                            uri.getRawFragment()
                    ).toString();
                }
            }
            return null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean matchesRegisteredUploadUri(URI candidate, URI registered) {
        return isSupportedUploadUri(candidate)
                && equalsIgnoreCase(candidate.getScheme(), registered.getScheme())
                && equalsIgnoreCase(candidate.getHost(), registered.getHost())
                && effectivePort(candidate) == effectivePort(registered)
                && Objects.equals(normalizedPath(candidate), normalizedPath(registered))
                && Objects.equals(candidate.getRawQuery(), registered.getRawQuery())
                && Objects.equals(candidate.getRawFragment(), registered.getRawFragment());
    }

    private static boolean isSupportedUploadUri(URI uri) {
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            return false;
        }
        return uri.getHost() != null && effectivePort(uri) > 0 && "/upload".equals(normalizedPath(uri));
    }

    private static int effectivePort(URI uri) {
        int port = uri.getPort();
        if (port != -1) {
            return port;
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static String normalizedPath(URI uri) {
        String path = uri.getRawPath();
        return (path == null || path.isEmpty()) ? "/" : path;
    }

    private static boolean equalsIgnoreCase(@Nullable String first, @Nullable String second) {
        if (first == null || second == null) {
            return first == second;
        }
        return first.equalsIgnoreCase(second);
    }
}
