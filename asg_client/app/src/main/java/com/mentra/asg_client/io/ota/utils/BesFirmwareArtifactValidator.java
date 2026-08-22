package com.mentra.asg_client.io.ota.utils;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.BesOtaStateStore;
import com.mentra.asg_client.io.bes.util.BesOtaUtil;

import org.json.JSONObject;
import org.tukaani.xz.LZMAInputStream;

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

/** Fail-closed admission gate for a release-packaged Mentra Live BES OTA artifact. */
public final class BesFirmwareArtifactValidator {
    private static final byte[] MAGIC = {(byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF};
    private static final byte[] CRC_PREFIX =
            "CRC32_OF_IMAGE=0x".getBytes(StandardCharsets.US_ASCII);
    private static final int CRC_HEX_LENGTH = 8;
    private static final int LZMA_ALONE_HEADER_LENGTH = 13;
    // The release packer uses `lzma -9`, whose LZMA-alone header declares a 64 MiB
    // dictionary even though the BES image is under 2 MiB. Admit that exact ceiling,
    // but reject hostile headers before the decoder allocates its dictionary.
    private static final long MAX_LZMA_DICTIONARY_BYTES = 64L * 1024 * 1024;
    private static final int MAX_LZMA_DECODER_MEMORY_KIB = 70 * 1024;

    private BesFirmwareArtifactValidator() {}

    /**
     * Validate the existing manifest contract plus every safety property that can be proven from
     * the downloaded artifact itself. Validation completes before {@code mh_ota} can be sent.
     */
    public static ValidatedBesArtifact validate(File artifact, JSONObject metadata)
            throws ValidationException {
        try {
            if (metadata == null) {
                throw new ValidationException("BES OTA release metadata is missing");
            }

            String artifactId = artifactIdFromUrl(metadata);
            String compressedSha256 = requiredSha256(metadata, "sha256");
            String targetVersion = requiredString(metadata, "version");
            return validateKnownIdentity(
                    artifact, artifactId, compressedSha256, targetVersion, false);
        } catch (ValidationException e) {
            throw e;
        } catch (Exception e) {
            throw new ValidationException("Invalid BES OTA artifact: " + e.getMessage(), e);
        }
    }

    /**
     * Validate an ADB-staged release container with explicit immutable identity metadata.
     *
     * <p>This performs the same byte, digest, product, size, and target validation as the
     * phone-owned manifest path. It exists so the privileged debug receiver can exercise the
     * production BES state machine without inventing an HTTPS URL for a local artifact.
     */
    public static ValidatedBesArtifact validateLocal(
            File artifact, String artifactId, String expectedSha256, String targetVersion)
            throws ValidationException {
        try {
            String canonicalArtifactId = artifactId == null ? "" : artifactId.trim();
            if (!canonicalArtifactId.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new ValidationException("BES OTA artifact has an invalid identifier");
            }
            String canonicalSha256 = normalizeSha256(expectedSha256, null);
            return validateKnownIdentity(
                    artifact, canonicalArtifactId, canonicalSha256, targetVersion, true);
        } catch (ValidationException e) {
            throw e;
        } catch (Exception e) {
            throw new ValidationException("Invalid BES OTA artifact: " + e.getMessage(), e);
        }
    }

    private static ValidatedBesArtifact validateKnownIdentity(
            File artifact,
            String artifactId,
            String compressedSha256,
            String targetVersion,
            boolean ephemeralSource)
            throws Exception {
        if (artifact == null || !artifact.isFile()) {
            throw new ValidationException("BES OTA artifact is missing");
        }

        long compressedSize = artifact.length();
        byte[] container = readArtifact(artifact);
        assertSha256(container, compressedSha256, "compressed");

        byte[] raw = unpackAndValidateContainer(container);
        assertProduct(raw, AsgConstants.BES_OTA_PRODUCT);
        String canonicalTarget = BesOtaStateStore.canonicalVersion(targetVersion);
        if (canonicalTarget == null) {
            throw new ValidationException(
                    "BES target version must contain four numeric byte components");
        }
        return new ValidatedBesArtifact(
                artifact,
                artifactId,
                compressedSha256,
                canonicalTarget,
                compressedSize,
                raw.length,
                ephemeralSource);
    }

    private static byte[] readArtifact(File artifact) throws IOException, ValidationException {
        if (artifact.length() <= 0 || artifact.length() > BesOtaUtil.MAX_FILE_SIZE) {
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
            long dictionarySize = readLittleEndianUnsignedInt(data, position + 1);
            if (dictionarySize <= 0 || dictionarySize > MAX_LZMA_DICTIONARY_BYTES) {
                throw new ValidationException(
                        "BES OTA LZMA dictionary exceeds the admission limit: " + dictionarySize);
            }

            ByteArrayInputStream compressed = new ByteArrayInputStream(data, position, chunkSize);
            try (LZMAInputStream lzma =
                    new LZMAInputStream(compressed, MAX_LZMA_DECODER_MEMORY_KIB)) {
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
        String productSuffix = ":" + product;
        int revOffset = indexOf(raw, revInfo, 0);
        while (revOffset >= 0) {
            int searchEnd = Math.min(raw.length, revOffset + 192);
            int valueStart = revOffset + revInfo.length;
            int valueEnd = valueStart;
            while (valueEnd < searchEnd
                    && raw[valueEnd] != 0
                    && raw[valueEnd] != '\n'
                    && raw[valueEnd] != '\r') {
                valueEnd++;
            }
            String revision =
                    new String(raw, valueStart, valueEnd - valueStart, StandardCharsets.US_ASCII);
            if (revision.endsWith(productSuffix)) {
                return;
            }
            revOffset = indexOf(raw, revInfo, revOffset + 1);
        }
        throw new ValidationException(
                "Decompressed image does not identify the Mentra Live BES product");
    }

    private static String artifactIdFromUrl(JSONObject metadata) throws Exception {
        String urlValue = metadata.optString("url", metadata.optString("firmwareUrl", "")).trim();
        URI uri = new URI(urlValue);
        if (uri.getHost() == null
                || uri.getRawQuery() != null
                || uri.getRawFragment() != null
                || uri.getPath() == null
                || uri.getPath().endsWith("/")) {
            throw new ValidationException(
                    "BES OTA URL must identify an artifact without query or fragment");
        }
        String artifactId = uri.getPath().substring(uri.getPath().lastIndexOf('/') + 1);
        if (!artifactId.matches("[A-Za-z0-9._-]{1,128}")) {
            throw new ValidationException("BES OTA URL has an invalid artifact name");
        }
        return artifactId;
    }

    private static String requiredString(JSONObject metadata, String key)
            throws ValidationException {
        String value = metadata.optString(key, "").trim();
        if (value.isEmpty()) {
            throw new ValidationException("Missing BES OTA metadata: " + key);
        }
        return value;
    }

    private static String requiredSha256(JSONObject metadata, String key)
            throws ValidationException {
        return normalizeSha256(requiredString(metadata, key), key);
    }

    private static String normalizeSha256(String value, String key) throws ValidationException {
        value = value == null ? "" : value.trim().toLowerCase(Locale.US);
        if (!value.matches("[0-9a-f]{64}")) {
            throw new ValidationException(
                    "Invalid BES OTA SHA-256 metadata" + (key == null ? "" : ": " + key));
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

    private static long readLittleEndianUnsignedInt(byte[] data, int offset) {
        return ((long) data[offset] & 0xFF)
                | (((long) data[offset + 1] & 0xFF) << 8)
                | (((long) data[offset + 2] & 0xFF) << 16)
                | (((long) data[offset + 3] & 0xFF) << 24);
    }

    /** Validation failure safe to log in full while the phone receives a stable short code. */
    public static final class ValidatedBesArtifact {
        private final File file;
        private final String artifactId;
        private final String compressedSha256;
        private final String targetVersion;
        private final long compressedSize;
        private final long decompressedSize;
        private final boolean ephemeralSource;

        private ValidatedBesArtifact(
                File file,
                String artifactId,
                String compressedSha256,
                String targetVersion,
                long compressedSize,
                long decompressedSize,
                boolean ephemeralSource) {
            this.file = file;
            this.artifactId = artifactId;
            this.compressedSha256 = compressedSha256;
            this.targetVersion = targetVersion;
            this.compressedSize = compressedSize;
            this.decompressedSize = decompressedSize;
            this.ephemeralSource = ephemeralSource;
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

        public String getTargetVersion() {
            return targetVersion;
        }

        public long getCompressedSize() {
            return compressedSize;
        }

        public long getDecompressedSize() {
            return decompressedSize;
        }

        /** Delete ADB-staged bytes while preserving artifacts owned by the phone manifest. */
        public boolean deleteSourceIfEphemeral() {
            return !ephemeralSource || !file.exists() || file.delete();
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
