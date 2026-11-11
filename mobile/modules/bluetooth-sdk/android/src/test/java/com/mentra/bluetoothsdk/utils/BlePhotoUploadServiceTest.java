package com.mentra.bluetoothsdk.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.Color;

import androidx.exifinterface.media.ExifInterface;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.FileOutputStream;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31)
public class BlePhotoUploadServiceTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void processAndSavePhoto_keepsAJpegOnThePhoneUnchanged() throws Exception {
        byte[] jpeg = {(byte) 0xFF, (byte) 0xD8, 1, 2, 3, (byte) 0xFF, (byte) 0xD9};
        File directory = new File(tempFolder.getRoot(), "photos/local");
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        File[] saved = new File[1];
        String[] failure = new String[1];
        BlePhotoUploadService.processAndSavePhoto(
                jpeg,
                "0001",
                directory,
                new BlePhotoUploadService.SaveCallback() {
                    @Override
                    public void onSaved(String requestId, File file) {
                        assertThat(requestId).isEqualTo("0001");
                        saved[0] = file;
                        done.countDown();
                    }

                    @Override
                    public void onError(String requestId, String error) {
                        failure[0] = error;
                        done.countDown();
                    }
                });
        assertThat(done.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(failure[0]).isNull();
        assertThat(saved[0].getParentFile()).isEqualTo(directory);
        assertThat(saved[0].getName()).endsWith(".jpg");
        assertThat(java.nio.file.Files.readAllBytes(saved[0].toPath())).isEqualTo(jpeg);
    }

    @Test
    public void describeContainer_detectsJpegAndAvifBrands() {
        byte[] jpegHeader = {(byte) 0xFF, (byte) 0xD8, 0x00};
        assertThat(BlePhotoUploadService.describeContainer(jpegHeader)).isEqualTo("jpeg");

        byte[] avif =
                new byte[] {
                    0, 0, 0, 0,
                    'f', 't', 'y', 'p',
                    'a', 'v', 'i', 'f',
                };
        assertThat(BlePhotoUploadService.describeContainer(avif)).isEqualTo("iso_bmff/ftyp=avif");
    }

    @Test
    public void containsExifMarkerInBytes_findsExifHeader() {
        byte[] withExif = new byte[] {0, 1, 'E', 'x', 'i', 'f', 0, 0, 2};
        assertThat(BlePhotoUploadService.containsExifMarkerInBytes(withExif)).isTrue();
        assertThat(BlePhotoUploadService.containsExifMarkerInBytes(new byte[] {0, 1, 2, 3})).isFalse();
    }

    @Test
    public void readImuJsonFromBleImage_parsesTiffUserCommentInAvif() throws Exception {
        byte[] avif =
                java.nio.file.Files.readAllBytes(
                        new File("src/test/resources/avif_with_exif.avif").toPath());
        File temp = tempFolder.newFile("ble.avif");
        java.nio.file.Files.write(temp.toPath(), avif);
        String json = BlePhotoUploadService.readImuJsonFromBleImage(avif, temp.getAbsolutePath());
        assertThat(json).isNotNull();
        assertThat(new JSONObject(json).getInt("sampleCount")).isEqualTo(5);
    }

    @Test
    public void convertToJpeg_passesThroughExistingJpegWithoutReencode() throws Exception {
        File input = tempFolder.newFile("input.jpg");
        writeMinimalJpeg(input);
        byte[] inputBytes = java.nio.file.Files.readAllBytes(input.toPath());
        byte[] outputBytes = BlePhotoUploadService.convertToJpegPreservingExif(inputBytes);
        assertThat(outputBytes).isEqualTo(inputBytes);
    }

    @Test
    public void convertToJpegPreservesUserComment() throws Exception {
        File input = tempFolder.newFile("input.jpg");
        writeMinimalJpeg(input);
        JSONObject payload = new JSONObject();
        payload.put("version", 1);
        payload.put("sampleCount", 2);
        payload.put("samplingRateHz", 100);
        payload.put("startTimeNs", 1000L);
        payload.put("durationMs", 20);
        payload.put("samples", new org.json.JSONArray());
        ExifInterface inputExif = new ExifInterface(input.getAbsolutePath());
        inputExif.setAttribute(ExifInterface.TAG_USER_COMMENT, payload.toString());
        inputExif.saveAttributes();

        byte[] inputBytes = java.nio.file.Files.readAllBytes(input.toPath());
        byte[] outputBytes = BlePhotoUploadService.convertToJpegPreservingExif(inputBytes);

        File output = tempFolder.newFile("out.jpg");
        try (FileOutputStream fos = new FileOutputStream(output)) {
            fos.write(outputBytes);
        }

        ExifInterface exif = new ExifInterface(output.getAbsolutePath());
        String comment = exif.getAttribute(ExifInterface.TAG_USER_COMMENT);
        assertThat(comment).isNotNull();
        assertThat(new JSONObject(comment).getInt("sampleCount")).isEqualTo(2);
    }

    private static void writeMinimalJpeg(File dest) throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.BLACK);
        try (FileOutputStream fos = new FileOutputStream(dest)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, fos);
        } finally {
            bitmap.recycle();
        }
    }
}
