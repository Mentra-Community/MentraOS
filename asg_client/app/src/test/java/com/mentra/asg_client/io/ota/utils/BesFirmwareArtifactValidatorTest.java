package com.mentra.asg_client.io.ota.utils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.tukaani.xz.LZMA2Options;
import org.tukaani.xz.LZMAOutputStream;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.CRC32;

public class BesFirmwareArtifactValidatorTest {
    private static final byte[] CRC_PREFIX =
            "CRC32_OF_IMAGE=0x".getBytes(StandardCharsets.US_ASCII);
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void releasePackagedArtifactWithExactIdentityPasses() throws Exception {
        TestArtifact artifact = createArtifact();

        BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);
    }

    @Test
    public void httpArtifactWithExactIdentityPasses() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put("url", "http://192.168.43.159:8791/artifacts/local-bes.bin");

        BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);
    }

    @Test
    public void nonHttpArtifactUrlFailsBeforeDownload() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put("url", "ftp://releases.example.invalid/update_ota.bin");

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("HTTP or HTTPS");
    }

    @Test
    public void localReleasePackagedArtifactWithExplicitIdentityPasses() throws Exception {
        TestArtifact artifact = createArtifact();

        BesFirmwareArtifactValidator.ValidatedBesArtifact validated =
                BesFirmwareArtifactValidator.validateLocal(
                        artifact.file,
                        "adb-17.26.7.24.bin",
                        artifact.metadata.getString("sha256"),
                        "17.26.7.24");

        assertThat(validated.getArtifactId()).isEqualTo("adb-17.26.7.24.bin");
        assertThat(validated.getTargetVersion()).isEqualTo("17.26.7.24");
    }

    @Test
    public void localArtifactSupportsEphemeralCleanup() throws Exception {
        TestArtifact artifact = createArtifact();
        BesFirmwareArtifactValidator.ValidatedBesArtifact validated =
                BesFirmwareArtifactValidator.validateLocal(
                        artifact.file,
                        "adb-17.26.7.24.bin",
                        artifact.metadata.getString("sha256"),
                        "17.26.7.24");

        assertThat(validated.deleteSourceIfEphemeral()).isTrue();
        assertThat(artifact.file).doesNotExist();
    }

    @Test
    public void manifestArtifactIgnoresEphemeralCleanup() throws Exception {
        TestArtifact artifact = createArtifact();
        BesFirmwareArtifactValidator.ValidatedBesArtifact validated =
                BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);

        assertThat(validated.deleteSourceIfEphemeral()).isTrue();
        assertThat(artifact.file).exists();
    }

    @Test
    public void localArtifactRejectsUnsafeIdentity() throws Exception {
        TestArtifact artifact = createArtifact();

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validateLocal(
                                        artifact.file,
                                        "../../update_ota.bin",
                                        artifact.metadata.getString("sha256"),
                                        "17.26.7.24"))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("identifier");
    }

    @Test
    public void localArtifactRejectsIncorrectDigest() throws Exception {
        TestArtifact artifact = createArtifact();

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validateLocal(
                                        artifact.file,
                                        "adb-17.26.7.24.bin",
                                        "0".repeat(64),
                                        "17.26.7.24"))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("SHA-256 mismatch");
    }

    @Test
    public void externalReleaseArtifactCanBeValidated() throws Exception {
        String artifactPath = System.getenv("BES_RELEASE_ARTIFACT");
        String version = System.getenv("BES_RELEASE_VERSION");
        Assume.assumeTrue(artifactPath != null && version != null);

        File artifact = new File(artifactPath);
        byte[] container = Files.readAllBytes(artifact.toPath());
        JSONObject metadata = new JSONObject();
        metadata.put("url", "https://releases.example.invalid/" + artifact.getName());
        metadata.put("sha256", sha256(container));
        metadata.put("version", version);

        BesFirmwareArtifactValidator.validate(artifact, metadata);
    }

    @Test
    public void existingManifestShapePasses() throws Exception {
        TestArtifact artifact = createArtifact();
        JSONObject existing = new JSONObject();
        existing.put("version", artifact.metadata.getString("version"));
        existing.put("url", artifact.metadata.getString("url"));
        existing.put("sha256", artifact.metadata.getString("sha256"));

        BesFirmwareArtifactValidator.validate(artifact.file, existing);
    }

    @Test
    public void decompressedImageAtBootloaderLimitFailsBeforeAuthorization() throws Exception {
        TestArtifact artifact =
                createArtifact(
                        createRaw(
                                AsgConstants.BES_OTA_MAX_DECOMPRESSED_IMAGE_BYTES,
                                "release-a:" + AsgConstants.BES_OTA_PRODUCT));

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("bootloader limit");
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
    public void overflowingChunkLengthFailsAsTruncatedContainer() throws Exception {
        TestArtifact artifact = createArtifact();
        byte[] corrupt = {
            (byte) 0xFF,
            (byte) 0xFF,
            (byte) 0xFF,
            (byte) 0xFF,
            0x7F,
            (byte) 0xFF,
            (byte) 0xFF,
            (byte) 0xFF
        };
        write(artifact.file, corrupt);
        artifact.metadata.put("sha256", sha256(corrupt));

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("Invalid or truncated BES OTA LZMA chunk");
    }

    @Test
    public void oversizedLzmaDictionaryFailsBeforeDecoderAllocation() throws Exception {
        TestArtifact artifact = createArtifact();
        byte[] hostile = Files.readAllBytes(artifact.file.toPath());
        // Container magic (4), chunk length (4), LZMA properties (1), then LE dictionary size.
        hostile[9] = 0;
        hostile[10] = 0;
        hostile[11] = 0;
        hostile[12] = 0x40; // 1 GiB
        write(artifact.file, hostile);
        artifact.metadata.put("sha256", sha256(hostile));

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("dictionary exceeds");
    }

    @Test
    public void productMustTerminateTheSameRevisionRecord() throws Exception {
        byte[] raw = createRaw("release-a:different_product");
        byte[] misleadingSuffix =
                (":" + AsgConstants.BES_OTA_PRODUCT).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(misleadingSuffix, 0, raw, 300, misleadingSuffix.length);
        TestArtifact artifact = createArtifact(raw);

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("does not identify");
    }

    @Test
    public void wrongEmbeddedProductFailsClosed() throws Exception {
        TestArtifact artifact = createArtifact(createRaw("release-a:different_product"));

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("does not identify");
    }

    @Test
    public void zeroPaddedTargetVersionIsNormalizedForVerification() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put("version", "017.26.7.24");

        BesFirmwareArtifactValidator.ValidatedBesArtifact validated =
                BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);

        assertThat(validated.getTargetVersion()).isEqualTo("17.26.7.24");
    }

    @Test
    public void nonNumericTargetVersionFailsBeforeAuthorization() throws Exception {
        TestArtifact artifact = createArtifact();
        artifact.metadata.put("version", "17.26.7.24-fix1");

        assertThatThrownBy(
                        () ->
                                BesFirmwareArtifactValidator.validate(
                                        artifact.file, artifact.metadata))
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("four numeric byte components");
    }

    @Test
    public void validatedArtifactDetectsSameSizeReplacementBeforeReservation() throws Exception {
        TestArtifact artifact = createArtifact();
        BesFirmwareArtifactValidator.ValidatedBesArtifact validated =
                BesFirmwareArtifactValidator.validate(artifact.file, artifact.metadata);
        byte[] replaced = Files.readAllBytes(artifact.file.toPath());
        replaced[replaced.length / 2] ^= 0x01;
        write(artifact.file, replaced);

        assertThatThrownBy(validated::revalidateFileDigest)
                .isInstanceOf(BesFirmwareArtifactValidator.ValidationException.class)
                .hasMessageContaining("SHA-256");
    }

    private TestArtifact createArtifact() throws Exception {
        return createArtifact(createRaw("release-a:" + AsgConstants.BES_OTA_PRODUCT));
    }

    private byte[] createRaw(String revisionValue) {
        return createRaw(512, revisionValue);
    }

    private byte[] createRaw(int size, String revisionValue) {
        byte[] raw = new byte[size];
        for (int i = 0; i < raw.length; i++) {
            raw[i] = (byte) (i * 31);
        }
        byte[] revision = ("REV_INFO=" + revisionValue).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(revision, 0, raw, 192, revision.length);
        raw[192 + revision.length] = 0;
        return raw;
    }

    private TestArtifact createArtifact(byte[] raw) throws Exception {
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
        metadata.put("url", "https://releases.example.invalid/" + artifactId);
        metadata.put("sha256", sha256(container));
        metadata.put("version", "17.26.7.24");
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
