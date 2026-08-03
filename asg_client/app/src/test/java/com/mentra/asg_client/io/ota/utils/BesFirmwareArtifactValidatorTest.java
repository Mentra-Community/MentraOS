package com.mentra.asg_client.io.ota.utils;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mentra.asg_client.AsgConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.CRC32;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.tukaani.xz.LZMA2Options;
import org.tukaani.xz.LZMAOutputStream;

public class BesFirmwareArtifactValidatorTest {
    private static final byte[] CRC_PREFIX =
            "CRC32_OF_IMAGE=0x".getBytes(StandardCharsets.US_ASCII);
    private static final int VERSION_OFFSET = 64;

    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void releasePackagedArtifactWithExactIdentityPasses() throws Exception {
        TestArtifact artifact = createArtifact();

        BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);
    }

    @Test
    public void externalReleaseArtifactCanBeCheckedAgainstItsRawBuildOutput() throws Exception {
        String artifactPath = System.getenv("BES_RELEASE_ARTIFACT");
        String rawPath = System.getenv("BES_RELEASE_RAW");
        String version = System.getenv("BES_RELEASE_VERSION");
        String versionOffset = System.getenv("BES_RELEASE_VERSION_OFFSET");
        Assume.assumeTrue(
                artifactPath != null
                        && rawPath != null
                        && version != null
                        && versionOffset != null);

        File artifact = new File(artifactPath);
        byte[] container = Files.readAllBytes(artifact.toPath());
        byte[] raw = Files.readAllBytes(new File(rawPath).toPath());
        JSONObject metadata = new JSONObject();
        metadata.put("format", AsgConstants.BES_OTA_ARTIFACT_FORMAT);
        metadata.put("product", AsgConstants.BES_OTA_PRODUCT);
        metadata.put("artifact_id", artifact.getName());
        metadata.put("url", "https://releases.example.invalid/" + artifact.getName());
        metadata.put("compressed_size", container.length);
        metadata.put("sha256", sha256(container));
        metadata.put("decompressed_size", raw.length);
        metadata.put("decompressed_sha256", sha256(raw));
        metadata.put("version", version);
        metadata.put("version_offset", Long.parseLong(versionOffset));

        BesFirmwareArtifactValidator.validate(artifact, metadata);
    }

    @Test
    public void legacyManifestWithoutAdmissionMetadataFailsClosed() throws Exception {
        TestArtifact artifact = createArtifact();
        JSONObject legacy = new JSONObject();
        legacy.put("url", artifact.metadata.getString("url"));
        legacy.put("sha256", artifact.metadata.getString("sha256"));

        assertThatThrownBy(() -> BesFirmwareArtifactValidator.validate(artifact.file, legacy))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("format");
    }

    @Test
    public void decompressedImageAtBootloaderLimitFailsBeforeAuthorization() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put(
                "decompressed_size", AsgConstants.BES_OTA_MAX_DECOMPRESSED_IMAGE_BYTES);

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("not OTA-safe");
    }

    @Test
    public void corruptContainerFailsEvenWhenManifestHashMatchesCorruptBytes() throws Exception {
        TestArtifact artifact = createArtifact();
        byte[] corrupt = java.nio.file.Files.readAllBytes(artifact.file.toPath());
        corrupt[0] = 0;
        write(artifact.file, corrupt);
        artifact.metadata.put("sha256", sha256(corrupt));

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("magic");
    }

    @Test
    public void wrongEmbeddedProductOrVersionFailsClosed() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put("product", "different_product");

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("Wrong BES OTA product");

        artifact.metadata.put("product", AsgConstants.BES_OTA_PRODUCT);
        artifact.metadata.put("version", "17.26.7.25");
        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("target version");
    }

    private TestArtifact createArtifact() throws Exception {
        byte[] raw = new byte[512];
        for (int i = 0; i < raw.length; i++) {
            raw[i] = (byte) (i * 31);
        }
        raw[VERSION_OFFSET] = 17;
        raw[VERSION_OFFSET + 1] = 26;
        raw[VERSION_OFFSET + 2] = 7;
        raw[VERSION_OFFSET + 3] = 24;
        byte[] revision =
                ("REV_INFO=release-a:" + AsgConstants.BES_OTA_PRODUCT)
                        .getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(revision, 0, raw, 192, revision.length);

        ByteArrayOutputStream compressed = new ByteArrayOutputStream();
        try (LZMAOutputStream lzma =
                new LZMAOutputStream(compressed, new LZMA2Options(), raw.length)) {
            lzma.write(raw);
        }

        byte[] chunk = compressed.toByteArray();
        ByteArrayOutputStream containerHead = new ByteArrayOutputStream();
        containerHead.write(new byte[] {(byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF});
        writeBigEndianInt(containerHead, chunk.length);
        containerHead.write(chunk);
        containerHead.write(CRC_PREFIX);

        CRC32 crc = new CRC32();
        byte[] crcInput = containerHead.toByteArray();
        crc.update(crcInput);
        containerHead.write(
                String.format(Locale.US, "%08X\n", crc.getValue())
                        .getBytes(StandardCharsets.US_ASCII));
        byte[] container = containerHead.toByteArray();

        String artifactId = "release-a-test-update_ota.bin";
        File file = temporaryFolder.newFile(artifactId);
        write(file, container);

        JSONObject metadata = new JSONObject();
        metadata.put("format", AsgConstants.BES_OTA_ARTIFACT_FORMAT);
        metadata.put("product", AsgConstants.BES_OTA_PRODUCT);
        metadata.put("artifact_id", artifactId);
        metadata.put("url", "https://releases.example.invalid/" + artifactId);
        metadata.put("compressed_size", container.length);
        metadata.put("sha256", sha256(container));
        metadata.put("decompressed_size", raw.length);
        metadata.put("decompressed_sha256", sha256(raw));
        metadata.put("version", "17.26.7.24");
        metadata.put("version_offset", VERSION_OFFSET);
        return new TestArtifact(file, metadata);
    }

    private static void writeBigEndianInt(ByteArrayOutputStream output, int value) {
        output.write((value >>> 24) & 0xFF);
        output.write((value >>> 16) & 0xFF);
        output.write((value >>> 8) & 0xFF);
        output.write(value & 0xFF);
    }

    private static void write(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(bytes);
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder value = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            value.append(String.format(Locale.US, "%02x", b & 0xFF));
        }
        return value.toString();
    }

    private static final class TestArtifact {
        final File file;
        final JSONObject metadata;

        TestArtifact(File file, JSONObject metadata) {
            this.file = file;
            this.metadata = metadata;
        }
    }
}
