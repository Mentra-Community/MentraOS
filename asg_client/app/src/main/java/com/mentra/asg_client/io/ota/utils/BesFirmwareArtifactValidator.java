package com.mentra.asg_client.io.ota.utils;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.BesOtaStateStore;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.CRC32;
import org.json.JSONObject;
import org.tukaani.xz.LZMAInputStream;

/** Fail-closed admission gate for a release-packaged Mentra Live BES OTA artifact. */
public final class BesFirmwareArtifactValidator {
    private static final byte[] MAGIC = {(byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF};
    private static final byte[] CRC_PREFIX =
            "CRC32_OF_IMAGE=0x".getBytes(StandardCharsets.US_ASCII);
    private static final int CRC_HEX_LENGTH = 8;
    private static final int LZMA_ALONE_HEADER_LENGTH = 13;

    private BesFirmwareArtifactValidator() {}

    /**
     * Validate artifact identity, compressed bytes, complete container structure, decompressed
     * bytes, product, and target version. Every metadata field is mandatory; legacy manifests fail
     * closed before {@code mh_ota} can be sent.
     */
    public static ValidatedBesArtifact validate(File artifact, JSONObject metadata)
            throws ValidationException {
        try {
            if (artifact == null || !artifact.isFile()) {
                throw new ValidationException("BES OTA artifact is missing");
            }
            if (metadata == null) {
                throw new ValidationException("BES OTA release metadata is missing");
            }

            String format = requiredString(metadata, "format");
            if (!AsgConstants.BES_OTA_ARTIFACT_FORMAT.equals(format)) {
                throw new ValidationException("Unsupported BES OTA artifact format: " + format);
            }

            String product = requiredString(metadata, "product");
            if (!AsgConstants.BES_OTA_PRODUCT.equals(product)) {
                throw new ValidationException("Wrong BES OTA product: " + product);
            }

            String artifactId = requiredString(metadata, "artifact_id");
            validateImmutableUrl(metadata, artifactId);

            long compressedSize = requiredPositiveLong(metadata, "compressed_size");
            if (compressedSize != artifact.length()) {
                throw new ValidationException(
                        "Compressed size mismatch: expected "
                                + compressedSize
                                + ", got "
                                + artifact.length());
            }

            byte[] container = readArtifact(artifact);
            String compressedSha256 = requiredSha256(metadata, "sha256");
            assertSha256(container, compressedSha256, "compressed");

            long expectedRawSize = requiredPositiveLong(metadata, "decompressed_size");
            if (expectedRawSize >= AsgConstants.BES_OTA_MAX_DECOMPRESSED_IMAGE_BYTES) {
                throw new ValidationException(
                        "Decompressed BES image is not OTA-safe: " + expectedRawSize + " bytes");
            }

            byte[] raw = unpackAndValidateContainer(container);
            if (raw.length != expectedRawSize) {
                throw new ValidationException(
                        "Decompressed size mismatch: expected "
                                + expectedRawSize
                                + ", got "
                                + raw.length);
            }
            String decompressedSha256 = requiredSha256(metadata, "decompressed_sha256");
            assertSha256(raw, decompressedSha256, "decompressed");
            assertProduct(raw, product);
            String targetVersion = requiredString(metadata, "version");
            String canonicalTarget = BesOtaStateStore.canonicalVersion(targetVersion);
            if (canonicalTarget == null || !canonicalTarget.equals(targetVersion)) {
                throw new ValidationException(
                        "BES target version must be canonical major.minor.patch.build");
            }
            assertVersion(raw, targetVersion, metadata.getLong("version_offset"));
            return new ValidatedBesArtifact(
                    artifact,
                    artifactId,
                    compressedSha256,
                    decompressedSha256,
                    targetVersion,
                    compressedSize,
                    expectedRawSize);
        } catch (ValidationException e) {
            throw e;
        } catch (Exception e) {
            throw new ValidationException("Invalid BES OTA artifact: " + e.getMessage(), e);
        }
    }

    private static byte[] readArtifact(File artifact) throws IOException, ValidationException {
        if (artifact.length() <= 0 || artifact.length() > Integer.MAX_VALUE) {
            throw new ValidationException("Invalid BES OTA artifact size: " + artifact.length());
        }
        byte[] bytes = new byte[(int) artifact.length()];
        int offset = 0;
        try (FileInputStream input = new FileInputStream(artifact)) {
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) {
                    throw new IOException("Unexpected end of BES OTA artifact");
                }
                offset += read;
            }
            if (input.read() != -1) {
                throw new IOException("BES OTA artifact changed while being read");
            }
        }
        return bytes;
    }

    private static byte[] unpackAndValidateContainer(byte[] data) throws Exception {
        if (data.length < MAGIC.length || !startsWith(data, 0, MAGIC)) {
            throw new ValidationException("BES OTA container magic is invalid");
        }

        int position = MAGIC.length;
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        while (!startsWith(data, position, CRC_PREFIX)) {
            if (position + 4 > data.length) {
                throw new ValidationException("BES OTA container ended before a chunk header");
            }
            int chunkSize = readBigEndianInt(data, position);
            position += 4;
            if (chunkSize < LZMA_ALONE_HEADER_LENGTH || (long) position + chunkSize > data.length) {
                throw new ValidationException("Invalid or truncated BES OTA LZMA chunk");
            }

            ByteArrayInputStream compressed = new ByteArrayInputStream(data, position, chunkSize);
            try (LZMAInputStream lzma = new LZMAInputStream(compressed)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = lzma.read(buffer)) != -1) {
                    if ((long) raw.size() + read
                            >= AsgConstants.BES_OTA_MAX_DECOMPRESSED_IMAGE_BYTES) {
                        throw new ValidationException(
                                "Decompressed BES image reaches the OTA bootloader limit");
                    }
                    raw.write(buffer, 0, read);
                }
            }
            if (compressed.available() != 0) {
                throw new ValidationException("BES OTA LZMA chunk has trailing bytes");
            }
            position += chunkSize;
        }

        validateCrcTrailer(data, position);
        return raw.toByteArray();
    }

    private static void validateCrcTrailer(byte[] data, int prefixOffset)
            throws ValidationException {
        int hexOffset = prefixOffset + CRC_PREFIX.length;
        int newlineOffset = hexOffset + CRC_HEX_LENGTH;
        if (newlineOffset >= data.length
                || data.length != newlineOffset + 1
                || data[newlineOffset] != '\n') {
            throw new ValidationException("BES OTA CRC trailer is incomplete or has extra bytes");
        }

        String storedHex = new String(data, hexOffset, CRC_HEX_LENGTH, StandardCharsets.US_ASCII);
        if (!storedHex.matches("[0-9A-Fa-f]{8}") || "00000000".equals(storedHex)) {
            throw new ValidationException("BES OTA CRC trailer is invalid or unpatched");
        }

        CRC32 crc = new CRC32();
        crc.update(data, 0, hexOffset);
        long expected = Long.parseUnsignedLong(storedHex, 16);
        if (crc.getValue() != expected) {
            throw new ValidationException("BES OTA embedded CRC32 does not match the artifact");
        }
    }

    private static void assertProduct(byte[] raw, String product) throws ValidationException {
        byte[] revInfo = "REV_INFO=".getBytes(StandardCharsets.US_ASCII);
        byte[] productSuffix = (":" + product).getBytes(StandardCharsets.US_ASCII);
        int revOffset = indexOf(raw, revInfo, 0);
        while (revOffset >= 0) {
            int searchEnd = Math.min(raw.length, revOffset + 192);
            int productOffset = indexOf(raw, productSuffix, revOffset + revInfo.length);
            if (productOffset >= 0 && productOffset < searchEnd) {
                return;
            }
            revOffset = indexOf(raw, revInfo, revOffset + 1);
        }
        throw new ValidationException(
                "Decompressed image does not identify the Mentra Live BES product");
    }

    private static void assertVersion(byte[] raw, String version, long offsetLong)
            throws ValidationException {
        String[] parts = version.split("\\.", -1);
        if (parts.length != 4 || offsetLong < 0 || offsetLong > raw.length - 4L) {
            throw new ValidationException("Invalid BES target version metadata");
        }
        int offset = (int) offsetLong;
        for (int i = 0; i < parts.length; i++) {
            int component;
            try {
                component = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                throw new ValidationException("Invalid BES target version: " + version);
            }
            if (component < 0 || component > 255 || (raw[offset + i] & 0xFF) != component) {
                throw new ValidationException(
                        "Decompressed image target version does not match " + version);
            }
        }
    }

    private static void validateImmutableUrl(JSONObject metadata, String artifactId)
            throws Exception {
        if (!artifactId.matches("[A-Za-z0-9._-]{1,128}")) {
            throw new ValidationException("Invalid BES OTA artifact_id");
        }
        String urlValue = metadata.optString("url", metadata.optString("firmwareUrl", "")).trim();
        URI uri = new URI(urlValue);
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || uri.getHost() == null
                || uri.getRawQuery() != null
                || uri.getRawFragment() != null
                || uri.getPath() == null
                || !uri.getPath().endsWith("/" + artifactId)) {
            throw new ValidationException(
                    "BES OTA URL must be immutable HTTPS and end with artifact_id");
        }
    }

    private static String requiredString(JSONObject metadata, String key)
            throws ValidationException {
        String value = metadata.optString(key, "").trim();
        if (value.isEmpty()) {
            throw new ValidationException("Missing BES OTA metadata: " + key);
        }
        return value;
    }

    private static long requiredPositiveLong(JSONObject metadata, String key)
            throws ValidationException {
        if (!metadata.has(key)) {
            throw new ValidationException("Missing BES OTA metadata: " + key);
        }
        long value = metadata.optLong(key, -1);
        if (value <= 0) {
            throw new ValidationException("Invalid BES OTA metadata: " + key);
        }
        return value;
    }

    private static String requiredSha256(JSONObject metadata, String key)
            throws ValidationException {
        String value = requiredString(metadata, key).toLowerCase(Locale.US);
        if (!value.matches("[0-9a-f]{64}")) {
            throw new ValidationException("Invalid BES OTA SHA-256 metadata: " + key);
        }
        return value;
    }

    private static void assertSha256(byte[] bytes, String expected, String label) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder actual = new StringBuilder(digest.length * 2);
        for (byte value : digest) {
            actual.append(String.format(Locale.US, "%02x", value & 0xFF));
        }
        if (!actual.toString().equals(expected)) {
            throw new ValidationException(label + " BES OTA SHA-256 mismatch");
        }
    }

    private static boolean startsWith(byte[] haystack, int offset, byte[] needle) {
        if (offset < 0 || offset > haystack.length - needle.length) {
            return false;
        }
        for (int i = 0; i < needle.length; i++) {
            if (haystack[offset + i] != needle[i]) {
                return false;
            }
        }
        return true;
    }

    private static int indexOf(byte[] haystack, byte[] needle, int fromIndex) {
        for (int i = Math.max(0, fromIndex); i <= haystack.length - needle.length; i++) {
            if (startsWith(haystack, i, needle)) {
                return i;
            }
        }
        return -1;
    }

    private static int readBigEndianInt(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }

    /** Validation failure safe to log in full while the phone receives a stable short code. */
    public static final class ValidatedBesArtifact {
        private final File file;
        private final String artifactId;
        private final String compressedSha256;
        private final String decompressedSha256;
        private final String targetVersion;
        private final long compressedSize;
        private final long decompressedSize;

        private ValidatedBesArtifact(
                File file,
                String artifactId,
                String compressedSha256,
                String decompressedSha256,
                String targetVersion,
                long compressedSize,
                long decompressedSize) {
            this.file = file;
            this.artifactId = artifactId;
            this.compressedSha256 = compressedSha256;
            this.decompressedSha256 = decompressedSha256;
            this.targetVersion = targetVersion;
            this.compressedSize = compressedSize;
            this.decompressedSize = decompressedSize;
        }

        /** Close the validation-to-use race before authorization is reserved. */
        public void revalidateFileDigest() throws ValidationException {
            try {
                if (!file.isFile() || file.length() != compressedSize) {
                    throw new ValidationException("BES OTA artifact changed after validation");
                }
                assertSha256(readArtifact(file), compressedSha256, "compressed");
            } catch (ValidationException e) {
                throw e;
            } catch (Exception e) {
                throw new ValidationException("Could not revalidate BES OTA artifact", e);
            }
        }

        public File getFile() {
            return file;
        }

        public String getArtifactId() {
            return artifactId;
        }

        public String getCompressedSha256() {
            return compressedSha256;
        }

        public String getDecompressedSha256() {
            return decompressedSha256;
        }

        public String getTargetVersion() {
            return targetVersion;
        }

        public long getCompressedSize() {
            return compressedSize;
        }

        public long getDecompressedSize() {
            return decompressedSize;
        }
    }

    public static final class ValidationException extends Exception {
        ValidationException(String message) {
            super(message);
        }

        ValidationException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
