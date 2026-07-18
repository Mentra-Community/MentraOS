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
    public void writeCaptureIdStampsImageUniqueIdFromCaptureDirName() throws Exception {
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_photoReq99");
        File jpeg = new File(captureDir, "base.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);

        PhotoExifMetadataWriter.writeCaptureIdFromPath(jpeg.getAbsolutePath());

        androidx.exifinterface.media.ExifInterface exif =
                new androidx.exifinterface.media.ExifInterface(jpeg.getAbsolutePath());
        assertThat(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_UNIQUE_ID))
                .isEqualTo("IMG_20260709_120000_123_456_photoReq99");
    }

    @Test
    public void writeCaptureIdCanUseIntendedCapturePathForCachedJpeg() throws Exception {
        File cacheDir = tempFolder.newFolder("text_mode_uploads");
        File cachedJpeg = new File(cacheDir, "transient.jpg");
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_cachedReq");
        File intendedJpeg = new File(captureDir, "base.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(cachedJpeg);

        PhotoExifMetadataWriter.writeCaptureIdFromPath(
                cachedJpeg.getAbsolutePath(), intendedJpeg.getAbsolutePath());

        androidx.exifinterface.media.ExifInterface exif =
                new androidx.exifinterface.media.ExifInterface(cachedJpeg.getAbsolutePath());
        assertThat(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_UNIQUE_ID))
                .isEqualTo("IMG_20260709_120000_123_456_cachedReq");
    }

    @Test
    public void writeCaptureIdIsNoOpOutsideCaptureDirectories() throws Exception {
        File jpeg = tempFolder.newFile("loose.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);

        PhotoExifMetadataWriter.writeCaptureIdFromPath(jpeg.getAbsolutePath());

        androidx.exifinterface.media.ExifInterface exif =
                new androidx.exifinterface.media.ExifInterface(jpeg.getAbsolutePath());
        assertThat(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_UNIQUE_ID))
                .isNull();
    }

    @Test
    public void copyImuMetadataAlsoCarriesImageUniqueId() throws Exception {
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_reqA");
        File source = new File(captureDir, "base.jpg");
        File dest = tempFolder.newFile("reencoded.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(source);
        PhotoExifMetadataWriter.writeMinimalJpegForTest(dest);

        PhotoExifMetadataWriter.writeCaptureIdFromPath(source.getAbsolutePath());
        PhotoExifMetadataWriter.copyImuMetadata(source.getAbsolutePath(), dest.getAbsolutePath());

        androidx.exifinterface.media.ExifInterface exif =
                new androidx.exifinterface.media.ExifInterface(dest.getAbsolutePath());
        assertThat(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_UNIQUE_ID))
                .isEqualTo("IMG_20260709_120000_123_456_reqA");
    }

    @Test
    public void imuWriteAfterCaptureIdPreservesImageUniqueId() throws Exception {
        // Production order: saveImageDataToFile stamps ImageUniqueID, then
        // finishImuRecording writes the IMU UserComment. The second save must not
        // clobber the first tag.
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_reqB");
        File jpeg = new File(captureDir, "base.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);

        PhotoExifMetadataWriter.writeCaptureIdFromPath(jpeg.getAbsolutePath());
        PhotoExifMetadataWriter.writeImuPayload(jpeg.getAbsolutePath(), samplePayload(2));

        androidx.exifinterface.media.ExifInterface exif =
                new androidx.exifinterface.media.ExifInterface(jpeg.getAbsolutePath());
        assertThat(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_UNIQUE_ID))
                .isEqualTo("IMG_20260709_120000_123_456_reqB");
        assertThat(PhotoExifMetadataWriter.hasImuMetadata(jpeg.getAbsolutePath())).isTrue();
    }

    @Test
    public void buildCaptureExifSegmentCarriesImuMetadata() throws Exception {
        File jpeg = tempFolder.newFile("source.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);
        PhotoExifMetadataWriter.writeImuPayload(jpeg.getAbsolutePath(), samplePayload(1));

        byte[] segment =
                PhotoExifMetadataWriter.buildCaptureExifApp1Segment(jpeg.getAbsolutePath());

        assertThat(segment).isNotNull();
        assertThat(segment[0] & 0xFF).isEqualTo(0xFF);
        assertThat(segment[1] & 0xFF).isEqualTo(0xE1);
        assertThat(segment[4]).isEqualTo((byte) 'E');
        assertThat(segment[5]).isEqualTo((byte) 'x');
    }

    @Test
    public void buildCaptureExifSegmentIsNullWithoutCaptureMetadata() throws Exception {
        File jpeg = tempFolder.newFile("plain.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);

        assertThat(PhotoExifMetadataWriter.buildCaptureExifApp1Segment(jpeg.getAbsolutePath()))
                .isNull();
    }

    @Test
    public void buildCaptureExifSegmentCarriesImageUniqueId() throws Exception {
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_reqC");
        File jpeg = new File(captureDir, "base.jpg");
        PhotoExifMetadataWriter.writeMinimalJpegForTest(jpeg);
        PhotoExifMetadataWriter.writeCaptureIdFromPath(jpeg.getAbsolutePath());

        byte[] segment =
                PhotoExifMetadataWriter.buildCaptureExifApp1Segment(jpeg.getAbsolutePath());

        assertThat(segment).isNotNull();
        assertThat(new String(segment, java.nio.charset.StandardCharsets.ISO_8859_1))
                .contains("IMG_20260709_120000_123_456_reqC");
    }

    @Test
    public void ramFirstExifSegmentCarriesPayloadAndIntendedCaptureId() throws Exception {
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_ramReq");
        String intendedPath = new File(captureDir, "base.jpg").getAbsolutePath();

        byte[] segment =
                PhotoExifMetadataWriter.buildCaptureExifApp1Segment(
                        samplePayload(2), intendedPath);

        assertThat(segment).isNotNull();
        String bytes = new String(segment, java.nio.charset.StandardCharsets.ISO_8859_1);
        assertThat(bytes).contains("IMG_20260709_120000_123_456_ramReq");
        assertThat(bytes).contains("sampleCount");
    }

    @Test
    public void ramFirstExifSegmentCarriesCaptureIdWithoutImu() throws Exception {
        File captureDir = tempFolder.newFolder("IMG_20260709_120000_123_456_noImu");
        String intendedPath = new File(captureDir, "base.jpg").getAbsolutePath();

        byte[] segment =
                PhotoExifMetadataWriter.buildCaptureExifApp1Segment(null, intendedPath);

        assertThat(segment).isNotNull();
        assertThat(new String(segment, java.nio.charset.StandardCharsets.ISO_8859_1))
                .contains("IMG_20260709_120000_123_456_noImu");
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
