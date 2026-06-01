package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.File;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoExifMetadataWriterTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void writeAndReadImuRoundtrip() throws Exception {
        File jpeg = tempFolder.newFile("photo.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);

        JSONObject payload = samplePayload(3);
        PhotoExifMetadataWriter.writeImuPayload(jpeg.getAbsolutePath(), payload);

        String readBack = PhotoExifMetadataWriter.readImuJsonFromJpeg(jpeg.getAbsolutePath());
        assertThat(readBack).isNotNull();
        JSONObject parsed = new JSONObject(readBack);
        assertThat(parsed.getInt("sampleCount")).isEqualTo(3);
        assertThat(parsed.getJSONArray("samples").length()).isEqualTo(3);
        assertThat(PhotoExifMetadataWriter.hasImuMetadata(jpeg.getAbsolutePath())).isTrue();
    }

    @Test
    public void copyImuMetadataPreservesUserCommentOnReencodedJpeg() throws Exception {
        File source = tempFolder.newFile("source.jpg");
        File dest = tempFolder.newFile("dest.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(source);
        PhotoExifMetadataWriter.writeMinimalJpegForTest(dest);

        PhotoExifMetadataWriter.writeImuPayload(source.getAbsolutePath(), samplePayload(2));
        PhotoExifMetadataWriter.copyImuMetadata(source.getAbsolutePath(), dest.getAbsolutePath());

        String destJson = PhotoExifMetadataWriter.readImuJsonFromJpeg(dest.getAbsolutePath());
        assertThat(new JSONObject(destJson).getInt("sampleCount")).isEqualTo(2);
    }

    @Test
    public void buildExifApp1SegmentStartsWithExifHeader() throws Exception {
        byte[] segment = PhotoExifMetadataWriter.buildExifApp1Segment(samplePayload(1));
        assertThat(segment.length).isGreaterThan(10);
        assertThat(segment[0] & 0xFF).isEqualTo(0xFF);
        assertThat(segment[1] & 0xFF).isEqualTo(0xE1);
        assertThat(segment[4]).isEqualTo((byte) 'E');
        assertThat(segment[5]).isEqualTo((byte) 'x');
    }

    @Test
    public void injectExifIntoHeifCoderAvifFixture() throws Exception {
        byte[] avif =
                java.nio.file.Files.readAllBytes(
                        new File("src/test/resources/avif/heifcoder_sample.avif").toPath());
        byte[] segment = PhotoExifMetadataWriter.buildExifApp1Segment(samplePayload(2));
        byte[] exifTiff = java.util.Arrays.copyOfRange(segment, 4, segment.length);
        byte[] withExif = AvifBmffExifInjector.injectExif(avif, exifTiff);
        assertThat(withExif.length).isGreaterThan(avif.length);
        assertThat(PhotoExifMetadataWriter.containsExifMarker(withExif)).isTrue();
    }

    @Test
    public void trimPayloadForExifCapsSampleCount() throws Exception {
        JSONObject large = samplePayload(500);
        JSONObject trimmed = PhotoExifMetadataWriter.trimPayloadForExif(large);
        assertThat(trimmed.getJSONArray("samples").length()).isEqualTo(400);
        assertThat(trimmed.getBoolean("exifTruncated")).isTrue();
    }

    private static JSONObject samplePayload(int sampleCount) throws Exception {
        JSONObject root = new JSONObject();
        root.put("version", 1);
        root.put("sampleCount", sampleCount);
        root.put("samplingRateHz", 100);
        root.put("startTimeNs", 1_000_000L);
        root.put("durationMs", sampleCount * 10);
        JSONArray samples = new JSONArray();
        for (int i = 0; i < sampleCount; i++) {
            JSONArray sample = new JSONArray();
            sample.put(i * 10);
            sample.put(0.1);
            sample.put(0.2);
            sample.put(9.8);
            sample.put(0.01);
            sample.put(0.02);
            sample.put(0.03);
            samples.put(sample);
        }
        root.put("samples", samples);
        return root;
    }
}
