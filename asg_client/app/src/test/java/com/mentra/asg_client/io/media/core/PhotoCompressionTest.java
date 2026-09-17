package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import androidx.exifinterface.media.ExifInterface;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PhotoCompressionTest {
  @Rule public TemporaryFolder files = new TemporaryFolder();

  @Test
  public void everySpellingUsesTheSameQualityForUploadBleAndWifiFallback() throws Exception {
    // Exercise the camera's size-dependent source qualities, including a Q95 source.
    for (int captureQuality : new int[] {70, 80, 85, 95}) {
      checkTransportParity(captureQuality);
    }
  }

  private void checkTransportParity(int captureQuality) throws Exception {
    String[] spellings = {"none", "low", "medium", "high", null};
    int[] qualities = {95, 88, 78, 60, 95};
    Bitmap sensor = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888);
    for (int y = 0; y < 80; y++) {
      for (int x = 0; x < 120; x++) sensor.setPixel(x, y, 0xff000000 | x * 131071 + y * 8191);
    }
    File original = files.newFile("original-" + captureQuality + ".jpg");
    ByteArrayOutputStream capture = new ByteArrayOutputStream();
    assertTrue(sensor.compress(Bitmap.CompressFormat.JPEG, captureQuality, capture));
    sensor.recycle();
    byte[] capturedBytes = capture.toByteArray();
    Files.write(original.toPath(), capturedBytes);

    for (int i = 0; i < spellings.length; i++) {
      PhotoCompression policy = PhotoCompression.fromValue(spellings[i]);
      assertEquals(qualities[i], policy.jpegQuality);
      File upload = files.newFile("upload-" + captureQuality + "-" + i + ".jpg");
      String uploaded = policy.prepareUpload(original.getPath(), upload.getPath());
      assertEquals(upload.getPath(), uploaded);
      byte[] direct = Files.readAllBytes(upload.toPath());
      Bitmap ramCapture = BitmapFactory.decodeByteArray(capturedBytes, 0, capturedBytes.length);
      Bitmap fallbackCapture = BitmapFactory.decodeFile(original.getPath());
      try {
        // RAM-first BLE and file-backed Wi-Fi fallback use the same encoder and policy.
        byte[] ble = BlePhotoEncoders.encode(ramCapture, BleCodec.JPEG_FAST,
            policy.jpegQuality, null, null, null).data;
        byte[] fallback = BlePhotoEncoders.encode(fallbackCapture, BleCodec.JPEG_FAST,
            policy.jpegQuality, original.getPath(), null, null).data;
        assertArrayEquals(quantizationTables(direct), quantizationTables(ble));
        assertArrayEquals(quantizationTables(direct), quantizationTables(fallback));
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(direct, 0, direct.length, bounds);
        assertEquals(120, bounds.outWidth);
        assertEquals(80, bounds.outHeight);
        assertArrayEquals(capturedBytes, Files.readAllBytes(original.toPath()));
      } finally {
        ramCapture.recycle();
        fallbackCapture.recycle();
      }
    }
  }

  @Test
  public void everyUploadLevelPreservesOrientationImuAndOriginalCapture() throws Exception {
    String[] spellings = {"none", "low", "medium", "high", null};
    String imuJson = "{\"samples\":[{\"t\":1,\"x\":0.5}]}";
    String captureId = "0123456789abcdef0123456789abcdef";
    // All eight EXIF transforms, including mirrored orientations, retain their meaning
    // because prepareUpload preserves pixel geometry rather than rotating the bitmap.
    for (int orientation = 1; orientation <= 8; orientation++) {
      Bitmap sensor = Bitmap.createBitmap(40, 20, Bitmap.Config.ARGB_8888);
      File original = files.newFile("oriented-" + orientation + ".jpg");
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(original)) {
        assertTrue(sensor.compress(Bitmap.CompressFormat.JPEG, 70, out));
      }
      sensor.recycle();
      ExifInterface exif = new ExifInterface(original.getPath());
      exif.setAttribute(ExifInterface.TAG_ORIENTATION, String.valueOf(orientation));
      exif.setAttribute(ExifInterface.TAG_USER_COMMENT, imuJson);
      exif.setAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID, captureId);
      exif.saveAttributes();
      byte[] capturedBytes = Files.readAllBytes(original.toPath());

      for (int i = 0; i < spellings.length; i++) {
        File upload = files.newFile("oriented-upload-" + orientation + "-" + i + ".jpg");
        assertEquals(upload.getPath(), PhotoCompression.fromValue(spellings[i])
            .prepareUpload(original.getPath(), upload.getPath()));
        ExifInterface result = new ExifInterface(upload.getPath());
        assertEquals(orientation, result.getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED));
        assertEquals(imuJson, result.getAttribute(ExifInterface.TAG_USER_COMMENT));
        assertEquals(captureId, result.getAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID));
        assertArrayEquals(capturedBytes, Files.readAllBytes(original.toPath()));
      }
    }
  }

  @Test
  public void onlyOmissionDefaultsAndInvalidValuesFail() {
    assertSame(PhotoCompression.NONE, PhotoCompression.fromValue(null));
    for (Object invalid : new Object[] {"heavy", "", "unknown", "HIGH", 42, false, org.json.JSONObject.NULL}) {
      assertThrows(IllegalArgumentException.class, () -> PhotoCompression.fromValue(invalid));
    }
  }

  // Compare JPEG quality independently of transport-specific EXIF metadata.
  private static byte[] quantizationTables(byte[] jpeg) {
    ByteArrayOutputStream tables = new ByteArrayOutputStream();
    for (int offset = 2; offset + 4 <= jpeg.length; ) {
      int marker = jpeg[offset + 1] & 0xff;
      if (marker == 0xda || marker == 0xd9) break;
      int length = ((jpeg[offset + 2] & 0xff) << 8) | (jpeg[offset + 3] & 0xff);
      if (marker == 0xdb) tables.write(jpeg, offset + 4, length - 2);
      offset += length + 2;
    }
    assertTrue("JPEG must contain quantization tables", tables.size() > 0);
    return tables.toByteArray();
  }
}
