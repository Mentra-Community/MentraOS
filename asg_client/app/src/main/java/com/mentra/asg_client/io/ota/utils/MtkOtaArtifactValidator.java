package com.mentra.asg_client.io.ota.utils;

import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Bounded A/B metadata inspection for a privileged inline update; Android verifies its signature. */
public final class MtkOtaArtifactValidator {
    private MtkOtaArtifactValidator() {}

    /** Refuse wipe and a payload kind that differs from the authenticated manifest selection. */
    public static void validate(File file, boolean incremental) throws IOException {
        try (ZipFile zip = new ZipFile(file)) {
            Set<String> names = new HashSet<>();
            java.util.Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                String name = entries.nextElement().getName();
                if (names.size() >= AsgConstants.MTK_OTA_MAX_ZIP_ENTRIES || !names.add(name)
                        || name.startsWith("/") || java.util.Arrays.asList(name.split("/")).contains(".."))
                    throw new IOException("Ambiguous MTK ZIP entry");
            }
            Map<String, String> metadata = properties(zip, "META-INF/com/android/metadata");
            Map<String, String> properties = properties(zip, "payload_properties.txt");
            if (!"AB".equals(metadata.get("ota-type"))) throw new IOException("MTK artifact is not an Android A/B OTA");
            if ("yes".equals(metadata.get("ota-wipe")) || "1".equals(properties.get("POWERWASH")))
                throw new IOException("Powerwashing MTK OTA is not admitted by the inline updater");
            ZipEntry payload = zip.getEntry("payload.bin");
            if (payload == null || payload.getMethod() != ZipEntry.STORED || payload.getSize() < 24)
                throw new IOException("MTK OTA lacks its stored payload");
            try (InputStream input = zip.getInputStream(payload)) {
                byte[] header = read(input, 24);
                ByteBuffer view = ByteBuffer.wrap(header);
                if (header.length != 24 || view.getInt() != 0x43724155 || view.getLong() != 2)
                    throw new IOException("Unsupported MTK payload header");
                long length = view.getLong();
                if (length <= 0 || length > AsgConstants.MTK_OTA_MAX_PAYLOAD_MANIFEST_BYTES || length > payload.getSize() - 24)
                    throw new IOException("MTK payload manifest exceeds its bound");
                byte[] manifest = read(input, (int) length);
                if (manifest.length != length) throw new IOException("Truncated MTK payload manifest");
                long minor = minorVersion(manifest);
                if (incremental != (minor != 0)) throw new IOException("MTK payload kind differs from its selected manifest entry");
            }
        }
    }

    private static Map<String, String> properties(ZipFile zip, String name) throws IOException {
        ZipEntry entry = zip.getEntry(name);
        if (entry == null || entry.getSize() < 0 || entry.getSize() > AsgConstants.DEBUG_MTK_OTA_MANIFEST_MAX_BYTES)
            throw new IOException("MTK OTA lacks bounded metadata");
        byte[] bytes;
        try (InputStream input = zip.getInputStream(entry)) {
            bytes = read(input, AsgConstants.DEBUG_MTK_OTA_MANIFEST_MAX_BYTES + 1);
        }
        if (bytes.length > AsgConstants.DEBUG_MTK_OTA_MANIFEST_MAX_BYTES) throw new IOException("MTK metadata exceeds its bound");
        Map<String, String> result = new HashMap<>();
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\\r?\\n")) {
            if (line.isEmpty()) continue;
            int equal = line.indexOf('=');
            if (equal <= 0 || result.putIfAbsent(line.substring(0, equal), line.substring(equal + 1)) != null)
                throw new IOException("Ambiguous MTK metadata property");
        }
        return result;
    }

    private static byte[] read(InputStream input, int maximum) throws IOException {
        byte[] bytes = new byte[maximum];
        int count = 0;
        while (count < maximum) {
            int read = input.read(bytes, count, maximum - count);
            if (read < 0) break;
            count += read;
        }
        return count == maximum ? bytes : java.util.Arrays.copyOf(bytes, count);
    }

    private static long minorVersion(byte[] manifest) throws IOException {
        ByteBuffer bytes = ByteBuffer.wrap(manifest);
        long minor = 0;
        boolean found = false;
        while (bytes.hasRemaining()) {
            long key = varint(bytes), field = key >>> 3, wire = key & 7;
            if (field == 0) throw new IOException("Malformed MTK payload field");
            if (wire == 0) {
                long value = varint(bytes);
                if (field == 12) {
                    if (found) throw new IOException("Duplicate MTK payload minor version");
                    minor = value;
                    found = true;
                }
            } else {
                long length = wire == 2 ? varint(bytes) : wire == 1 ? 8 : wire == 5 ? 4 : -1;
                if (length < 0 || length > bytes.remaining()) throw new IOException("Malformed MTK payload wire field");
                bytes.position(bytes.position() + (int) length);
            }
        }
        return minor;
    }

    private static long varint(ByteBuffer bytes) throws IOException {
        long value = 0;
        for (int shift = 0; shift < 63 && bytes.hasRemaining(); shift += 7) {
            int next = bytes.get() & 255;
            value |= (long) (next & 127) << shift;
            if ((next & 128) == 0) return value;
        }
        throw new IOException("Malformed MTK payload varint");
    }
}
